import type { Request, Response as ExpressResponse } from 'express';
import { logger } from './logger';
import { checkCircuitOrReject, recordStreamOutcome, type StreamOutcome } from './stream-circuit-breaker';
import { defaultRetryDelayMs } from './retry';

export const STREAM_RETRY_MAX_ATTEMPTS = 3;

export function isStreamingRequest(req: Request, body: unknown): boolean {
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.includes('text/event-stream')) {
    return true;
  }
  if (body && typeof body === 'object' && (body as { stream?: unknown }).stream === true) {
    return true;
  }
  return false;
}

export interface StreamProxyOptions {
  fetchImpl?: typeof fetch;
  upstreamUrl?: string;
  apiKey?: string;
  retryCtx?: { isFinalAttempt: boolean };
}

export async function proxyStreamRequest(
  body: { model: string; messages: unknown[]; stream?: boolean; [k: string]: unknown },
  res: ExpressResponse,
  opts: StreamProxyOptions = {},
): Promise<StreamOutcome> {
  if (!(await checkCircuitOrReject(res))) {
    return { terminationReason: 'circuit_open', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const upstreamUrl = opts.upstreamUrl ?? process.env.LLM_UPSTREAM_URL ?? 'https://api.openai.com/v1/chat/completions';
  const apiKey = opts.apiKey ?? process.env.LLM_API_KEY ?? '';
  const isFinalAttempt = opts.retryCtx?.isFinalAttempt ?? true;

  const upstreamBody = { ...body, stream: true };
  const startedAt = Date.now();
  let firstByteAtMs: number | null = null;

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    logger.error({ err, upstream_url: upstreamUrl }, 'stream upstream connection failed');
    const outcome: StreamOutcome = { terminationReason: 'connection_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
    await recordStreamOutcome(outcome);
    if (isFinalAttempt) {
      res.status(502).setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'upstream connection failed', code: 'upstream_error' }));
    }
    return outcome;
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  res.setHeader('content-type', contentType);
  res.status(upstream.status);
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as { flushHeaders: () => void }).flushHeaders();
  }

  if (upstream.status >= 400) {
    await recordStreamOutcome({ terminationReason: 'http_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null });
    // still forward the upstream error body to the client (existing behavior)
  }

  if (!upstream.body) {
    if (upstream.status < 400) {
      const outcome: StreamOutcome = { terminationReason: 'done', ttfbMs: firstByteAtMs, firstByteAtMs, droppedAtMs: null };
      await recordStreamOutcome(outcome);
      res.end();
      return outcome;
    }
    res.end();
    return { terminationReason: 'http_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteAtMs === null) firstByteAtMs = Date.now() - startedAt;
      res.write(Buffer.from(value));
    }
    if (upstream.status < 400) {
      const outcome: StreamOutcome = { terminationReason: 'done', ttfbMs: firstByteAtMs, firstByteAtMs, droppedAtMs: null };
      await recordStreamOutcome(outcome);
      res.end();
      return outcome;
    }
    res.end();
    return { terminationReason: 'http_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
  } catch (err) {
    const droppedAtMs = Date.now() - startedAt;
    logger.error({ err, upstream_url: upstreamUrl }, 'stream forwarding interrupted');
    const outcome: StreamOutcome = { terminationReason: 'upstream_drop', ttfbMs: firstByteAtMs, firstByteAtMs, droppedAtMs };
    await recordStreamOutcome(outcome);
    res.end();
    return outcome;
  }
}

export type RecordChunkFn = (chunk: Buffer) => void;
export type RecordEndFn = (ok: boolean, status: number, contentType: string) => void;

export async function proxyStreamRequestRecording(
  body: { model: string; messages: unknown[]; stream?: boolean; [k: string]: unknown },
  res: ExpressResponse,
  onChunk: RecordChunkFn,
  onEnd: RecordEndFn,
  opts: StreamProxyOptions = {},
): Promise<StreamOutcome> {
  if (!(await checkCircuitOrReject(res))) {
    return { terminationReason: 'circuit_open', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const upstreamUrl = opts.upstreamUrl ?? process.env.LLM_UPSTREAM_URL ?? 'https://api.openai.com/v1/chat/completions';
  const apiKey = opts.apiKey ?? process.env.LLM_API_KEY ?? '';
  const isFinalAttempt = opts.retryCtx?.isFinalAttempt ?? true;

  const upstreamBody = { ...body, stream: true };
  const startedAt = Date.now();
  let firstByteAtMs: number | null = null;

  let clientAlive = true;
  if (typeof (res as { on?: Function }).on === 'function') {
    (res as { on: (ev: string, cb: () => void) => void }).on('close', () => {
      clientAlive = false;
    });
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    logger.error({ err, upstream_url: upstreamUrl }, 'stream upstream connection failed');
    const outcome: StreamOutcome = { terminationReason: 'connection_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
    await recordStreamOutcome(outcome);
    if (isFinalAttempt) {
      const ct = 'application/json';
      const errBody = Buffer.from(JSON.stringify({ error: 'upstream connection failed', code: 'upstream_error' }));
      onChunk(errBody);
      onEnd(false, 502, ct);
      if (clientAlive) {
        res.status(502).setHeader('content-type', ct);
        res.end(errBody);
      }
    }
    return outcome;
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  if (clientAlive) {
    res.setHeader('content-type', contentType);
    res.status(upstream.status);
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as { flushHeaders: () => void }).flushHeaders();
    }
  }

  if (upstream.status >= 400) {
    await recordStreamOutcome({ terminationReason: 'http_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null });
  }

  if (!upstream.body) {
    if (upstream.status < 400) {
      const outcome: StreamOutcome = { terminationReason: 'done', ttfbMs: firstByteAtMs, firstByteAtMs, droppedAtMs: null };
      await recordStreamOutcome(outcome);
      onEnd(true, upstream.status, contentType);
      if (clientAlive) res.end();
      return outcome;
    }
    onEnd(false, upstream.status, contentType);
    if (clientAlive) res.end();
    return { terminationReason: 'http_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteAtMs === null) firstByteAtMs = Date.now() - startedAt;
      const buf = Buffer.from(value);
      onChunk(buf);
      if (clientAlive) {
        try {
          res.write(buf);
        } catch {
          clientAlive = false;
        }
      }
    }
    if (upstream.status < 400) {
      const outcome: StreamOutcome = { terminationReason: 'done', ttfbMs: firstByteAtMs, firstByteAtMs, droppedAtMs: null };
      await recordStreamOutcome(outcome);
      onEnd(true, upstream.status, contentType);
      if (clientAlive) res.end();
      return outcome;
    }
    onEnd(true, upstream.status, contentType);
    if (clientAlive) res.end();
    return { terminationReason: 'http_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
  } catch (err) {
    const droppedAtMs = Date.now() - startedAt;
    logger.error({ err, upstream_url: upstreamUrl }, 'stream recording interrupted');
    const outcome: StreamOutcome = { terminationReason: 'upstream_drop', ttfbMs: firstByteAtMs, firstByteAtMs, droppedAtMs };
    await recordStreamOutcome(outcome);
    onEnd(false, upstream.status || 502, contentType);
    if (clientAlive) res.end();
    return outcome;
  }
}

// Streaming retry: only connection_error is retryable. Once upstream responds,
// headers are flushed and the response is committed to the client, so no later
// outcome (http_error, upstream_drop, success) can be retried. Non-final attempts
// run with isFinalAttempt:false so the proxy suppresses the client-facing error
// and defers recording finalization until the last try.
export async function withStreamRetry(
  attempt: (ctx: { isFinalAttempt: boolean }) => Promise<StreamOutcome>,
  delayMs: (n: number) => number = defaultRetryDelayMs,
  maxAttempts: number = STREAM_RETRY_MAX_ATTEMPTS,
): Promise<StreamOutcome> {
  let outcome: StreamOutcome | undefined;
  for (let n = 0; n < maxAttempts; n++) {
    const isFinalAttempt = n === maxAttempts - 1;
    outcome = await attempt({ isFinalAttempt });
    if (outcome.terminationReason !== 'connection_error' || isFinalAttempt) {
      return outcome;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs(n)));
  }
  return outcome as StreamOutcome;
}
