import { getRedis } from './redis';

const QUEUE_KEY = 'cb:queue';
const RESULT_PREFIX = 'cb:result:';
const RESULT_TTL_SECONDS = 300; // 5 minutes

export interface QueueItem {
  id: string;
  body: unknown;
}

export async function enqueue(id: string, body: unknown): Promise<void> {
  const redis = getRedis();
  await redis.rpush(QUEUE_KEY, JSON.stringify({ id, body }));
}

export async function dequeueAll(): Promise<QueueItem[]> {
  const redis = getRedis();
  const items: QueueItem[] = [];
  let raw: string | null;
  while ((raw = await redis.lpop(QUEUE_KEY)) !== null) {
    items.push(JSON.parse(raw) as QueueItem);
  }
  return items;
}

export async function setResult(id: string, result: { status: number; data: unknown }): Promise<void> {
  const redis = getRedis();
  await redis.set(`${RESULT_PREFIX}${id}`, JSON.stringify(result), 'EX', RESULT_TTL_SECONDS);
}

export async function getResult(id: string): Promise<{ status: number; data: unknown } | null> {
  const redis = getRedis();
  const raw = await redis.get(`${RESULT_PREFIX}${id}`);
  return raw ? (JSON.parse(raw) as { status: number; data: unknown }) : null;
}

export async function clearQueue(errorResult: { status: number; data: unknown }): Promise<void> {
  const redis = getRedis();
  let raw: string | null;
  while ((raw = await redis.lpop(QUEUE_KEY)) !== null) {
    const { id } = JSON.parse(raw) as QueueItem;
    await redis.set(`${RESULT_PREFIX}${id}`, JSON.stringify(errorResult), 'EX', RESULT_TTL_SECONDS);
  }
}
