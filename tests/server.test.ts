import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server';

// Mock proxy and redis
vi.mock('../src/proxy', () => ({
  proxyRequest: vi.fn(),
}));

vi.mock('../src/redis', () => ({
  getRedis: vi.fn(),
  closeRedis: vi.fn(),
}));

import { proxyRequest } from '../src/proxy';
import { getRedis } from '../src/redis';

const mockSuccessResponse = {
  id: 'chatcmpl-123',
  object: 'chat.completion',
  model: 'gpt-4o',
  choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop', index: 0 }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe('POST /v1/chat', () => {
  let mockRedis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);
  });

  it('returns 400 when model is missing', async () => {
    const res = await request(app)
      .post('/v1/chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('model');
  });

  it('returns 400 when messages is empty', async () => {
    const res = await request(app)
      .post('/v1/chat')
      .send({ model: 'gpt-4o', messages: [] });

    expect(res.status).toBe(400);
  });

  it('returns 200 with upstream response on valid request', async () => {
    vi.mocked(proxyRequest).mockResolvedValue({ status: 200, data: mockSuccessResponse });

    const res = await request(app)
      .post('/v1/chat')
      .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Hello!');
    expect(proxyRequest).toHaveBeenCalledOnce();
  });

  it('returns 503 when circuit breaker is open', async () => {
    vi.mocked(proxyRequest).mockResolvedValue({
      status: 503,
      data: { error: 'Circuit breaker is OPEN', code: 'circuit_open' },
    });

    const res = await request(app)
      .post('/v1/chat')
      .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('circuit_open');
  });

  it('returns cached response on duplicate idempotency key', async () => {
    const cached = JSON.stringify({ status: 200, body: mockSuccessResponse });
    mockRedis.get.mockResolvedValue(cached);

    const res = await request(app)
      .post('/v1/chat')
      .set('Idempotency-Key', 'test-key-abc')
      .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockSuccessResponse);
    expect(proxyRequest).not.toHaveBeenCalled(); // idempotency short-circuited
  });
});

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
