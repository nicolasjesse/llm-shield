import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  STREAM_TTFB_THRESHOLD_MS,
  STREAM_EARLY_DROP_MS,
  classifyStreamOutcome,
  checkCircuitOrReject,
  recordStreamOutcome,
  type StreamOutcome,
} from '../src/stream-circuit-breaker';

vi.mock('../src/circuit-breaker', () => ({
  getState: vi.fn(),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}));

import { getState, recordSuccess, recordFailure } from '../src/circuit-breaker';

describe('classifyStreamOutcome', () => {
  it('returns success on normal completion', () => {
    const o: StreamOutcome = { terminationReason: 'done', ttfbMs: 100, firstByteAtMs: 100, droppedAtMs: null };
    expect(classifyStreamOutcome(o)).toBe('success');
  });

  it('returns failure when upstream fetch threw before any byte', () => {
    const o: StreamOutcome = { terminationReason: 'connection_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
    expect(classifyStreamOutcome(o)).toBe('failure');
  });

  it('returns failure when upstream returned non-2xx before body', () => {
    const o: StreamOutcome = { terminationReason: 'http_error', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
    expect(classifyStreamOutcome(o)).toBe('failure');
  });

  it('returns failure when TTFB exceeded threshold', () => {
    const o: StreamOutcome = { terminationReason: 'ttfb_timeout', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null };
    expect(classifyStreamOutcome(o)).toBe('failure');
  });

  it('returns failure when dropped within early window', () => {
    const o: StreamOutcome = {
      terminationReason: 'upstream_drop',
      ttfbMs: 50,
      firstByteAtMs: 50,
      droppedAtMs: 50 + (STREAM_EARLY_DROP_MS - 100),
    };
    expect(classifyStreamOutcome(o)).toBe('failure');
  });

  it('returns ignore when dropped after early window', () => {
    const o: StreamOutcome = {
      terminationReason: 'upstream_drop',
      ttfbMs: 50,
      firstByteAtMs: 50,
      droppedAtMs: 50 + STREAM_EARLY_DROP_MS + 100,
    };
    expect(classifyStreamOutcome(o)).toBe('ignore');
  });

  it('returns ignore when client disconnected', () => {
    const o: StreamOutcome = {
      terminationReason: 'client_disconnect',
      ttfbMs: 100,
      firstByteAtMs: 100,
      droppedAtMs: 5000,
    };
    expect(classifyStreamOutcome(o)).toBe('ignore');
  });

  it('returns ignore when circuit was open (never reached upstream)', () => {
    const o: StreamOutcome = {
      terminationReason: 'circuit_open',
      ttfbMs: null,
      firstByteAtMs: null,
      droppedAtMs: null,
    };
    expect(classifyStreamOutcome(o)).toBe('ignore');
  });
});

describe('checkCircuitOrReject', () => {
  let res: any;
  beforeEach(() => {
    vi.clearAllMocks();
    res = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };
  });

  it('returns true when circuit is CLOSED', async () => {
    vi.mocked(getState).mockResolvedValue('CLOSED');
    expect(await checkCircuitOrReject(res)).toBe(true);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('returns true when circuit is HALF_OPEN (treated like CLOSED for streams)', async () => {
    vi.mocked(getState).mockResolvedValue('HALF_OPEN');
    expect(await checkCircuitOrReject(res)).toBe(true);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('writes 503 and returns false when OPEN', async () => {
    vi.mocked(getState).mockResolvedValue('OPEN');
    expect(await checkCircuitOrReject(res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/json');
    expect(res.end).toHaveBeenCalledOnce();
    const body = JSON.parse((res.end as any).mock.calls[0][0]);
    expect(body.code).toBe('circuit_open');
  });
});

describe('recordStreamOutcome', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls recordSuccess on success outcome', async () => {
    await recordStreamOutcome({ terminationReason: 'done', ttfbMs: 100, firstByteAtMs: 100, droppedAtMs: null });
    expect(recordSuccess).toHaveBeenCalledOnce();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('calls recordFailure on failure outcome', async () => {
    await recordStreamOutcome({ terminationReason: 'ttfb_timeout', ttfbMs: null, firstByteAtMs: null, droppedAtMs: null });
    expect(recordFailure).toHaveBeenCalledOnce();
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it('calls neither on ignore outcome', async () => {
    await recordStreamOutcome({ terminationReason: 'client_disconnect', ttfbMs: 100, firstByteAtMs: 100, droppedAtMs: 5000 });
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });
});
