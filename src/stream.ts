import type { Request } from 'express';

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
