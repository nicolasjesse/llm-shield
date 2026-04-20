# llm-shield

An OpenAI-compatible proxy that adds three resilience patterns in front of any LLM API: idempotency, retry with exponential backoff, and a circuit breaker.

## Usage

```bash
curl -X POST http://localhost:3000/v1/chat \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-request-id" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**Response:**
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "model": "gpt-4",
  "choices": [{ "message": { "role": "assistant", "content": "Hello!" }, "finish_reason": "stop", "index": 0 }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15 }
}
```

## How It Works

Requests pass through three layers before reaching the upstream API:

```
Request → Idempotency (cache check) → Circuit Breaker (fail-fast) → Retry (backoff) → Upstream
```

- **Idempotency** — caches responses by `Idempotency-Key` header for 24h; duplicate requests return the cached result without hitting upstream
- **Circuit Breaker** — after 5 consecutive failures, rejects all requests for 30s (returns `503`) instead of hammering a struggling upstream
- **Retry** — automatically retries `429` and `5xx` responses with exponential backoff: `1s → 2s → 4s`

## Streaming

`llm-shield` forwards streaming requests (`Accept: text/event-stream` or `stream: true` in the body) byte-for-byte to the upstream. The proxy detects streaming on the way in and routes around the buffered middleware stack — chunks reach the client as fast as the upstream produces them.

```bash
curl -N -X POST http://localhost:3000/v1/chat \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Count to 3"}],"stream":true}'
```

**What this means in practice:** the three resilience patterns above (idempotency, circuit breaker, retry) currently apply only to buffered requests. Streaming requests get a clean pass-through. Stream-aware variants of each pattern — record-and-replay idempotency (Redis chunk log + replay), circuit-breaker signals driven by time-to-first-byte, and opt-in resume retry — are on the roadmap.

## Observability

Every request is instrumented so operators can answer "what broke, when, and why?" without attaching a debugger.

- **Structured JSON logs** (via `pino`) on every request and every state transition — one line per event, machine-parseable, pipe-able to Loki / Datadog / any log aggregator.
- **Correlation IDs** on every request. If the client sends `X-Correlation-ID`, it's preserved end-to-end (distributed tracing friendly). Otherwise a UUID is generated. The ID is echoed on the response and included in every log line for that request via `AsyncLocalStorage`.
- **Sentry integration** (optional — set `SENTRY_DSN` to enable). Capture events fire at the real failure points:
  - `circuit_open` — circuit breaker rejected a request
  - `retry_exhausted` — upstream failed all retries
  - `upstream_auth_error` — upstream returned `401`/`403`
  - `slow_request` — request exceeded `SLOW_REQUEST_MS` (default `5000`)
  - `uncaught_exception` / `unhandled_rejection` — process-level handlers

Without a `SENTRY_DSN` set, capture calls are safe no-ops — you still get the structured logs and correlation IDs. Useful in dev and tests.

```bash
# Example log line on a circuit-open event
{"level":40,"time":"2026-04-17T12:00:00.000Z","service":"llm-shield","correlation_id":"7a1c-...","event":"circuit_open","upstream_url":"https://api.openai.com/v1/chat/completions","model":"gpt-4","msg":"circuit is OPEN"}
```

## Stack

- **Runtime:** Node.js 20 + TypeScript
- **Server:** Express
- **State/Cache:** Redis (via ioredis)
- **Tests:** Vitest + Supertest
- **Container:** Docker Compose (Redis)

## Development

```bash
# Start Redis
docker-compose up -d

# Install dependencies
npm install

# Set environment variables
export LLM_UPSTREAM_URL=https://api.openai.com/v1/chat/completions
export LLM_API_KEY=your_key_here

# Start dev server
npm run dev
```

## Tests

```bash
npm test
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_UPSTREAM_URL` | `https://api.openai.com/v1/chat/completions` | Upstream LLM endpoint |
| `LLM_API_KEY` | `''` | Bearer token for upstream API |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `PORT` | `3000` | Server port |
| `LOG_LEVEL` | `info` | pino log level (`trace`\|`debug`\|`info`\|`warn`\|`error`\|`silent`) |
| `SLOW_REQUEST_MS` | `5000` | Requests exceeding this emit a `slow_request` event |
| `SENTRY_DSN` | unset | When set, enables Sentry capture at failure points |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Sentry performance sampling rate (0–1) |
| `RELEASE` | unset | Release tag forwarded to Sentry for source-map correlation |
