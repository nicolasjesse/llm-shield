import { Response } from 'express';
import { getState, recordSuccess, recordFailure } from './circuit-breaker';

export const STREAM_TTFB_THRESHOLD_MS = Number(process.env.STREAM_TTFB_THRESHOLD_MS ?? '8000');
export const STREAM_EARLY_DROP_MS = Number(process.env.STREAM_EARLY_DROP_MS ?? '500');

export type StreamTerminationReason =
  | 'done'
  | 'connection_error'
  | 'http_error'
  | 'ttfb_timeout'
  | 'upstream_drop'
  | 'client_disconnect';

export interface StreamOutcome {
  terminationReason: StreamTerminationReason;
  ttfbMs: number | null;
  firstByteAtMs: number | null;
  droppedAtMs: number | null;
}

export type StreamOutcomeClass = 'success' | 'failure' | 'ignore';

export function classifyStreamOutcome(o: StreamOutcome): StreamOutcomeClass {
  switch (o.terminationReason) {
    case 'done':
      return 'success';
    case 'connection_error':
    case 'http_error':
    case 'ttfb_timeout':
      return 'failure';
    case 'upstream_drop': {
      if (o.firstByteAtMs === null || o.droppedAtMs === null) return 'failure';
      const lived = o.droppedAtMs - o.firstByteAtMs;
      return lived < STREAM_EARLY_DROP_MS ? 'failure' : 'ignore';
    }
    case 'client_disconnect':
      return 'ignore';
  }
}

export async function checkCircuitOrReject(res: Response): Promise<boolean> {
  const state = await getState();
  if (state === 'OPEN') {
    res.status(503).setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Circuit breaker is OPEN', code: 'circuit_open' }));
    return false;
  }
  return true;
}

export async function recordStreamOutcome(o: StreamOutcome): Promise<void> {
  const cls = classifyStreamOutcome(o);
  if (cls === 'success') await recordSuccess();
  else if (cls === 'failure') await recordFailure();
}
