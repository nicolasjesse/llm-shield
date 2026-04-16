import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { RequestHandler } from 'express';
import request from 'supertest';
import { idempotencyMiddleware } from '../src/idempotency';

vi.mock('../src/redis', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from '../src/redis';

const PENDING_VALUE = '__pending__';

function makeApp(handler: RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware());
  app.post('/v1/chat', handler);
  return app;
}

function makeMockRedis(initialValue: string | null = null) {
  let stored = initialValue;
  return {
    get: vi.fn(() => Promise.resolve(stored)),
    set: vi.fn((key: string, value: string, ...args: unknown[]) => {
      const isNX = args.includes('NX');
      if (isNX && stored !== null) return Promise.resolve(null); // already claimed
      stored = value;
      return Promise.resolve('OK');
    }),
    _getStored: () => stored,
  };
}

describe('idempotencyMiddleware', () => {
  let mockRedis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    mockRedis = makeMockRedis();
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);
  });

  it('passes through when no Idempotency-Key header', async () => {
    const handler = vi.fn((req, res) => res.json({ result: 'fresh' }));
    const app = makeApp(handler);

    const response = await request(app).post('/v1/chat').send({ prompt: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'fresh' });
    expect(handler).toHaveBeenCalled();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('returns cached response on duplicate key (real result in Redis)', async () => {
    const handler = vi.fn((req, res) => res.json({ result: 'fresh' }));
    const cached = JSON.stringify({ status: 200, body: { result: 'cached' } });
    mockRedis = makeMockRedis(cached);
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);
    const app = makeApp(handler);

    const response = await request(app)
      .post('/v1/chat')
      .set('Idempotency-Key', 'test-key-123')
      .send({ prompt: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'cached' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('claims key with SET NX on first request and caches real result', async () => {
    const handler = vi.fn((req, res) => res.json({ result: 'fresh' }));
    const app = makeApp(handler);

    const response = await request(app)
      .post('/v1/chat')
      .set('Idempotency-Key', 'new-key-456')
      .send({ prompt: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'fresh' });
    expect(handler).toHaveBeenCalled();

    // After the handler, stored value should be the real result (not pending)
    const stored = mockRedis._getStored();
    expect(stored).not.toBe(PENDING_VALUE);
    expect(stored).toContain('"result":"fresh"');
  });
});
