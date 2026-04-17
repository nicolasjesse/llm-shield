import pino from 'pino';
import { getCorrelationId } from './correlation';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: 'llm-shield' },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const correlationId = getCorrelationId();
    return correlationId ? { correlation_id: correlationId } : {};
  },
});
