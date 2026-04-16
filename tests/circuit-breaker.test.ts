import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getState, recordSuccess, recordFailure, withCircuitBreaker, CircuitOpenError } from '../src/circuit-breaker';

vi.mock('../src/redis', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from '../src/redis';

function makeMockRedis(overrides: Record<string, string | null> = {}) {
  const store: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== null) store[k] = v;
  }
  return {
    get: vi.fn((key: string) => Promise.resolve(store[key] ?? null)),
    set: vi.fn((key: string, value: string) => { store[key] = value; return Promise.resolve('OK'); }),
    incr: vi.fn((key: string) => {
      store[key] = String((parseInt(store[key] ?? '0') || 0) + 1);
      return Promise.resolve(parseInt(store[key]));
    }),
    del: vi.fn((key: string) => { delete store[key]; return Promise.resolve(1); }),
    _store: store,
  };
}

describe('circuit breaker', () => {
  let mockRedis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    mockRedis = makeMockRedis();
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);
  });

  it('starts CLOSED when no state in Redis', async () => {
    expect(await getState()).toBe('CLOSED');
  });

  it('is OPEN when state is OPEN and timeout not elapsed', async () => {
    mockRedis = makeMockRedis({
      'cb:state': 'OPEN',
      'cb:opened_at': Date.now().toString(), // just opened
    });
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);
    expect(await getState()).toBe('OPEN');
  });

  it('transitions OPEN → HALF_OPEN after 30s', async () => {
    const thirtyOneSecondsAgo = (Date.now() - 31_000).toString();
    mockRedis = makeMockRedis({
      'cb:state': 'OPEN',
      'cb:opened_at': thirtyOneSecondsAgo,
    });
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);
    expect(await getState()).toBe('HALF_OPEN');
  });

  it('opens circuit after 5 consecutive failures', async () => {
    for (let i = 0; i < 5; i++) {
      await recordFailure();
    }
    expect(mockRedis._store['cb:state']).toBe('OPEN');
  });

  it('resets on success', async () => {
    mockRedis._store['cb:state'] = 'OPEN';
    mockRedis._store['cb:failures'] = '5';
    await recordSuccess();
    expect(mockRedis._store['cb:state']).toBe('CLOSED');
    expect(mockRedis._store['cb:failures']).toBe('0');
  });

  it('withCircuitBreaker throws CircuitOpenError when OPEN', async () => {
    mockRedis = makeMockRedis({
      'cb:state': 'OPEN',
      'cb:opened_at': Date.now().toString(),
    });
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);
    await expect(withCircuitBreaker(() => Promise.resolve('ok'))).rejects.toThrow(CircuitOpenError);
  });

  it('withCircuitBreaker calls fn and records success when CLOSED', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const result = await withCircuitBreaker(fn);
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalled();
    expect(mockRedis._store['cb:state']).toBe('CLOSED');
  });

  it('withCircuitBreaker records failure and rethrows when fn throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('upstream error'));
    await expect(withCircuitBreaker(fn)).rejects.toThrow('upstream error');
    expect(parseInt(mockRedis._store['cb:failures'] ?? '0')).toBeGreaterThan(0);
  });
});
