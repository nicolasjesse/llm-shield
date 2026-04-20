import type { Request, Response as ExpressResponse } from 'express';
import { logger } from './logger';

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
}

export async function proxyStreamRequest(
  body: { model: string; messages: unknown[]; stream?: boolean; [k: string]: unknown },
  res: ExpressResponse,
  opts: StreamProxyOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const upstreamUrl = opts.upstreamUrl ?? process.env.LLM_UPSTREAM_URL ?? 'https://api.openai.com/v1/chat/completions';
  const apiKey = opts.apiKey ?? process.env.LLM_API_KEY ?? '';

  const upstreamBody = { ...body, stream: true };

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
    res.status(502).setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'upstream connection failed', code: 'upstream_error' }));
    return;
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  res.setHeader('content-type', contentType);
  res.status(upstream.status);
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as { flushHeaders: () => void }).flushHeaders();
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    logger.error({ err, upstream_url: upstreamUrl }, 'stream forwarding interrupted');
    res.end();
  }
}
