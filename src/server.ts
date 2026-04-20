import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { idempotencyMiddleware } from './idempotency';
import { proxyRequest } from './proxy';
import { isStreamingRequest, proxyStreamRequest, proxyStreamRequestRecording } from './stream';
import { streamIdempotencyMiddleware, keyChunks, SENTINEL_END, SENTINEL_ERR, markDone, markFailed } from './stream-idempotency';
import { getResult } from './queue';
import { closeRedis, getRedis } from './redis';
import { correlationMiddleware } from './correlation';
import { logger } from './logger';
import { captureEvent, captureException, initObservability } from './observability';
import type { ChatRequest } from './types';

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS ?? '5000');

initObservability();

export const app = express();

app.use(correlationMiddleware());

// Request logger + latency threshold
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();
  logger.info({ route: `${req.method} ${req.path}` }, 'request received');
  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const payload = {
      route: `${req.method} ${req.path}`,
      status_code: res.statusCode,
      latency_ms: Math.round(latencyMs),
    };
    if (latencyMs > SLOW_REQUEST_MS) {
      captureEvent({
        tag: 'slow_request',
        message: `request exceeded ${SLOW_REQUEST_MS}ms threshold`,
        extra: payload,
      });
    } else {
      logger.info(payload, 'request completed');
    }
  });
  next();
});

app.use(express.json());
app.use(idempotencyMiddleware());
app.use(streamIdempotencyMiddleware());

app.post('/v1/chat', async (req, res) => {
  const body = req.body as ChatRequest;

  if (!body.model || !body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: 'model and messages are required' });
    return;
  }

  if (isStreamingRequest(req, body)) {
    const claim = (req as any).streamIdempotency as { key: string; claimed: true } | undefined;
    if (claim?.claimed) {
      const redis = getRedis();
      const chunksKey = keyChunks(claim.key);
      await proxyStreamRequestRecording(
        body as Parameters<typeof proxyStreamRequestRecording>[0],
        res,
        (buf) => {
          redis.rpush(chunksKey, buf.toString('base64')).catch((err) =>
            logger.error({ err, component: 'stream-idem' }, 'chunk RPUSH failed'),
          );
        },
        (ok, status, contentType) => {
          const terminal = ok ? SENTINEL_END : SENTINEL_ERR;
          redis.rpush(chunksKey, terminal).catch((err) =>
            logger.error({ err, component: 'stream-idem' }, 'terminal RPUSH failed'),
          );
          const finalize = ok
            ? markDone(claim.key, status, contentType)
            : markFailed(claim.key, status, contentType);
          finalize.catch((err) => logger.error({ err, component: 'stream-idem' }, 'finalize failed'));
        },
      );
      return;
    }
    await proxyStreamRequest(body as Parameters<typeof proxyStreamRequest>[0], res);
    return;
  }

  const result = await proxyRequest(body);
  res.status(result.status).json(result.data);
});

app.get('/v1/chat/queue/:id', async (req, res) => {
  const result = await getResult(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'Result not ready or expired. Retry shortly.' });
    return;
  }
  res.status(result.status as number).json(result.data);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Error handler (last middleware) — catches anything a route forgot to handle
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  captureException(err, { tag: 'uncaught_exception' });
  res.status(500).json({ error: 'internal_error' });
});

process.on('uncaughtException', (err) => {
  captureException(err, { tag: 'uncaught_exception' });
});
process.on('unhandledRejection', (reason) => {
  captureException(reason, { tag: 'unhandled_rejection' });
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing Redis');
  await closeRedis();
  process.exit(0);
});

if (require.main === module) {
  const PORT = parseInt(process.env.PORT ?? '3000');
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'LLM Shield started');
  });
}
