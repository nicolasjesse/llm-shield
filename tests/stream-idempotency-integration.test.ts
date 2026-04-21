import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

describe('end-to-end: two concurrent streaming requests with same idempotency key', () => {
  it('second caller tails the first and receives the same frames', async () => {
    vi.resetModules();
    const kv = new Map<string, string>();
    const lists = new Map<string, string[]>();
    const ttls = new Map<string, number>();
    const redis = {
      set: vi.fn(async (k: string, v: string, ...rest: any[]) => {
        const isNx = rest.includes('NX');
        if (isNx && kv.has(k)) return null;
        kv.set(k, v);
        return 'OK';
      }),
      get: vi.fn(async (k: string) => kv.get(k) ?? null),
      rpush: vi.fn(async (k: string, v: string) => {
        const arr = lists.get(k) ?? [];
        arr.push(v);
        lists.set(k, arr);
        return arr.length;
      }),
      llen: vi.fn(async (k: string) => (lists.get(k) ?? []).length),
      lindex: vi.fn(async (k: string, i: number) => (lists.get(k) ?? [])[i] ?? null),
      lrange: vi.fn(async (k: string, s: number, e: number) => {
        const arr = lists.get(k) ?? [];
        const end = e === -1 ? arr.length : e + 1;
        return arr.slice(s, end);
      }),
      expire: vi.fn(async (k: string, s: number) => { ttls.set(k, s); return 1; }),
      eval: vi.fn(async () => 'CLOSED'),
      del: vi.fn(async () => 1),
      incr: vi.fn(async (k: string) => {
        const v = Number(kv.get(k) ?? '0') + 1;
        kv.set(k, String(v));
        return v;
      }),
    };
    vi.doMock('../src/redis', () => ({ getRedis: () => redis, closeRedis: vi.fn() }));

    const encoder = new TextEncoder();
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(encoder.encode('data: a\n\n'));
            await new Promise((r) => setTimeout(r, 30));
            c.enqueue(encoder.encode('data: b\n\n'));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    ) as any;
    vi.stubGlobal('fetch', fetchImpl);

    const { app } = await import('../src/server');

    const reqBody = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true };
    const first = request(app)
      .post('/v1/chat')
      .set('Accept', 'text/event-stream')
      .set('Idempotency-Key', 'same-key')
      .send(reqBody);

    await new Promise((r) => setTimeout(r, 10));
    const second = request(app)
      .post('/v1/chat')
      .set('Accept', 'text/event-stream')
      .set('Idempotency-Key', 'same-key')
      .send(reqBody);

    const [res1, res2] = await Promise.all([first, second]);
    expect(res1.status).toBe(200);
    expect(res1.text).toBe('data: a\n\ndata: b\n\n');
    expect(res2.status).toBe(200);
    expect(res2.text).toBe('data: a\n\ndata: b\n\n');

    vi.unstubAllGlobals();
  }, 10_000);
});
