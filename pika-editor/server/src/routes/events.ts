import type { FastifyInstance } from 'fastify';
import { events } from '../events.js';

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    });
    reply.raw.write(': hello\n\n');
    events.attach(reply);
    // Heartbeat every 25s so dev proxies don't time out
    const hb = setInterval(() => {
      try { reply.raw.write(': hb\n\n'); } catch { clearInterval(hb); }
    }, 25_000);
    reply.raw.on('close', () => clearInterval(hb));
    return reply;
  });
}
