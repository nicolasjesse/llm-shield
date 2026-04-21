import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isStreamingRequest, proxyStreamRequest, proxyStreamRequestRecording } from '../src/stream';
import { PassThrough } from 'node:stream';
import { recordStreamOutcome, checkCircuitOrReject } from '../src/stream-circuit-breaker';

vi.mock('../src/stream-circuit-breaker', async (orig) => {
  const actual = await orig<typeof import('../src/stream-circuit-breaker')>();
  return {
    ...actual,
    checkCircuitOrReject: vi.fn(async () => true),
    recordStreamOutcome: vi.fn(async () => {}),
  };
});

describe('isStreamingRequest', () => {
  it('returns true when Accept header includes text/event-stream', () => {
    const req = { headers: { accept: 'text/event-stream' } } as any;
    expect(isStreamingRequest(req, {})).toBe(true);
  });

  it('returns true when body.stream === true', () => {
    const req = { headers: {} } as any;
    expect(isStreamingRequest(req, { stream: true })).toBe(true);
  });

  it('returns false for a plain JSON chat request', () => {
    const req = { headers: { accept: 'application/json' } } as any;
    expect(isStreamingRequest(req, { model: 'gpt-4', messages: [] })).toBe(false);
  });

  it('returns false when body is undefined and no streaming header', () => {
    const req = { headers: {} } as any;
    expect(isStreamingRequest(req, undefined)).toBe(false);
  });

  it('handles Accept with multiple media types', () => {
    const req = { headers: { accept: 'application/json, text/event-stream' } } as any;
    expect(isStreamingRequest(req, {})).toBe(true);
  });
});

