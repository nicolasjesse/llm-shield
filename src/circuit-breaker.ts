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
const KEY_PROBE_LOCK = 'cb:probe_lock';

// Atomically reads state and transitions OPEN → HALF_OPEN if the timeout has elapsed.
// Redis executes Lua scripts single-threaded — no other command can interleave,
// which eliminates the TOCTOU race where two requests both trigger the HALF_OPEN transition.
const TRANSITION_SCRIPT = `
  local state = redis.call('GET', KEYS[1])
  if state == 'OPEN' then
    local opened_at = redis.call('GET', KEYS[2])
    if opened_at ~= false and (tonumber(ARGV[1]) - tonumber(opened_at)) > tonumber(ARGV[2]) then
      redis.call('SET', KEYS[1], 'HALF_OPEN')
      return 'HALF_OPEN'
    end
    return 'OPEN'
  end
  if state == false then return 'CLOSED' end
  return state
`;

export async function getState(): Promise<CircuitState> {
  const redis = getRedis();
  // redis.eval() runs a Lua script atomically inside Redis — not JS eval()
  const result = await redis.eval(
    TRANSITION_SCRIPT,
    2,                          // number of KEYS arguments
    KEY_STATE,                  // KEYS[1]
    KEY_OPENED_AT,              // KEYS[2]
    Date.now().toString(),      // ARGV[1] — current timestamp
    OPEN_DURATION_MS.toString() // ARGV[2] — threshold
  ) as string;

  const VALID_STATES: CircuitState[] = ['CLOSED', 'OPEN', 'HALF_OPEN'];
  return VALID_STATES.includes(result as CircuitState) ? (result as CircuitState) : 'CLOSED';
}

// Atomically claim the probe slot when HALF_OPEN.
// Returns true if this request is the probe; false if another request already claimed it.
export async function claimProbeSlot(): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(KEY_PROBE_LOCK, '1', 'EX', 30, 'NX');
  return result === 'OK';
}

export async function recordSuccess(): Promise<void> {
  const redis = getRedis();
  await redis.set(KEY_STATE, 'CLOSED');
  await redis.set(KEY_FAILURES, '0');
  await redis.del(KEY_OPENED_AT);
  await redis.del(KEY_PROBE_LOCK);
}

export async function recordFailure(): Promise<void> {
  const redis = getRedis();
  const failures = await redis.incr(KEY_FAILURES);

  if (failures >= FAILURE_THRESHOLD) {
    await redis.set(KEY_STATE, 'OPEN');
    await redis.set(KEY_OPENED_AT, Date.now().toString());
    await redis.del(KEY_PROBE_LOCK); // release so next HALF_OPEN can probe
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
