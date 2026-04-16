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
  const raw = await redis.get(KEY_STATE);
  const VALID_STATES: CircuitState[] = ['CLOSED', 'OPEN', 'HALF_OPEN'];
  const state: CircuitState | null = VALID_STATES.includes(raw as CircuitState)
    ? (raw as CircuitState)
    : null;

  if (state === 'OPEN') {
    const openedAt = await redis.get(KEY_OPENED_AT);
    if (openedAt && Date.now() - parseInt(openedAt) > OPEN_DURATION_MS) {
      await redis.set(KEY_STATE, 'HALF_OPEN');
      return 'HALF_OPEN';
    }
  }

  // NOTE: TOCTOU race — two concurrent requests can both read OPEN, both compute
  // the elapsed time, and both transition to HALF_OPEN, acting as simultaneous probes.
  // Fix in production: use a Redis Lua script or SET NX to atomically transition state.

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

  // NOTE: HALF_OPEN allows one probe at a time conceptually, but concurrent requests
  // can slip through before state is updated. Fix in production: use SET NX to
  // atomically claim probe rights before calling fn().

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