describe('proxyStreamRequest', () => {
  it('pipes upstream SSE body byte-for-byte to the response', async () => {
    const upstreamBody = 'data: {"delta":"hel"}\n\ndata: {"delta":"lo"}\n\ndata: [DONE]\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const chunks: Buffer[] = [];
    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnValue(res);
    res.flushHeaders = vi.fn();
    res.on('data', (c: Buffer) => chunks.push(c));

    await proxyStreamRequest(
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    const got = Buffer.concat(chunks).toString('utf8');
    expect(got).toBe(upstreamBody);
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'text/event-stream');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('propagates non-2xx status with JSON error body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"nope"}', {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const chunks: Buffer[] = [];
    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnValue(res);
    res.flushHeaders = vi.fn();
    res.on('data', (c: Buffer) => chunks.push(c));

    await proxyStreamRequest(
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    expect(res.status).toHaveBeenCalledWith(502);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('{"error":"nope"}');
  });
});

describe('proxyStreamRequestRecording', () => {
  it('forwards to res AND invokes onChunk for each chunk, then onEnd(true, …)', async () => {
    const body = 'data: a\n\ndata: b\n\ndata: [DONE]\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const chunks: string[] = [];
    const recorded: Buffer[] = [];
    let endResult: { ok: boolean; status: number; contentType: string } | null = null;

    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnValue(res);
    res.flushHeaders = vi.fn();
    res.on = res.on.bind(res);
    res.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));

    await proxyStreamRequestRecording(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      (buf) => { recorded.push(buf); },
      (ok, status, ct) => { endResult = { ok, status, contentType: ct }; },
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    expect(chunks.join('')).toBe(body);
    expect(Buffer.concat(recorded).toString('utf8')).toBe(body);
    expect(endResult).toEqual({ ok: true, status: 200, contentType: 'text/event-stream' });
  });

  it('keeps invoking onChunk after client disconnects but stops res.write', async () => {
    const encoder = new TextEncoder();
    let release: (() => void) | null = null;
    const upstreamStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: 1\n\n'));
        await new Promise<void>((resolve) => { release = resolve; });
        controller.enqueue(encoder.encode('data: 2\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(upstreamStream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );

    const recorded: Buffer[] = [];
    const written: Buffer[] = [];
    const listeners: Record<string, (() => void)[]> = {};
    const res: any = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      flushHeaders: vi.fn(),
      write: (c: Buffer) => { written.push(c); return true; },
      end: vi.fn(),
      on: (evt: string, cb: () => void) => {
        (listeners[evt] ??= []).push(cb);
      },
    };

    const promise = proxyStreamRequestRecording(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      (b) => recorded.push(b),
      () => {},
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    await new Promise((r) => setTimeout(r, 20));
    listeners['close']?.forEach((cb) => cb());
    release?.();
    await promise;

    expect(Buffer.concat(recorded).toString('utf8')).toBe('data: 1\n\ndata: 2\n\n');
    expect(Buffer.concat(written).toString('utf8')).toBe('data: 1\n\n');
  });
});

describe('proxyStreamRequest + circuit breaker', () => {
  beforeEach(() => {
    vi.mocked(checkCircuitOrReject).mockReset().mockResolvedValue(true);
    vi.mocked(recordStreamOutcome).mockReset().mockResolvedValue(undefined);
  });

  it('rejects early when circuit is OPEN (no fetch invoked)', async () => {
    vi.mocked(checkCircuitOrReject).mockResolvedValue(false);
    const fetchMock = vi.fn();
    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnThis();
    res.flushHeaders = vi.fn();

    await proxyStreamRequest(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordStreamOutcome).not.toHaveBeenCalled();
  });

  it('records success when stream completes normally', async () => {
    const body = 'data: a\n\ndata: [DONE]\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnThis();
    res.flushHeaders = vi.fn();

    await proxyStreamRequest(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    expect(recordStreamOutcome).toHaveBeenCalledOnce();
    const outcome = vi.mocked(recordStreamOutcome).mock.calls[0][0];
    expect(outcome.terminationReason).toBe('done');
  });

  it('records failure when upstream fetch throws (connection error)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnThis();
    res.flushHeaders = vi.fn();

    await proxyStreamRequest(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    expect(recordStreamOutcome).toHaveBeenCalledOnce();
    const outcome = vi.mocked(recordStreamOutcome).mock.calls[0][0];
    expect(outcome.terminationReason).toBe('connection_error');
  });

  it('records failure when upstream returns 500 (http_error)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"oops"}', { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnThis();
    res.flushHeaders = vi.fn();

    await proxyStreamRequest(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    const outcome = vi.mocked(recordStreamOutcome).mock.calls[0][0];
    expect(outcome.terminationReason).toBe('http_error');
  });
});

describe('proxyStreamRequestRecording + circuit breaker', () => {
  beforeEach(() => {
    vi.mocked(checkCircuitOrReject).mockReset().mockResolvedValue(true);
    vi.mocked(recordStreamOutcome).mockReset().mockResolvedValue(undefined);
  });

  it('rejects early when OPEN and does not fetch or invoke callbacks', async () => {
    vi.mocked(checkCircuitOrReject).mockResolvedValue(false);
    const fetchMock = vi.fn();
    const onChunk = vi.fn();
    const onEnd = vi.fn();
    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnThis();
    res.flushHeaders = vi.fn();
    res.on = res.on.bind(res);

    await proxyStreamRequestRecording(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      onChunk,
      onEnd,
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onChunk).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(recordStreamOutcome).not.toHaveBeenCalled();
  });

  it('records success on normal completion', async () => {
    const body = 'data: a\n\ndata: [DONE]\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const onChunk = vi.fn();
    const onEnd = vi.fn();
    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnThis();
    res.flushHeaders = vi.fn();
    res.on = res.on.bind(res);

    await proxyStreamRequestRecording(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      onChunk,
      onEnd,
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    expect(recordStreamOutcome).toHaveBeenCalledOnce();
    const outcome = vi.mocked(recordStreamOutcome).mock.calls[0][0];
    expect(outcome.terminationReason).toBe('done');
    expect(onEnd).toHaveBeenCalledWith(true, 200, 'text/event-stream');
  });

  it('records connection_error when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const onChunk = vi.fn();
    const onEnd = vi.fn();
    const res = new PassThrough() as any;
    res.setHeader = vi.fn();
    res.status = vi.fn().mockReturnThis();
    res.flushHeaders = vi.fn();
    res.on = res.on.bind(res);

    await proxyStreamRequestRecording(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res,
      onChunk,
      onEnd,
      { fetchImpl: fetchMock, upstreamUrl: 'http://fake', apiKey: 'k' },
    );

    const outcome = vi.mocked(recordStreamOutcome).mock.calls[0][0];
    expect(outcome.terminationReason).toBe('connection_error');
    // onEnd is still called with ok=false so the idempotency layer can mark failed
    expect(onEnd).toHaveBeenCalledWith(false, 502, 'application/json');
  });
});
