import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TimelineSchema, type Timeline } from './schema.js';
import { events } from './events.js';
import { FileActor } from './file-actor.js';

// Default project: ../../projects/untitled-project relative to this file
// (i.e. PikaAgentEditor/server/src → PikaAgentEditor/projects/...). Override
// at boot with PIKA_EDITOR_PROJECT env var, OR switch live via setProject() —
// `paths` is a mutable singleton so every consumer sees the new directories
// without restart.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT = path.resolve(HERE, '../../projects/untitled-project');
const SERVER_PORT = process.env.PIKA_EDITOR_PORT ?? '3080';
// Per-port last-project file so a second server (e.g. :3082) remembers its
// own active project independently — without this, both servers race on the
// same file and end up booting to the same project, tripping the lock.
const LAST_PROJECT_FILE = path.resolve(HERE, `../../.last-project-${SERVER_PORT}`);
// Legacy single-server file — read as fallback so users who upgrade keep
// their last project on the primary :3080 server.
const LEGACY_LAST_PROJECT_FILE = path.resolve(HERE, '../../.last-project');

function readLastProject(): string | null {
  const tryPath = (lp: string): string | null => {
    if (!existsSync(lp)) return null;
    try {
      const p = readFileSync(lp, 'utf8').trim();
      if (!p) return null;
      if (!existsSync(p)) return null;
      if (!existsSync(path.join(p, 'timeline.json'))) {
        console.warn(`[state] last-project ${p} has no timeline.json — keeping it anyway (probably mid-edit)`);
        return p;
      }
      return p;
    } catch {
      return null;
    }
  };
  return tryPath(LAST_PROJECT_FILE) ?? (SERVER_PORT === '3080' ? tryPath(LEGACY_LAST_PROJECT_FILE) : null);
}

function saveLastProject(dir: string): void {
  try { writeFileSync(LAST_PROJECT_FILE, dir); } catch { /* ignore */ }
}

// Project lock — `.pae-server.lock` inside each project directory holds the
// PID of the server currently editing it. Stops two servers (e.g. :3080 and
// :3082) from autosave-racing on the same `timeline.json`. Stale locks
// (process gone) are silently reclaimed via `process.kill(pid, 0)` probes.
const lockPath = (projectDir: string) => path.join(projectDir, '.pae-server.lock');

