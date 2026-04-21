import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  keyMeta,
  keyChunks,
  SENTINEL_END,
  SENTINEL_ERR,
  META_TTL_INFLIGHT,
  META_TTL_DONE,
  claimKey,
  readMeta,
  markDone,
  markFailed,
  streamIdempotencyMiddleware,
} from '../src/stream-idempotency';

vi.mock('../src/redis', () => ({
  getRedis: vi.fn(),
}));

vi.mock('../src/stream', () => ({
  isStreamingRequest: vi.fn((_req: unknown, body: unknown) => {
    return !!(body && typeof body === 'object' && (body as any).stream === true);
  }),
  proxyStreamRequest: vi.fn(),
  proxyStreamRequestRecording: vi.fn(),
}));

vi.mock('../src/stream-circuit-breaker', async (importOrig) => {
  const orig = await importOrig<typeof import('../src/stream-circuit-breaker')>();
  return {
    ...orig,
    checkCircuitOrReject: vi.fn().mockResolvedValue(true),
  };
});

import { getRedis } from '../src/redis';
import { checkCircuitOrReject } from '../src/stream-circuit-breaker';
import { Readable } from 'node:stream';

describe('stream-idempotency helpers', () => {
  let mockRedis: any;
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      set: vi.fn(),
      get: vi.fn(),
      expire: vi.fn(),
      rpush: vi.fn(),
    };
    vi.mocked(getRedis).mockReturnValue(mockRedis);
  });

  it('builds the expected key names', () => {
    expect(keyMeta('abc')).toBe('stream-idem:abc:meta');
    expect(keyChunks('abc')).toBe('stream-idem:abc:chunks');
  });

  it('exports the sentinels and TTLs', () => {
    expect(SENTINEL_END).toBe('__END__');
    expect(SENTINEL_ERR).toBe('__ERR__');
    expect(META_TTL_INFLIGHT).toBe(300);
    expect(META_TTL_DONE).toBe(86400);
  });

  it('claimKey writes meta with NX and returns true on success', async () => {
    mockRedis.set.mockResolvedValue('OK');
    const ok = await claimKey('abc');
    expect(ok).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'stream-idem:abc:meta',
      JSON.stringify({ state: 'in_flight' }),
      'EX',
      300,
      'NX',
    );
  });

  it('claimKey returns false when key already claimed', async () => {
    mockRedis.set.mockResolvedValue(null);
    expect(await claimKey('abc')).toBe(false);
  });

  it('readMeta parses stored JSON', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ state: 'done', status: 200, contentType: 'text/event-stream' }));
    expect(await readMeta('abc')).toEqual({ state: 'done', status: 200, contentType: 'text/event-stream' });
  });

  it('readMeta returns null when missing', async () => {
    mockRedis.get.mockResolvedValue(null);
    expect(await readMeta('abc')).toBeNull();
  });

  it('markDone writes state=done with 24h TTL and bumps chunks TTL', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.expire.mockResolvedValue(1);
    await markDone('abc', 200, 'text/event-stream');
    expect(mockRedis.set).toHaveBeenCalledWith(
      'stream-idem:abc:meta',
      JSON.stringify({ state: 'done', status: 200, contentType: 'text/event-stream' }),
      'EX',
      86400,
    );
    expect(mockRedis.expire).toHaveBeenCalledWith('stream-idem:abc:chunks', 86400);
  });

  it('markFailed writes state=failed with short TTL', async () => {
    mockRedis.set.mockResolvedValue('OK');
    await markFailed('abc', 502, 'application/json');
    expect(mockRedis.set).toHaveBeenCalledWith(
      'stream-idem:abc:meta',
      JSON.stringify({ state: 'failed', status: 502, contentType: 'application/json' }),
      'EX',
      300,
    );
  });
});

