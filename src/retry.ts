export class RetryExhaustedError extends Error {
  constructor(
    public readonly lastDelaySeconds: number,
    public readonly lastStatus: number,
  ) {
    super(`LLM API failed after 3 retries. Last status: ${lastStatus}`);
    this.name = 'RetryExhaustedError';
  }
}

export const RETRY_DELAYS_MS = [1000, 2000, 4000];

export const defaultRetryDelayMs = (attempt: number): number =>
  RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export async function withRetry(
  fn: () => Promise<Response>,
  delayMs: (attempt: number) => number = defaultRetryDelayMs,
): Promise<Response> {
  let lastStatus = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fn();

    if (!isRetryable(response.status)) {
      return response; // success or non-retryable error
    }

    lastStatus = response.status;

    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, delayMs(attempt)));
    }
  }

  throw new RetryExhaustedError(delayMs(2) / 1000, lastStatus);
}
