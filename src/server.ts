import express from 'express';
import { idempotencyMiddleware } from './idempotency';
import { proxyRequest } from './proxy';
import { closeRedis } from './redis';
import type { ChatRequest } from './types';

export const app = express();

app.use(express.json());
app.use(idempotencyMiddleware());

app.post('/v1/chat', async (req, res) => {
  const body = req.body as ChatRequest;

  if (!body.model || !body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: 'model and messages are required' });
    return;
  }

  const result = await proxyRequest(body);
  res.status(result.status).json(result.data);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await closeRedis();
  process.exit(0);
});

if (require.main === module) {
  const PORT = parseInt(process.env.PORT ?? '3000');
  app.listen(PORT, () => {
    console.log(`LLM Shield running on port ${PORT}`);
  });
}