function readLockPid(projectDir: string): number | null {
  const lp = lockPath(projectDir);
  if (!existsSync(lp)) return null;
  try {
    const pid = parseInt(readFileSync(lp, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function lockHolderIsAlive(pid: number): boolean {
  if (pid === process.pid) return false; // our own lock — not a foreign holder
  try {
    process.kill(pid, 0); // signal 0 = existence probe
    return true;
  } catch {
    return false; // ESRCH (dead) or EPERM (alive but not ours — treat as alive)
  }
}

function acquireLock(projectDir: string): void {
  try {
    writeFileSync(lockPath(projectDir), String(process.pid));
  } catch (err) {
    console.warn(`[state] could not write lock for ${projectDir}:`, err);
  }
}

function releaseLock(projectDir: string): void {
  if (!projectDir) return;
  const lp = lockPath(projectDir);
  if (!existsSync(lp)) return;
  try {
    const pid = readLockPid(projectDir);
    if (pid === process.pid) unlinkSync(lp);
  } catch { /* ignore */ }
}

// Best-effort lock cleanup on shutdown. The lock file lives inside the
// project dir, so if the process dies without running this, the next boot's
// stale-PID probe will reclaim it anyway — this just keeps the filesystem
// tidy.
process.on('exit',    () => { releaseLock(paths.project); });
process.on('SIGINT',  () => { releaseLock(paths.project); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(paths.project); process.exit(0); });

export const paths = {
  project: '',
  timeline: '',
  assets: '',
  comments: '',
  beats: '',
  renders: '',
};

export class ProjectLockedError extends Error {
  constructor(public projectDir: string, public holderPid: number) {
    super(`Project ${projectDir} is locked by another running server (pid ${holderPid}). Switch the other server to a different project first, or close it.`);
    this.name = 'ProjectLockedError';
  }
}

export function setProject(dir: string): void {
  const abs = path.resolve(dir);
  // Same project — nothing to do; preserves idempotent re-set.
  if (abs === paths.project) return;
  // Block if another live server holds the lock. Stale locks (dead PID)
  // are reclaimed automatically.
  const existingPid = readLockPid(abs);
  if (existingPid !== null && existingPid !== process.pid && lockHolderIsAlive(existingPid)) {
    throw new ProjectLockedError(abs, existingPid);
  }
  // Drop the lock on the project we're leaving before claiming the new one.
  if (paths.project) releaseLock(paths.project);
  paths.project  = abs;
  paths.timeline = path.join(abs, 'timeline.json');
  paths.assets   = path.join(abs, 'assets');
  paths.comments = path.join(abs, 'comments.md');
  paths.beats    = path.join(abs, 'beats.json');
  paths.renders  = path.join(abs, 'renders');
  const subdirs = [
    paths.assets,
    paths.renders,
    path.join(paths.assets, 'pika'),     // agent-generated videos
    path.join(paths.assets, 'imports'),  // user-uploaded videos
    path.join(paths.assets, 'sfx'),
    path.join(paths.assets, 'music'),
  ];
  for (const p of subdirs) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
  acquireLock(abs);
  saveLastProject(abs);
  // Re-init the GenJob log for the new project so the in-memory state
  // map reflects this project's history (Phase 1). Lazy-imported to
  // avoid circular import with the GenJob module which depends on
  // state.ts for `paths`.
  void import('./agent/gen-jobs.js')
    .then((m) => m.reinitGenJobsForProject())
    .catch((err: unknown) => console.warn('[state] gen-jobs reinit failed:', (err as Error)?.message ?? err));
}

/**
 * First-boot bootstrap: write an empty but schema-valid timeline.json +
 * a welcoming workspace.json if either is missing. Without this, a
 * fresh clone (which gitignores `projects/`) has nothing to boot from
 * and readTimeline() throws. Idempotent — only writes when the target
 * files don't already exist, so re-running never clobbers user state.
 *
 * Embedded as constants here rather than committed as starter files so
 * (a) the .gitignore stays simple, (b) the schema can evolve without
 * stale template files in the repo, (c) user edits go to their own
 * untracked working copy.
 */
function ensureProjectScaffold(dir: string): void {
  const timelinePath = path.join(dir, 'timeline.json');
  if (!existsSync(timelinePath)) {
    const projectName = path.basename(dir).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const starter = {
      version: 2,
      name: projectName,
      aspect: '16:9',
      resolution: '1080p',
      fps: 24,
      duration: 0,
      bpm: null,
      downbeats: [],
      beats: [],
      music: null,
      sfx: { clips: [] },
      audioTracks: [{ id: 'a1', label: null, gain: 0, clips: [] }],
      tracks: [
        { id: 'v1', kind: 'video',   label: null, clips: [] },
        { id: 'v2', kind: 'overlay', label: null, clips: [] },
      ],
      scenes: [],
      floatingComments: [],
      captions: { enabled: true, defaultStyle: {}, rows: [] },
      render: { preset: 'standard', lastJobs: [] },
    };
    writeFileSync(timelinePath, JSON.stringify(starter, null, 2) + '\n');
    console.log(`[state] scaffolded empty timeline.json at ${timelinePath}`);
  }
  const workspacePath = path.join(dir, 'workspace.json');
  if (!existsSync(workspacePath)) {
    const welcome = {
      generatedAt: new Date().toISOString(),
      phase: 'Welcome',
      headline: 'Empty project — ready when you are',
      subhead: 'Drop a video on the timeline, or tell the agent what to make.',
      body: 'This is a fresh **PikaAgentEditor** project. The agent is on the right — describe a video idea, ask for storyboards, or drag a clip into the timeline to start.',
      primary: { kind: 'none', items: [] },
      ask: 'What are we making?',
      activity: [],
    };
    writeFileSync(workspacePath, JSON.stringify(welcome, null, 2) + '\n');
    console.log(`[state] scaffolded empty workspace.json at ${workspacePath}`);
  }
}

{
  // Boot priority: last-project.txt FIRST (user's most recent explicit
  // selection), then env (first-boot pin / dev override), then default.
  // Before this order, env won over file — meaning a refresh always
  // jumped back to the env-pinned project regardless of which one the
  // user had switched to since boot. Reversed: switches now stick.
  const fromFile = readLastProject();
  const fromEnv = process.env.PIKA_EDITOR_PROJECT;
  const candidates: Array<{ dir: string; source: string }> = [];
  if (fromFile) candidates.push({ dir: fromFile, source: 'file'    });
  if (fromEnv)  candidates.push({ dir: fromEnv,  source: 'env'     });
  candidates.push({ dir: DEFAULT_PROJECT, source: 'default' });

  let booted = false;
  for (const { dir, source } of candidates) {
    console.log(`[state] boot project (trying): ${dir} (source: ${source})`);
    try {
      setProject(dir);
      console.log(`[state] boot project: ${dir} (source: ${source})`);
      booted = true;
      break;
    } catch (err) {
      if (err instanceof ProjectLockedError) {
        console.warn(`[state] ${dir} locked by pid ${err.holderPid} — trying next candidate`);
        continue;
      }
      throw err;
    }
  }
  if (!booted) {
    // Last resort — DEFAULT_PROJECT was also locked. Operate without a lock
    // so the server still boots; the user can switch via the UI. Risk of
    // same-project autosave race, but better than crash-looping the second
    // server.
    console.warn(`[state] all boot candidates locked — operating without lock on ${DEFAULT_PROJECT}`);
    paths.project = path.resolve(DEFAULT_PROJECT);
    paths.timeline = path.join(paths.project, 'timeline.json');
    paths.assets   = path.join(paths.project, 'assets');
    paths.comments = path.join(paths.project, 'comments.md');
    paths.beats    = path.join(paths.project, 'beats.json');
    paths.renders  = path.join(paths.project, 'renders');
  }
  // First-boot bootstrap — writes a starter timeline.json + workspace.json
  // if absent. Idempotent on subsequent boots. Without this, a fresh
  // clone of the repo (which gitignores `projects/`) has nothing to
  // read and readTimeline() throws on the first request.
  ensureProjectScaffold(paths.project);
}

export function readTimeline(): { timeline: Timeline; sha: string } {
  if (!existsSync(paths.timeline)) {
    throw new Error(`timeline.json not found at ${paths.timeline}.`);
  }
  const raw = readFileSync(paths.timeline, 'utf8');
  const parsed = JSON.parse(raw);
  migrateLegacyCaptionPositions(parsed);
  migrateOrphanReadyScenes(parsed);
  const timeline = TimelineSchema.parse(parsed);
  return { timeline, sha: sha256(raw) };
}

/**
 * Migration: any pika-gen scene with status='ready' and videoSrc=null is in
 * an invalid post-schema-tightening state. The new schema requires
 * status='ready' ⟹ videoSrc != null. Demote these to 'pending' so they can
 * be regenerated cleanly. Idempotent (only acts on the invalid combo).
 *
 * Why this exists: prior versions had a bug where the auto-bind PATCHed
 * status='ready' but never wrote videoSrc (the `isVideo` regex was broken).
 * Without this migration, those scenes would now fail schema validation on
 * load. Demotion preserves the user's project; they'll see the scene as
 * pending and can re-fire the gen.
 */
function migrateOrphanReadyScenes(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const tl = raw as Record<string, unknown>;
  const scenes = tl.scenes;
  if (!Array.isArray(scenes)) return;
  let demoted = 0;
  for (const s of scenes) {
    if (!s || typeof s !== 'object') continue;
    const sc = s as Record<string, unknown>;
    if (sc.kind === 'pika-gen' && sc.status === 'ready' && (sc.videoSrc === null || sc.videoSrc === undefined)) {
      sc.status = 'pending';
      demoted += 1;
    }
  }
  if (demoted > 0) {
    console.warn(`[state] migrated ${demoted} orphan ready+null scene(s) back to pending`);
  }
}

// Caption position is locked to a single TRACK-level value (caps.defaultStyle).
// Two things happen here:
//   1. Legacy CaptionStyle.position (top/mid/bottom) → xPct/yPct on the
//      defaultStyle so historical projects keep their author-set position.
//   2. Per-row xPct/yPct overrides are STRIPPED from every row. Position is
//      a global property of the caption track now; allowing per-row pins
//      caused user-reported drift where dragging would only move some
//      captions. The strip is idempotent so it's safe to re-run.
function migrateLegacyCaptionPositions(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const tl = raw as Record<string, unknown>;
  const caps = tl.captions as Record<string, unknown> | undefined;
  if (!caps) return;
  const ds = caps.defaultStyle as Record<string, unknown> | undefined;
  if (ds) {
    if (typeof ds.position === 'string' && ds.xPct === undefined && ds.yPct === undefined) {
      ds.xPct = 50;
      ds.yPct = ds.position === 'top' ? 8 : ds.position === 'mid' ? 50 : 92;
    }
    delete ds.position;
  }
  const rows = caps.rows as Array<Record<string, unknown>> | undefined;
  for (const r of rows ?? []) {
    const st = r.style as Record<string, unknown> | null | undefined;
    if (!st || typeof st !== 'object') continue;
    delete st.position;
    delete st.xPct;
    delete st.yPct;
    delete st.align;
    // Collapse style:{} → style:null so the panel doesn't show a spurious
    // "0 overrides" badge.
    if (Object.keys(st).length === 0) r.style = null;
  }
}

/**
 * The single owner of timeline.json on disk. All writes go through this.
 * Caller passes a pure fn that computes the next state; the actor serializes,
 * validates against TimelineSchema, atomically writes, and broadcasts SSE.
 *
 * NEVER do network/ffmpeg/long awaits inside `fn`. Pre-compute everything
 * you need OUTSIDE the actor, then pass a delta-applying fn in.
 */
export const timelineActor = new FileActor<Timeline>({
  filePath: () => paths.timeline,
  parse: (raw) => {
    const parsed = JSON.parse(raw);
    migrateLegacyCaptionPositions(parsed);
    migrateOrphanReadyScenes(parsed);
    return TimelineSchema.parse(parsed);
  },
  serialize: (tl) => {
    // Validate on the way out too — defense in depth against fn returning
    // an invalid shape. Throws before the file gets clobbered.
    TimelineSchema.parse(tl);
    return JSON.stringify(tl, null, 2) + '\n';
  },
  initial: () => { throw new Error(`timeline.json not found at ${paths.timeline}`); },
  onCommit: () => {
    // The watcher will also fire (we leave it as a backstop for external
    // edits), but its 120ms stability window can drop events under bursts.
    // Direct broadcast guarantees the client sees every commit.
    const raw = readFileSync(paths.timeline, 'utf8');
    events.broadcast({ type: 'timeline-changed', sha: sha256(raw) });
  },
});

export const workspaceActor = new FileActor<unknown>({
  filePath: () => path.join(paths.project, 'workspace.json'),
  parse: (raw) => JSON.parse(raw),
  serialize: (doc) => JSON.stringify(doc, null, 2) + '\n',
  initial: () => ({}),
  onCommit: () => {
    events.broadcast({ type: 'asset-added', relPath: 'workspace.json' });
  },
});

/**
 * Mutate timeline.json through the actor. The fn MUST be synchronous-ish:
 * compute the next state, return it + any result the caller wants. Long-
 * running work (Pika polling, ffmpeg, fetch) must happen BEFORE this call.
 */
export async function mutateTimeline<R>(
  fn: (cur: Timeline) => { next: Timeline; result: R },
): Promise<R> {
  return timelineActor.mutate(fn);
}

/**
 * Mutate workspace.json through the actor. Same rules as mutateTimeline.
 */
export async function mutateWorkspace<R>(
  fn: (cur: any) => { next: any; result: R },
): Promise<R> {
  return workspaceActor.mutate(fn);
}

/**
 * Whole-document timeline write. Goes through the actor for serialization
 * but accepts an already-computed next-state (no diff function). Use this
 * when the caller already has the full timeline in hand.
 */
export async function writeTimeline(timeline: Timeline): Promise<{ sha: string }> {
  return timelineActor.mutate((_cur) => {
    // Validate the new state before commit. Throws inside the actor,
    // caller's Promise rejects.
    TimelineSchema.parse(timeline);
    const json = JSON.stringify(timeline, null, 2) + '\n';
    return { next: timeline, result: { sha: sha256(json) } };
  });
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function readComments(): string {
  if (!existsSync(paths.comments)) return '';
  return readFileSync(paths.comments, 'utf8');
}

export function appendComment(block: { scene: string; at: number; selector: string | null; note: string }): void {
  const text = `\n# ${block.scene} @ ${block.at}s\nselector: ${block.selector ?? '(unspecified)'}\nnote: ${block.note.replace(/\n+/g, ' ')}\n`;
  const existing = readComments();
  const out = existing.length === 0
    ? `# Comments\n\n> Append blocks below. \`# clip_NN @ Ts\` then \`selector:\` and \`note:\`.\n\n${text}`
    : existing + text;
  writeFileSync(paths.comments, out);
}

export function projectExists(): boolean {
  return existsSync(paths.project);
}

export function statFile(rel: string): { size: number; mtime: number } | null {
  const file = path.join(paths.project, rel);
  if (!existsSync(file)) return null;
  const s = statSync(file);
  return { size: s.size, mtime: s.mtimeMs };
}

/**
 * Whole-document workspace.json write. Goes through workspaceActor so it
 * can't race with other writers. Use mutateWorkspace if you want to
 * compute a delta against the current on-disk state; use this only when
 * the caller already has the full doc in hand (e.g. the agent's
 * `write_workspace` tool, which sends a complete document).
 */
export async function writeWorkspaceAtomic(doc: unknown): Promise<void> {
  await workspaceActor.mutate((_cur) => ({ next: doc, result: undefined as void }));
}
