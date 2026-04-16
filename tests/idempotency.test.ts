import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { RequestHandler } from 'express';
import request from 'supertest';
import { idempotencyMiddleware } from '../src/idempotency';

// Mock the redis module
vi.mock('../src/redis', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from '../src/redis';

function makeApp(handler: RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware());
  app.post('/v1/chat', handler);
  return app;
}

describe('idempotencyMiddleware', () => {
  let mockRedis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockRedis = { get: vi.fn(), set: vi.fn().mockResolvedValue('OK') };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);
  });

  it('passes through when no Idempotency-Key header', async () => {
    const handler = vi.fn((req, res) => res.json({ result: 'fresh' }));
    const app = makeApp(handler);

    mockRedis.get.mockResolvedValue(null);

    const response = await request(app)
      .post('/v1/chat')
      .send({ prompt: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'fresh' });
    expect(handler).toHaveBeenCalled();
    // No key — Redis should not have been called
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('returns cached response on duplicate key', async () => {
    const handler = vi.fn((req, res) => res.json({ result: 'fresh' }));
    const app = makeApp(handler);

    const cached = JSON.stringify({ status: 200, body: { result: 'cached' } });
    mockRedis.get.mockResolvedValue(cached);

    const response = await request(app)
      .post('/v1/chat')
      .set('Idempotency-Key', 'test-key-123')
      .send({ prompt: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'cached' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('caches and calls handler on first request with key', async () => {
    const handler = vi.fn((req, res) => res.json({ result: 'fresh' }));
    const app = makeApp(handler);

    mockRedis.get.mockResolvedValue(null); // no cache

    const response = await request(app)
      .post('/v1/chat')
      .set('Idempotency-Key', 'new-key-456')
      .send({ prompt: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'fresh' });
    expect(handler).toHaveBeenCalled();
    expect(mockRedis.set).toHaveBeenCalledWith(
      'idempotency:new-key-456',
      expect.stringContaining('"result":"fresh"'),
      'EX',
      86400
    );
  });
});
