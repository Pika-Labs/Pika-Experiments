/**
 * Plan — the durable "production bible" for the project.
 *
 * Where Workspace is the agent's ephemeral working canvas (rewritten on every
 * turn), Plan only changes when a decision is LOCKED — the user has explicitly
 * approved a workspace proposal and it becomes canonical.
 *
 * Source of truth: projects/<active>/plan.json. The schema is permissive on
 * purpose — the shape evolves as projects grow. We validate just enough to
 * keep the editor from crashing on malformed data.
 *
 *   GET /plan/state  → current plan.json (or {} if not yet written)
 *   PUT /plan/state  → atomic write (used by the agent's update_plan tool)
 */
import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../state.js';
import { events } from '../events.js';

function planPath(): string {
  return path.join(paths.project, 'plan.json');
}

export async function planRoutes(app: FastifyInstance): Promise<void> {
  app.get('/plan/state', async () => {
    const p = planPath();
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      app.log.warn({ err: String((err as Error)?.message ?? err) }, 'plan.json parse failed');
      return {};
    }
  });

  app.put('/plan/state', async (req, reply) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      reply.code(400);
      return { error: 'plan body must be an object' };
    }
    const file = planPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const stamped = { ...body, updatedAt: new Date().toISOString() };
    writeFileSync(tmp, JSON.stringify(stamped, null, 2) + '\n');
    renameSync(tmp, file);
    events.broadcast({ type: 'asset-added', relPath: 'plan.json' });
    return { ok: true };
  });
}
