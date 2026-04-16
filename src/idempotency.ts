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

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const toCache = JSON.stringify({ status: res.statusCode, body });
      redis.set(cacheKey, toCache, 'EX', TTL_SECONDS).catch(() => {});
      return originalJson(body);
    };

    next();
  };
}
