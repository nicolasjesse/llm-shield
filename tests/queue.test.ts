import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueue, dequeueAll, setResult, getResult, clearQueue } from '../src/queue';

vi.mock('../src/redis', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from '../src/redis';

function makeMockRedis() {
  const store: Record<string, string> = {};
  const list: string[] = [];

  return {
    rpush: vi.fn((_key: string, value: string) => {
      list.push(value);
      return Promise.resolve(list.length);
    }),
    lpop: vi.fn((_key: string) => {
      return Promise.resolve(list.shift() ?? null);
    }),
    set: vi.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve('OK');
    }),
    get: vi.fn((key: string) => Promise.resolve(store[key] ?? null)),
    _store: store,
    _list: list,
  };
}

describe('queue', () => {
  let mockRedis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    mockRedis = makeMockRedis();
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);
  });

  it('enqueue adds item to the list', async () => {
    await enqueue('id-1', { model: 'gpt-4', messages: [] });
    expect(mockRedis.rpush).toHaveBeenCalledOnce();
    const pushed = JSON.parse(mockRedis.rpush.mock.calls[0][1]);
    expect(pushed.id).toBe('id-1');
  });

  it('dequeueAll returns all items and empties the list', async () => {
    await enqueue('id-1', { model: 'gpt-4', messages: [] });
    await enqueue('id-2', { model: 'gpt-4', messages: [] });

    const items = await dequeueAll();
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('id-1');
    expect(items[1].id).toBe('id-2');

    const empty = await dequeueAll();
    expect(empty).toHaveLength(0);
  });

  it('setResult stores result in Redis with a namespaced key', async () => {
    await setResult('id-1', { status: 200, data: { ok: true } });
    expect(mockRedis.set).toHaveBeenCalledWith(
      'cb:result:id-1',
      expect.any(String),
      'EX',
      300,
    );
  });

  it('getResult returns stored result', async () => {
    await setResult('id-1', { status: 200, data: { ok: true } });
    const result = await getResult('id-1');
    expect(result).toEqual({ status: 200, data: { ok: true } });
  });

  it('getResult returns null when key does not exist', async () => {
    const result = await getResult('nonexistent');
    expect(result).toBeNull();
  });

  it('clearQueue stores error result for each queued item', async () => {
    await enqueue('id-1', {});
    await enqueue('id-2', {});

    const errorResult = { status: 503, data: { error: 'circuit open', code: 'circuit_open' } };
    await clearQueue(errorResult);

    const r1 = await getResult('id-1');
    const r2 = await getResult('id-2');
    expect(r1).toEqual(errorResult);
    expect(r2).toEqual(errorResult);
  });
});
