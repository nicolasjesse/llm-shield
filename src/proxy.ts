import { withRetry, RetryExhaustedError } from './retry';
import { withCircuitBreaker, CircuitOpenError } from './circuit-breaker';

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

const UPSTREAM_URL = process.env.LLM_UPSTREAM_URL ?? 'https://api.openai.com/v1/chat/completions';
const API_KEY = process.env.LLM_API_KEY ?? '';

export async function proxyRequest(body: ProxyRequest): Promise<{ status: number; data: ProxyResponse | ProxyError }> {
  try {
    const response = await withCircuitBreaker(() =>
      withRetry(() =>
        fetch(UPSTREAM_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      )
    );

    const data = await response.json() as ProxyResponse | ProxyError;
    return { status: response.status, data };
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return {
        status: 503,
        data: { error: err.message, code: 'circuit_open' },
      };
    }
    if (err instanceof RetryExhaustedError) {
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
    return {
      status: 500,
      data: { error: message, code: 'upstream_error' },
    };
  }
}
