import { withRetry, RetryExhaustedError } from './retry';
import { withCircuitBreaker, CircuitOpenError, getState, claimProbeSlot } from './circuit-breaker';
import { enqueue, dequeueAll, setResult, clearQueue } from './queue';
import { captureEvent } from './observability';
import { logger } from './logger';

export interface ProxyRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ProxyResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
    index: number;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ProxyError {
  error: string;
  code: 'circuit_open' | 'retry_exhausted' | 'upstream_error';
  retryAfter?: number;
}

export interface QueuedResponse {
  queued: true;
  id: string;
  pollUrl: string;
}

const UPSTREAM_URL = process.env.LLM_UPSTREAM_URL ?? 'https://api.openai.com/v1/chat/completions';
const API_KEY = process.env.LLM_API_KEY ?? '';

async function drainQueueAndProcess(): Promise<void> {
  const items = await dequeueAll();
  await Promise.all(
    items.map(async ({ id, body }) => {
      try {
        const result = await proxyRequest(body as ProxyRequest);
        await setResult(id, result);
      } catch (err) {
        await setResult(id, {
          status: 500,
          data: { error: 'Queue drain failed', code: 'upstream_error' },
        });
      }
    }),
  );
}

export async function proxyRequest(
  body: ProxyRequest,
): Promise<{ status: number; data: ProxyResponse | ProxyError | QueuedResponse }> {
  const state = await getState();

  if (state === 'HALF_OPEN') {
    const isProbe = await claimProbeSlot();
    if (!isProbe) {
      const id = crypto.randomUUID();
      await enqueue(id, body);
      return {
        status: 202,
        data: { queued: true, id, pollUrl: `/v1/chat/queue/${id}` },
      };
    }
  }

  const wasProbe = state === 'HALF_OPEN';

  try {
    const response = await withCircuitBreaker(() =>
      withRetry(() =>
        fetch(UPSTREAM_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      ),
    );

    const data = (await response.json()) as ProxyResponse | ProxyError;

    if (response.status === 401 || response.status === 403) {
      captureEvent({
        tag: 'upstream_auth_error',
        message: `upstream returned ${response.status}`,
        extra: { upstream_url: UPSTREAM_URL, model: body.model, status: response.status },
      });
    }

    if (wasProbe) {
      drainQueueAndProcess().catch((err) =>
        logger.error({ err }, 'queue drain failed'),
      );
    }

    return { status: response.status, data };
  } catch (err) {
    if (wasProbe) {
      clearQueue({
        status: 503,
        data: { error: 'Upstream unavailable, circuit re-opened', code: 'circuit_open' },
      }).catch((e) => logger.error({ err: e }, 'queue clear failed'));
    }

    if (err instanceof CircuitOpenError) {
      captureEvent({
        tag: 'circuit_open',
        message: err.message,
        extra: { upstream_url: UPSTREAM_URL, model: body.model },
      });
      return {
        status: 503,
        data: { error: err.message, code: 'circuit_open' },
      };
    }
    if (err instanceof RetryExhaustedError) {
      captureEvent({
        tag: 'retry_exhausted',
        message: err.message,
        extra: {
          upstream_url: UPSTREAM_URL,
          model: body.model,
          last_status: err.lastStatus,
          last_delay_seconds: err.lastDelaySeconds,
        },
      });
      return {
        status: 502,
        data: {
          error: err.message,
          code: 'retry_exhausted',
          retryAfter: err.lastDelaySeconds,
        },
      };
    }
    const message = err instanceof Error ? err.message : 'Unknown proxy error';
    logger.error({ err, model: body.model }, 'upstream error');
    return {
      status: 500,
      data: { error: message, code: 'upstream_error' },
    };
  }
}
