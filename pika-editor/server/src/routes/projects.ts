/**
 * Project picker — list sibling project directories under the same parent
 * as the currently-active project, and switch the server's active project
 * live without restart. `setProject` mutates `paths` in place; every
 * subsequent route + worker call reads the new directory paths.
 *
 * Discovery rule: any subdir of `<projects-root>` containing a
 * timeline.json OR storyboard.json is a candidate.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readdirSync, existsSync, statSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import path from 'node:path';
import { paths, setProject, ProjectLockedError } from '../state.js';
import { events } from '../events.js';
import { startWatcher } from '../watcher.js';
import { AspectSchema, ResolutionSchema, type Aspect, type Resolution } from '../schema.js';

export function slugify(s: string): string {
  return s.trim().toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'untitled';
}

export function emptyTimelineJson(name: string, aspect: Aspect, resolution: Resolution, fps: 24 | 30 | 60): string {
  return JSON.stringify({
    version: 2,
    name,
    aspect,
    resolution,
    fps,
    duration: 30,
    bpm: null,
    downbeats: [],
    beats: [],
    music: null,
    sfx: { gain: 0, clips: [] },
    tracks: [
      { id: 'v1', kind: 'video', clips: [] },
      { id: 'v2', kind: 'overlay', clips: [] },
    ],
    scenes: [],
    floatingComments: [],
    render: { preset: 'standard', lastJobs: [] },
  }, null, 2) + '\n';
}

interface ProjectEntry {
  name: string;
  displayName: string;
  dir: string;
  active: boolean;
  openedAt: number;          // ms since epoch (mtime of timeline.json)
  aspect: string;
  resolution: string;
  fps: number;
  clipCount: number;
}

export function listProjects(): ProjectEntry[] {
  const root = path.dirname(paths.project);
  const entries = readdirSync(root).filter((name) => !name.startsWith('.'));
  const out: ProjectEntry[] = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const tlPath = path.join(dir, 'timeline.json');
    if (!existsSync(tlPath)) continue;
    let tl: any = null;
    try { tl = JSON.parse(readFileSync(tlPath, 'utf8')); } catch { /* ignore parse errors */ }
    const st = statSync(tlPath);
    const clipCount = (tl?.tracks ?? []).reduce((s: number, tr: any) => s + (tr?.clips?.length ?? 0), 0);
    out.push({
      name,
      displayName: tl?.name ?? name,
      dir,
      active: dir === paths.project,
      openedAt: st.mtimeMs,
      aspect: tl?.aspect ?? '16:9',
      resolution: tl?.resolution ?? '1080p',
      fps: tl?.fps ?? 24,
      clipCount,
    });
  }
  // Sort by latest-opened (most recent first). Active project gets pinned
  // to the top regardless so the user always sees what they're working on.
  out.sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    return b.openedAt - a.openedAt;
  });
  return out;
}

// Touch timeline.json mtime so the "latest opened" sort picks this project
// up next time we list. Cheap; doesn't actually rewrite the file.
export function touchProject(dir: string): void {
  const tl = path.join(dir, 'timeline.json');
  if (!existsSync(tl)) return;
  const now = new Date();
  try { utimesSync(tl, now, now); } catch { /* ignore — sort just won't update */ }
}

