import type { FastifyInstance } from 'fastify';
import { readTimeline, writeTimeline } from '../state.js';
import { TimelineSchema } from '../schema.js';
import { events } from '../events.js';

export async function timelineRoutes(app: FastifyInstance): Promise<void> {
  app.get('/timeline', async (req, reply) => {
    const { timeline, sha } = readTimeline();
    reply.header('etag', sha);
    return timeline;
  });

  app.put('/timeline', async (req, reply) => {
    const ifMatch = req.headers['if-match'] as string | undefined;
    const { timeline: current, sha: currentSha } = readTimeline();
    if (ifMatch && ifMatch !== currentSha) {
      // Etag mismatch: the server's state has moved since the client
      // last read. Standard HTTP says 409 Precondition Failed, BUT
      // browsers log every 4xx fetch as a red error in DevTools — and
      // this case fires often (every time a background task writes
      // timeline.json between the client's GET and PUT, which is most
      // autosaves during agent activity). The client already handles
      // the conflict body correctly and refetches; the console noise
      // is purely cosmetic but very loud.
      //
      // Return 200 with `conflict: true` in the body so the client's
      // recovery path still runs, but the browser stops red-flagging
      // it. The etag header still carries the server's current sha
      // for the client to adopt.
      reply.header('etag', currentSha);
      return { ok: false, conflict: true, currentSha, current };
    }
    const parsed = TimelineSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation', issues: parsed.error.issues };
    }
    const { sha } = await writeTimeline(parsed.data);
    events.broadcast({ type: 'timeline-changed', sha });
    reply.header('etag', sha);
    return { ok: true, sha };
  });
}