describe('streamIdempotencyMiddleware', () => {
  let mockRedis: any;
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      set: vi.fn(),
      get: vi.fn(),
      rpush: vi.fn(),
      lrange: vi.fn(),
      llen: vi.fn(),
      lindex: vi.fn(),
      expire: vi.fn(),
    };
    vi.mocked(getRedis).mockReturnValue(mockRedis);
  });

  function makeReq(opts: { key?: string; accept?: string; body?: any } = {}) {
    return {
      headers: {
        ...(opts.key ? { 'idempotency-key': opts.key } : {}),
        ...(opts.accept ? { accept: opts.accept } : {}),
      },
      body: opts.body ?? { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
    } as any;
  }

  function makeRes() {
    const chunks: Buffer[] = [];
    const res: any = new Readable({ read() {} });
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnValue(res);
    res.write = (c: Buffer) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true; };
    res.end = vi.fn((c?: Buffer) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
    res._captured = chunks;
    return res;
  }

  it('passes through when request is not streaming', async () => {
    const mw = streamIdempotencyMiddleware();
    const next = vi.fn();
    await mw(makeReq({ key: 'k', body: { model: 'm', messages: [] } }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('passes through when no idempotency key', async () => {
    const mw = streamIdempotencyMiddleware();
    const next = vi.fn();
    await mw(makeReq({ accept: 'text/event-stream' }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('claims + calls next and marks req.streamIdempotency on first hit', async () => {
    mockRedis.set.mockResolvedValue('OK');
    const mw = streamIdempotencyMiddleware();
    const req = makeReq({ key: 'k1', accept: 'text/event-stream' });
    const next = vi.fn();
    await mw(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.streamIdempotency).toEqual({ key: 'k1', claimed: true });
  });

  it('replays a completed log with the cached content-type and status', async () => {
    mockRedis.set.mockResolvedValue(null);
    mockRedis.get.mockResolvedValue(JSON.stringify({ state: 'done', status: 200, contentType: 'text/event-stream' }));
    mockRedis.lrange.mockResolvedValue([
      Buffer.from('data: a\n\n').toString('base64'),
      Buffer.from('data: b\n\n').toString('base64'),
      '__END__',
    ]);
    const mw = streamIdempotencyMiddleware();
    const res = makeRes();
    const next = vi.fn();
    await mw(makeReq({ key: 'k2', accept: 'text/event-stream' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'text/event-stream');
    expect(Buffer.concat(res._captured).toString('utf8')).toBe('data: a\n\ndata: b\n\n');
    expect(res.end).toHaveBeenCalled();
  });

  it('returns 502 when cached state is failed', async () => {
    mockRedis.set.mockResolvedValue(null);
    mockRedis.get.mockResolvedValue(JSON.stringify({ state: 'failed', status: 502, contentType: 'application/json' }));
    const mw = streamIdempotencyMiddleware();
    const res = makeRes();
    const next = vi.fn();
    await mw(makeReq({ key: 'k3', accept: 'text/event-stream' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.end).toHaveBeenCalled();
  });

  it('tails an in-flight log: reads new entries until __END__', async () => {
    mockRedis.set.mockResolvedValue(null);
    mockRedis.get
      .mockResolvedValueOnce(JSON.stringify({ state: 'in_flight' }))
      .mockResolvedValueOnce(JSON.stringify({ state: 'in_flight' }))
      .mockResolvedValue(JSON.stringify({ state: 'done', status: 200, contentType: 'text/event-stream' }));

    mockRedis.llen
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);

    mockRedis.lindex
      .mockResolvedValueOnce(Buffer.from('data: a\n\n').toString('base64'))
      .mockResolvedValueOnce(Buffer.from('data: b\n\n').toString('base64'))
      .mockResolvedValueOnce('__END__');

    const mw = streamIdempotencyMiddleware({ pollIntervalMs: 5, tailTimeoutMs: 1000 });
    const res = makeRes();
    const next = vi.fn();
    await mw(makeReq({ key: 'k4', accept: 'text/event-stream' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(Buffer.concat(res._captured).toString('utf8')).toBe('data: a\n\ndata: b\n\n');
  });

  it('rejects before claiming when circuit breaker is OPEN (checkCircuitOrReject returns false)', async () => {
    vi.mocked(checkCircuitOrReject).mockResolvedValueOnce(false);
    const mw = streamIdempotencyMiddleware();
    const res = makeRes();
    const next = vi.fn();
    await mw(makeReq({ key: 'k5', accept: 'text/event-stream' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});
