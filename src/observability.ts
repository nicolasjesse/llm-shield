import * as Sentry from '@sentry/node';
import { getCorrelationId } from './correlation';
import { logger } from './logger';

let initialized = false;

export function initObservability(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info({ sentry: 'disabled' }, 'Sentry not initialized (SENTRY_DSN not set)');
    initialized = true;
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.RELEASE ?? undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
  });
  logger.info({ sentry: 'enabled' }, 'Sentry initialized');
  initialized = true;
}

export type ObservabilityTag =
  | 'circuit_open'
  | 'retry_exhausted'
  | 'upstream_auth_error'
  | 'slow_request'
  | 'uncaught_exception'
  | 'unhandled_rejection';

export interface CaptureContext {
  tag: ObservabilityTag;
  message?: string;
  extra?: Record<string, unknown>;
}

/**
 * Captures an event to Sentry (if initialized) and always logs it.
 * Safe to call without SENTRY_DSN configured — logs only in that case.
 * Returns a summary of what was captured (useful for tests).
 */
export function captureEvent(ctx: CaptureContext): {
  tag: ObservabilityTag;
  correlationId: string | undefined;
  extra: Record<string, unknown> | undefined;
} {
  const correlationId = getCorrelationId();
  logger.warn(
    {
      event: ctx.tag,
      correlation_id: correlationId,
      ...(ctx.extra ?? {}),
    },
    ctx.message ?? ctx.tag,
  );
  if (initialized && process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      scope.setTag('event', ctx.tag);
      if (correlationId) scope.setTag('correlation_id', correlationId);
      if (ctx.extra) scope.setExtras(ctx.extra);
      Sentry.captureMessage(ctx.message ?? ctx.tag, 'warning');
    });
  }
  return { tag: ctx.tag, correlationId, extra: ctx.extra };
}

export function captureException(err: unknown, ctx: Omit<CaptureContext, 'message'> & { message?: string }): void {
  const correlationId = getCorrelationId();
  logger.error(
    {
      event: ctx.tag,
      correlation_id: correlationId,
      err,
      ...(ctx.extra ?? {}),
    },
    ctx.message ?? (err instanceof Error ? err.message : ctx.tag),
  );
  if (initialized && process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      scope.setTag('event', ctx.tag);
      if (correlationId) scope.setTag('correlation_id', correlationId);
      if (ctx.extra) scope.setExtras(ctx.extra);
      Sentry.captureException(err);
    });
  }
}
