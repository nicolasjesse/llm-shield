import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server';
import { closeRedis } from '../src/redis';
import * as observability from '../src/observability';
import * as circuitBreaker from '../src/circuit-breaker';
import * as retry from '../src/retry';

describe('observability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeRedis();
  });

  describe('correlation IDs', () => {
    it('generates a correlation ID and returns it on the response', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      const header = res.headers['x-correlation-id'];
      expect(header).toBeDefined();
      expect(header).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('preserves a client-provided correlation ID', async () => {
      const clientId = 'my-trace-12345';
      const res = await request(app)
        .get('/health')
        .set('X-Correlation-ID', clientId);
      expect(res.headers['x-correlation-id']).toBe(clientId);
    });

    it('trims whitespace-only correlation IDs and regenerates', async () => {
      const res = await request(app)
        .get('/health')
        .set('X-Correlation-ID', '   ');
      expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('captureEvent on failure paths', () => {
    it('captures circuit_open when circuit breaker rejects', async () => {
      const captureSpy = vi.spyOn(observability, 'captureEvent');
      vi.spyOn(circuitBreaker, 'getState').mockResolvedValue('OPEN');
      vi.spyOn(circuitBreaker, 'withCircuitBreaker').mockImplementation(async () => {
        throw new circuitBreaker.CircuitOpenError('circuit is OPEN');
      });

      const res = await request(app)
        .post('/v1/chat')
        .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'circuit_open' });
      const call = captureSpy.mock.calls.find((c) => c[0].tag === 'circuit_open');
      expect(call).toBeDefined();
      expect(call?.[0].extra).toMatchObject({ model: 'gpt-4' });
    });

    it('captures retry_exhausted when retries run out', async () => {
      const captureSpy = vi.spyOn(observability, 'captureEvent');
      vi.spyOn(circuitBreaker, 'getState').mockResolvedValue('CLOSED');
      vi.spyOn(circuitBreaker, 'withCircuitBreaker').mockImplementation(async (fn) => {
        return fn();
      });
      vi.spyOn(retry, 'withRetry').mockImplementation(async () => {
        throw new retry.RetryExhaustedError(4, 503);
      });

      const res = await request(app)
        .post('/v1/chat')
        .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: 'retry_exhausted' });
      const call = captureSpy.mock.calls.find((c) => c[0].tag === 'retry_exhausted');
      expect(call).toBeDefined();
      expect(call?.[0].extra).toMatchObject({
        model: 'gpt-4',
        last_status: 503,
        last_delay_seconds: 4,
      });
    });
  });
});
