import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync, createReadStream, statSync, mkdirSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import os from 'node:os';
import { paths, readTimeline, writeTimeline } from '../state.js';
import { TimelineSchema, type Timeline } from '../schema.js';
import { renderTimeline } from '../workers/render-job.js';
import { events } from '../events.js';
import path from 'node:path';

const Body = z.object({
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
  preset: z.enum(['draft', 'standard', 'high']).optional(),
  // Absolute folder to copy the finished mp4 into. `~` expands to home.
  saveDir: z.string().optional(),
  // Output filename (without folder). Defaults to "<project>.mp4".
  filename: z.string().optional(),
});

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}
function sanitizeFilename(n: string): string {
  const cleaned = n.replace(/[/\\:*?"<>|]+/g, '_').trim();
  return cleaned.toLowerCase().endsWith('.mp4') ? cleaned : `${cleaned}.mp4`;
}

export async function renderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/render', async (req, reply) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    const { timeline } = readTimeline();
    const jobId = `r_${Date.now().toString(36)}`;
    const startedAt = new Date().toISOString();
    const fps = parsed.data.fps ?? timeline.fps ?? 24;
    const preset = parsed.data.preset ?? timeline.render?.preset ?? 'standard';
    events.broadcast({ type: 'render-progress', jobId, pct: 0, etaSec: 0 });

    // Add a 'running' entry to lastJobs so the inspector shows it live.
    {
      const { timeline: tl } = readTimeline();
      const next: Timeline = {
        ...tl,
        render: {
          ...tl.render,
          lastJobs: [
            { id: jobId, fps, format: 'mp4' as const, preset, out: '', smooth: false,
              startedAt, finishedAt: null, status: 'running' as const, elapsedSec: 0, errorMessage: null },
            ...(tl.render?.lastJobs ?? []),
          ].slice(0, 20),
        },
      };
      const { sha } = await writeTimeline(TimelineSchema.parse(next));
      events.broadcast({ type: 'timeline-changed', sha });
    }

    renderTimeline(timeline, jobId, parsed.data)
      .then(async ({ outAbs, outRel }) => {
        // If the client asked for a specific destination folder, copy the
        // finished mp4 there. Failures are non-fatal — the file is still
        // available under renders/jobs/, just not at the user's chosen path.
        let savedTo: string | null = null;
        if (parsed.data.saveDir) {
          try {
            const dir = expandHome(parsed.data.saveDir);
            const name = sanitizeFilename(parsed.data.filename || `${timeline.name || 'render'}.mp4`);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const dest = path.join(dir, name);
            await copyFile(outAbs, dest);
            savedTo = dest;
          } catch (err) {
            app.log.warn({ err }, 'render saveDir copy failed');
          }
        }
        events.broadcast({ type: 'render-done', jobId, outRel, savedTo });
        // Mark the job as done in lastJobs.
        const finishedAt = new Date().toISOString();
        const elapsedSec = (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
        const { timeline: tl } = readTimeline();
        const next: Timeline = {
          ...tl,
          render: {
            ...tl.render,
            lastJobs: (tl.render?.lastJobs ?? []).map((j) => j.id === jobId
              ? { ...j, status: 'done', out: outRel, finishedAt, elapsedSec }
              : j),
          },
        };
        const { sha } = await writeTimeline(TimelineSchema.parse(next));
        events.broadcast({ type: 'timeline-changed', sha });
      })
      .catch(async (err: any) => {
        app.log.error({ err }, 'render failed');
        const message = String(err?.message ?? err);
        events.broadcast({ type: 'render-error', jobId, message });
        const finishedAt = new Date().toISOString();
        const elapsedSec = (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
        const { timeline: tl } = readTimeline();
        const next: Timeline = {
          ...tl,
          render: {
            ...tl.render,
            lastJobs: (tl.render?.lastJobs ?? []).map((j) => j.id === jobId
              ? { ...j, status: 'error', finishedAt, elapsedSec, errorMessage: message }
              : j),
          },
        };
        const { sha } = await writeTimeline(TimelineSchema.parse(next));
        events.broadcast({ type: 'timeline-changed', sha });
      });
    return { ok: true, jobId };
  });

  // Stream a rendered MP4 (range-aware) so the client can <video src="...">
  // it directly after render-done.
  app.get<{ Params: { '*': string } }>('/renders/*', async (req, reply) => {
    const rel = (req.params as any)['*'] ?? '';
    const abs = path.join(paths.renders, rel);
    const root = path.resolve(paths.renders);
    if (!path.resolve(abs).startsWith(root + path.sep)) { reply.code(403).send({ error: 'forbidden' }); return; }
    if (!existsSync(abs)) { reply.code(404).send({ error: 'not found' }); return; }
    const stat = statSync(abs);
    const size = stat.size;
    const range = req.headers.range;
    const raw = reply.raw;
    raw.setHeader('accept-ranges', 'bytes');
    raw.setHeader('content-type', 'video/mp4');
    reply.hijack();
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        raw.statusCode = 206;
        raw.setHeader('content-range', `bytes ${start}-${end}/${size}`);
        raw.setHeader('content-length', String(end - start + 1));
        createReadStream(abs, { start, end }).on('error', () => raw.end()).pipe(raw);
        return;
      }
    }
    raw.statusCode = 200;
    raw.setHeader('content-length', String(size));
    createReadStream(abs).on('error', () => raw.end()).pipe(raw);
  });

  // POST /reveal { rel?, abs? } — macOS-only: open the parent folder of an
  // output in Finder, with the file selected. `rel` is resolved under the
  // project; `abs` is taken as-is (used when the render was copied to a
  // user-chosen folder outside the project tree). Falls through silently on
  // other OS.
  app.post<{ Body: { rel?: string; abs?: string } }>('/reveal', async (req, reply) => {
    const { rel, abs: absIn } = req.body ?? {};
    const target = absIn ? expandHome(absIn) : rel ? path.join(paths.project, rel) : null;
    if (!target) { reply.code(400); return { error: 'rel or abs required' }; }
    if (!existsSync(target)) { reply.code(404); return { error: 'not found' }; }
    if (process.platform === 'darwin') {
      spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [path.dirname(target)], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true };
  });
}
