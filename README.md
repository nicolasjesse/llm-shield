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
