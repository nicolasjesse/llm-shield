import { describe, it, expect, vi } from 'vitest';
import { withRetry, RetryExhaustedError } from '../src/retry';

function makeResponse(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue(makeResponse(200));
    const result = await withRetry(fn);
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on non-retryable error (400)', async () => {
    const fn = vi.fn().mockResolvedValue(makeResponse(400));
    const result = await withRetry(fn);
    expect(result.status).toBe(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValue(makeResponse(200));

    const result = await withRetry(fn, () => 0); // zero delay for tests
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 and succeeds on third attempt', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValue(makeResponse(200));

    const result = await withRetry(fn, () => 0);
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws RetryExhaustedError after 3 failures', async () => {
    const fn = vi.fn().mockResolvedValue(makeResponse(429));

    await expect(withRetry(fn, () => 0)).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('RetryExhaustedError includes lastStatus', async () => {
    const fn = vi.fn().mockResolvedValue(makeResponse(503));

    try {
      await withRetry(fn, () => 0);
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      expect((err as RetryExhaustedError).lastStatus).toBe(503);
    }
  });
});
