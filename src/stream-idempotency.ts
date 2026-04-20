import { getRedis } from './redis';

export const SENTINEL_END = '__END__';
export const SENTINEL_ERR = '__ERR__';
export const META_TTL_INFLIGHT = 300;
export const META_TTL_DONE = 86400;

export type StreamMetaState = 'in_flight' | 'done' | 'failed';

export interface StreamMeta {
  state: StreamMetaState;
  status?: number;
  contentType?: string;
}

export function keyMeta(key: string): string {
  return `stream-idem:${key}:meta`;
}

export function keyChunks(key: string): string {
  return `stream-idem:${key}:chunks`;
}

export async function claimKey(key: string): Promise<boolean> {
  const redis = getRedis();
  const res = await redis.set(
    keyMeta(key),
    JSON.stringify({ state: 'in_flight' } as StreamMeta),
    'EX',
    META_TTL_INFLIGHT,
    'NX',
  );
  return res === 'OK';
}

export async function readMeta(key: string): Promise<StreamMeta | null> {
  const redis = getRedis();
  const raw = await redis.get(keyMeta(key));
  if (!raw) return null;
  return JSON.parse(raw) as StreamMeta;
}

export async function markDone(key: string, status: number, contentType: string): Promise<void> {
  const redis = getRedis();
  await redis.set(
    keyMeta(key),
    JSON.stringify({ state: 'done', status, contentType } as StreamMeta),
    'EX',
    META_TTL_DONE,
  );
  await redis.expire(keyChunks(key), META_TTL_DONE);
}

export async function markFailed(key: string, status: number, contentType: string): Promise<void> {
  const redis = getRedis();
  await redis.set(
    keyMeta(key),
    JSON.stringify({ state: 'failed', status, contentType } as StreamMeta),
    'EX',
    META_TTL_INFLIGHT,
  );
}