export async function projectsListRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', async () => {
    return { activeDir: paths.project, projects: listProjects() };
  });

  // Create a new project. Aspect / resolution / fps are locked at creation
  // — they shape the canvas + render output, so changing them mid-project
  // would invalidate every clip already on the timeline. To change them,
  // make a new project.
  const CreateBody = z.object({
    name: z.string().min(1),
    aspect: AspectSchema.default('16:9'),
    resolution: ResolutionSchema.default('1080p'),
    fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(24),
  });
  app.post('/projects', async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    const { name, aspect, resolution, fps } = parsed.data;
    const root = path.dirname(paths.project);
    let dirName = slugify(name);
    let candidate = path.join(root, dirName);
    let n = 2;
    while (existsSync(candidate)) {
      candidate = path.join(root, `${dirName}-${n}`);
      n++;
    }
    mkdirSync(candidate, { recursive: true });
    writeFileSync(path.join(candidate, 'timeline.json'), emptyTimelineJson(name, aspect, resolution, fps));
    try {
      setProject(candidate);
    } catch (err) {
      if (err instanceof ProjectLockedError) {
        reply.code(409);
        return { error: 'project locked', message: err.message, holderPid: err.holderPid };
      }
      throw err;
    }
    startWatcher();
    events.broadcast({ type: 'project-changed', dir: paths.project, name: path.basename(paths.project) });
    return { ok: true, dir: candidate, name: path.basename(candidate), displayName: name, aspect, resolution, fps };
  });

  // Switch the active project. Body accepts either { dir } (absolute path)
  // or { name } (relative name under the projects root). Re-points the
  // watcher and broadcasts `project-changed` so connected clients reload.
  app.post<{ Body: { dir?: string; name?: string } }>('/projects/select', async (req, reply) => {
    const { dir, name } = req.body ?? {};
    let target = dir;
    if (!target && name) {
      target = path.join(path.dirname(paths.project), name);
    }
    if (!target) {
      reply.code(400);
      return { error: 'must supply { dir } or { name }' };
    }
    const abs = path.resolve(target);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      reply.code(404);
      return { error: `project dir not found: ${abs}` };
    }
    if (!existsSync(path.join(abs, 'timeline.json'))) {
      reply.code(400);
      return { error: 'directory has no timeline.json' };
    }
    try {
      setProject(abs);
    } catch (err) {
      if (err instanceof ProjectLockedError) {
        reply.code(409);
        return { error: 'project locked', message: err.message, holderPid: err.holderPid };
      }
      throw err;
    }
    touchProject(abs);   // bump mtime so this project rises in the recency sort
    startWatcher();
    events.broadcast({ type: 'project-changed', dir: paths.project, name: path.basename(paths.project) });
    return { ok: true, activeDir: paths.project, name: path.basename(paths.project) };
  });

  // Delete a project — wipes the entire directory + every asset, render,
  // version-history git, .agent memory. Irreversible. Human-only action;
  // the agent has no tool for this on purpose (deleting work via voice
  // command is too risky).
  //
  // Safety rails:
  //   - body { name } is REQUIRED and `confirm: true` is REQUIRED — no
  //     accidental DELETEs from a misclicked toolbar.
  //   - the project must live UNDER the projects root (same parent as
  //     the currently-active project). No `..` escapes, no absolute
  //     paths outside the workspace.
  //   - if the project being deleted is the currently-active one, the
  //     server picks the next-most-recent project to switch to. If none
  //     exists, the response signals the UI to show "no projects" state.
  app.post<{ Body: { name?: string; confirm?: boolean } }>('/projects/delete', async (req, reply) => {
    const { name, confirm } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      reply.code(400);
      return { error: 'name is required' };
    }
    if (confirm !== true) {
      reply.code(400);
      return { error: 'confirm: true is required to delete a project' };
    }
    const root = path.dirname(paths.project);
    const target = path.resolve(root, name);
    // Boundary check — the resolved target MUST live under the projects
    // root. Stops `name="../foo"` from blasting something outside.
    if (path.dirname(target) !== root) {
      reply.code(400);
      return { error: 'project must live directly under the projects root' };
    }
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      reply.code(404);
      return { error: `no project named "${name}"` };
    }
    const wasActive = target === paths.project;
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? 'delete failed' };
    }
    // If we just nuked the active project, switch to the next remaining
    // one (most-recent-mtime). If none are left, leave paths.project
    // pointing at the deleted dir; the client will see no projects on
    // the next list and can prompt to create a new one.
    let activated: string | null = null;
    if (wasActive) {
      const remaining = listProjects(); // safe — uses dirname(paths.project) which is the unchanged root
      if (remaining.length > 0) {
        const next = remaining[0]; // newest first
        setProject(next.dir);
        startWatcher();
        activated = next.name;
        events.broadcast({ type: 'project-changed', dir: paths.project, name: path.basename(paths.project) });
      }
    }
    return { ok: true, deleted: name, wasActive, activated };
  });
}
