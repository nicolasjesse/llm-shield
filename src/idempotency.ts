import { Request, Response, NextFunction } from 'express';
import { getRedis } from './redis';

const TTL_SECONDS = 86400; // 24 hours

export function idempotencyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.headers['idempotency-key'] as string | undefined;

    if (!key) {
      next();
      return;
    }

    const redis = getRedis();
    const cacheKey = `idempotency:${key}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      const { status, body } = JSON.parse(cached);
      res.status(status).json(body);
      return;
    }

    // NOTE: There is a TOCTOU race here — two concurrent requests with the same key
    // can both miss the cache and both proceed. Fix in production: use SET NX to
    // atomically reserve the key before calling next().

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const toCache = JSON.stringify({ status: res.statusCode, body });
        redis.set(cacheKey, toCache, 'EX', TTL_SECONDS).catch((err) => console.error('[idempotency] Redis cache write failed:', err));
      }
      return originalJson(body);
    };

    next();
  };
}
