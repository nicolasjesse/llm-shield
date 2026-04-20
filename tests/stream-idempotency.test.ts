import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  keyMeta,
  keyChunks,
  SENTINEL_END,
  SENTINEL_ERR,
  META_TTL_INFLIGHT,
  META_TTL_DONE,
  claimKey,
  readMeta,
  markDone,
  markFailed,
} from '../src/stream-idempotency';

vi.mock('../src/redis', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from '../src/redis';

describe('stream-idempotency helpers', () => {
  let mockRedis: any;
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      set: vi.fn(),
      get: vi.fn(),
      expire: vi.fn(),
      rpush: vi.fn(),
    };
    vi.mocked(getRedis).mockReturnValue(mockRedis);
  });

  it('builds the expected key names', () => {
    expect(keyMeta('abc')).toBe('stream-idem:abc:meta');
    expect(keyChunks('abc')).toBe('stream-idem:abc:chunks');
  });

  it('exports the sentinels and TTLs', () => {
    expect(SENTINEL_END).toBe('__END__');
    expect(SENTINEL_ERR).toBe('__ERR__');
    expect(META_TTL_INFLIGHT).toBe(300);
    expect(META_TTL_DONE).toBe(86400);
  });

  it('claimKey writes meta with NX and returns true on success', async () => {
    mockRedis.set.mockResolvedValue('OK');
    const ok = await claimKey('abc');
    expect(ok).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'stream-idem:abc:meta',
      JSON.stringify({ state: 'in_flight' }),
      'EX',
      300,
      'NX',
    );
  });

  it('claimKey returns false when key already claimed', async () => {
    mockRedis.set.mockResolvedValue(null);
    expect(await claimKey('abc')).toBe(false);
  });

  it('readMeta parses stored JSON', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ state: 'done', status: 200, contentType: 'text/event-stream' }));
    expect(await readMeta('abc')).toEqual({ state: 'done', status: 200, contentType: 'text/event-stream' });
  });

  it('readMeta returns null when missing', async () => {
    mockRedis.get.mockResolvedValue(null);
    expect(await readMeta('abc')).toBeNull();
  });

  it('markDone writes state=done with 24h TTL and bumps chunks TTL', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.expire.mockResolvedValue(1);
    await markDone('abc', 200, 'text/event-stream');
    expect(mockRedis.set).toHaveBeenCalledWith(
      'stream-idem:abc:meta',
      JSON.stringify({ state: 'done', status: 200, contentType: 'text/event-stream' }),
      'EX',
      86400,
    );
    expect(mockRedis.expire).toHaveBeenCalledWith('stream-idem:abc:chunks', 86400);
  });

  it('markFailed writes state=failed with short TTL', async () => {
    mockRedis.set.mockResolvedValue('OK');
    await markFailed('abc', 502, 'application/json');
    expect(mockRedis.set).toHaveBeenCalledWith(
      'stream-idem:abc:meta',
      JSON.stringify({ state: 'failed', status: 502, contentType: 'application/json' }),
      'EX',
      300,
    );
  });
});
