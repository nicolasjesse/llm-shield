import { Request, Response, NextFunction } from 'express';
import { getRedis } from './redis';

const TTL_SECONDS = 86400; // 24 hours
const PENDING_VALUE = '__pending__';
const PENDING_TTL_SECONDS = 30;  // expires if we crash before writing real result
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;

export function idempotencyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.headers['idempotency-key'] as string | undefined;

    if (!key) {
      next();
      return;
    }

    const redis = getRedis();
    const cacheKey = `idempotency:${key}`;

    // Fast path: real result already exists
    const existing = await redis.get(cacheKey);
    if (existing && existing !== PENDING_VALUE) {
      const { status, body } = JSON.parse(existing);
      res.status(status).json(body);
      return;
    }

    // If pending, skip straight to the poll loop below
    if (existing !== PENDING_VALUE) {
      // Key doesn't exist — try to atomically claim it
      const claimed = await redis.set(cacheKey, PENDING_VALUE, 'EX', PENDING_TTL_SECONDS, 'NX');

      if (claimed === 'OK') {
        // We own this key — proceed and cache the response on the way out
        const originalJson = res.json.bind(res);
        res.json = (body: unknown) => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const toCache = JSON.stringify({ status: res.statusCode, body });
            redis.set(cacheKey, toCache, 'EX', TTL_SECONDS).catch((err) =>
              console.error('[idempotency] Redis cache write failed:', err),
            );
          }
          return originalJson(body);
        };
        next();
        return;
      }
    }

    // Another request claimed the key — poll until it writes the real result
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const value = await redis.get(cacheKey);
      if (value && value !== PENDING_VALUE) {
        const { status, body } = JSON.parse(value);
        res.status(status).json(body);
        return;
      }
    }

    // Timed out waiting — degrade gracefully by proceeding without caching
    console.warn('[idempotency] Timed out waiting for pending result, proceeding without cache');
    next();
  };
}
