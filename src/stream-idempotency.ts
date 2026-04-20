import { getRedis } from './redis';
import type { Request, Response, NextFunction } from 'express';

export const SENTINEL_END = '__END__';
export const SENTINEL_ERR = '__ERR__';
export const META_TTL_INFLIGHT = 300;
export const META_TTL_DONE = 86400;

export type StreamMetaState = 'in_flight' | 'done' | 'failed';

export interface StreamMeta {
  state: StreamMetaState;
  status?: number;
  contentType?: string;
}

export function keyMeta(key: string): string {
  return `stream-idem:${key}:meta`;
}

export function keyChunks(key: string): string {
  return `stream-idem:${key}:chunks`;
}

export async function claimKey(key: string): Promise<boolean> {
  const redis = getRedis();
  const res = await redis.set(
    keyMeta(key),
    JSON.stringify({ state: 'in_flight' } as StreamMeta),
    'EX',
    META_TTL_INFLIGHT,
    'NX',
  );
  return res === 'OK';
}

export async function readMeta(key: string): Promise<StreamMeta | null> {
  const redis = getRedis();
  const raw = await redis.get(keyMeta(key));
  if (!raw) return null;
  return JSON.parse(raw) as StreamMeta;
}

export async function markDone(key: string, status: number, contentType: string): Promise<void> {
  const redis = getRedis();
  await redis.set(
    keyMeta(key),
    JSON.stringify({ state: 'done', status, contentType } as StreamMeta),
    'EX',
    META_TTL_DONE,
  );
  await redis.expire(keyChunks(key), META_TTL_DONE);
}

export async function markFailed(key: string, status: number, contentType: string): Promise<void> {
  const redis = getRedis();
  await redis.set(
    keyMeta(key),
    JSON.stringify({ state: 'failed', status, contentType } as StreamMeta),
    'EX',
    META_TTL_INFLIGHT,
  );
}

// ── Middleware ──────────────────────────────────────────────────────────────

import { isStreamingRequest } from './stream';
import { logger } from './logger';

export interface StreamIdempotencyOptions {
  pollIntervalMs?: number;
  tailTimeoutMs?: number;
}

export interface ClaimInfo {
  key: string;
  claimed: true;
}

export function streamIdempotencyMiddleware(opts: StreamIdempotencyOptions = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const tailTimeoutMs = opts.tailTimeoutMs ?? 60_000;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) { next(); return; }
    if (!isStreamingRequest(req, req.body)) { next(); return; }

    const claimed = await claimKey(key);
    if (claimed) {
      (req as Request & { streamIdempotency?: ClaimInfo }).streamIdempotency = { key, claimed: true };
      next();
      return;
    }

    const meta = await readMeta(key);
    if (!meta) {
      logger.warn({ key, component: 'stream-idem' }, 'claim lost but meta missing, falling back to next()');
      next();
      return;
    }

    if (meta.state === 'done') {
      await replayCompleted(res, key, meta);
      return;
    }
    if (meta.state === 'failed') {
      res.status(meta.status ?? 502).setHeader('content-type', meta.contentType ?? 'application/json');
      res.end(JSON.stringify({ error: 'cached upstream failure', code: 'upstream_error' }));
      return;
    }
    await tailInFlight(res, key, pollIntervalMs, tailTimeoutMs);
  };
}

async function replayCompleted(res: Response, key: string, meta: StreamMeta): Promise<void> {
  const redis = getRedis();
  const entries = await redis.lrange(keyChunks(key), 0, -1);
  res.status(meta.status ?? 200).setHeader('content-type', meta.contentType ?? 'text/event-stream');
  for (const entry of entries) {
    if (entry === SENTINEL_END || entry === SENTINEL_ERR) break;
    res.write(Buffer.from(entry, 'base64'));
  }
  res.end();
}

async function tailInFlight(res: Response, key: string, pollIntervalMs: number, tailTimeoutMs: number): Promise<void> {
  const redis = getRedis();
  const chunksK = keyChunks(key);
  const deadline = Date.now() + tailTimeoutMs;
  let index = 0;
  let headersSent = false;

  while (Date.now() < deadline) {
    const len = await redis.llen(chunksK);
    while (index < len) {
      const entry = await redis.lindex(chunksK, index);
      index++;
      if (entry === null) break;
      if (entry === SENTINEL_END) {
        if (!headersSent) await sendTailHeaders(res, key);
        res.end();
        return;
      }
      if (entry === SENTINEL_ERR) {
        if (!headersSent) res.status(502).setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'upstream stream failed', code: 'upstream_error' }));
        return;
      }
      if (!headersSent) {
        await sendTailHeaders(res, key);
        headersSent = true;
      }
      res.write(Buffer.from(entry, 'base64'));
    }
    const meta = await readMeta(key);
    if (meta && meta.state === 'done') {
      const finalLen = await redis.llen(chunksK);
      while (index < finalLen) {
        const entry = await redis.lindex(chunksK, index);
        index++;
        if (entry === null || entry === SENTINEL_END || entry === SENTINEL_ERR) break;
        if (!headersSent) { await sendTailHeaders(res, key); headersSent = true; }
        res.write(Buffer.from(entry, 'base64'));
      }
      if (!headersSent) await sendTailHeaders(res, key);
      res.end();
      return;
    }
    if (meta && meta.state === 'failed') {
      if (!headersSent) res.status(meta.status ?? 502).setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'upstream stream failed', code: 'upstream_error' }));
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!headersSent) res.status(504).setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'timed out tailing in-flight stream', code: 'upstream_error' }));
}

async function sendTailHeaders(res: Response, key: string): Promise<void> {
  const meta = await readMeta(key);
  res.status(meta?.status ?? 200).setHeader('content-type', meta?.contentType ?? 'text/event-stream');
}
