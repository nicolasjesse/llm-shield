import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

interface CorrelationStore {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

export function correlationMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('X-Correlation-ID');
    const correlationId = incoming && incoming.trim() !== '' ? incoming.trim() : randomUUID();
    res.setHeader('X-Correlation-ID', correlationId);
    storage.run({ correlationId }, () => next());
  };
}
