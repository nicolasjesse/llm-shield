import { getRedis } from './redis';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit breaker is OPEN — request rejected');
    this.name = 'CircuitOpenError';
  }
}

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 30_000;
const KEY_STATE = 'cb:state';
const KEY_FAILURES = 'cb:failures';
const KEY_OPENED_AT = 'cb:opened_at';

export async function getState(): Promise<CircuitState> {
  const redis = getRedis();
  const state = (await redis.get(KEY_STATE)) as CircuitState | null;

  if (state === 'OPEN') {
    const openedAt = await redis.get(KEY_OPENED_AT);
    if (openedAt && Date.now() - parseInt(openedAt) > OPEN_DURATION_MS) {
      await redis.set(KEY_STATE, 'HALF_OPEN');
      return 'HALF_OPEN';
    }
  }

  return state ?? 'CLOSED';
}

export async function recordSuccess(): Promise<void> {
  const redis = getRedis();
  await redis.set(KEY_STATE, 'CLOSED');
  await redis.set(KEY_FAILURES, '0');
  await redis.del(KEY_OPENED_AT);
}

export async function recordFailure(): Promise<void> {
  const redis = getRedis();
  const failures = await redis.incr(KEY_FAILURES);

  if (failures >= FAILURE_THRESHOLD) {
    await redis.set(KEY_STATE, 'OPEN');
    await redis.set(KEY_OPENED_AT, Date.now().toString());
  }
}

export async function withCircuitBreaker<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const state = await getState();

  if (state === 'OPEN') {
    throw new CircuitOpenError();
  }

  try {
    const result = await fn();
    await recordSuccess();
    return result;
  } catch (err) {
    if (err instanceof CircuitOpenError) throw err;
    await recordFailure();
    throw err;
  }
}
