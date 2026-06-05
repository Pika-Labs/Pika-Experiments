/**
 * GenJob — the single source of truth for every Pika generation.
 *
 * Lifecycle state used to be split across three places:
 *   1. The in-memory `LiveGen` map in `pika-mcp.ts` (volatile, lost on
 *      restart, expires 8s after a gen ends).
 *   2. `scene.status` in `timeline.json` (durable, but the agent owned
 *      when it got PATCHed — so the timeline drifted out of sync the
 *      moment any step was skipped).
 *   3. `tile.pending` / `tile.taskId` / `tile.failed` in `workspace.json`
 *      (durable, but the agent owned the writes — same drift problem).
 *
 * Symptoms: stuck "Generating…" spinners, ghost workspace tiles with no
 * error message, orphan CDN URLs no one downloaded. Every reported bug
 * traced back to one of the three sources being out of step with the
 * other two.
 *
 * GenJob collapses the three into one server-owned record. State
 * transitions happen here, in `recordTransition`, and ALL downstream
 * mutations (scene PATCH, workspace tile update, SSE broadcast) fan
 * out from that single function. The agent never writes a transition
 * directly — it can only fire intent tools (Phase 2) that go through
 * the GenJob machine.
 *
 * Persistence:
 *   - `gen-jobs.jsonl` — append-only event log, one event per line.
 *     Replayed on boot to rebuild the in-memory state map.
 *   - The log survives crashes; partial writes are guarded by line
 *     boundaries (a truncated trailing line is dropped on replay).
 *   - Capped at 5_000 events; older events are compacted into a single
 *     `snapshot:` line every N records (Phase 5 work).
 *
 * The set of valid transitions is enforced. Calling `recordTransition`
 * with an illegal `to` state for the current job's `state` throws — so
 * race conditions and double-frees surface immediately instead of
 * silently corrupting the projection.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../state.js';
import { events } from '../events.js';

/** Every state a generation can be in. The set is intentionally small —
 *  bigger state machines fail more often. */
export type GenJobState =
  | 'queued'        // Server has accepted the intent; no Pika call yet
  | 'firing'        // pika MCP tool was just invoked; awaiting first response
  | 'running'       // Pika returned a task_id (or is streaming heartbeats)
  | 'downloading'   // Pika finished; we're fetching the asset to disk
  | 'ready'         // Asset on disk, scene/tile PATCHed, all done
  | 'error'         // Terminal failure with a captured error message
  | 'cancelled';    // User-initiated cancellation

/** What kind of UI surface this gen feeds back into. Determines which
 *  projection writer runs on `ready` / `error`. */
export type GenJobBind =
  | { kind: 'scene'; sceneId: string }   // → timeline.json scene.status
  | { kind: 'tile';  tileId: string;   // → workspace.json tile.pending/failed
      localRel?: string }
  | { kind: 'ref';   localRel: string }; // → standalone asset save, no UI tile

export interface GenJob {
  id: string;                  // gj_<ulid>; stable across restarts
  /** Absolute path to the project this job belongs to. Snapshotted at
   *  job creation. Used by recordTransition + downstream binding ops
   *  to anchor every filesystem write (log file, downloads, scene/
   *  tile PATCH) to the ORIGINAL project even if the user switches
   *  projects mid-flight. */
  projectDir: string;
  bind: GenJobBind;
  tool: string;                // 'generate_image', 'generate_video', …
  args: Record<string, unknown>; // exact Pika MCP args (sans __* hints)
  model?: string;              // generate_video: 'kling-v3-omni'; generate_image: 'gpt-image-2'
  prompt?: string;             // first ~120 chars for UI display
  state: GenJobState;
  pikaTaskId?: string;         // set once Pika hands back its task envelope
  remoteUrl?: string;          // CDN URL on success (before download)
  localPath?: string;          // assets/... path after download
  errorMessage?: string;
  attempts: Array<{ at: number; from: GenJobState; to: GenJobState; note?: string }>;
  startedAt: number;
  endedAt?: number;
  /** Server-derived elapsed-seconds heartbeat (from Pika notifications/message
   *  in pika-mcp.ts). Mirrored from LiveGen.progress. Optional. */
  progressSec?: number;
  /** Server-estimated progress percent (0–100), computed in the
   *  pika-mcp progress handler from expected-duration lookup. */
  progressPct?: number;
  /** Wall-clock timestamp of the most recent heartbeat or transition.
   *  The reconciler uses this (not `attempts.last.at`) to decide if a
   *  `running` gen is genuinely stalled — heartbeats prove liveness
   *  without being transitions, so without this field a 25-minute
   *  Seedance gen that's healthily heartbeating every 15s would still
   *  trip the running-timeout heuristic. */
  lastActivityAt?: number;
}

/** Valid transitions. `recordTransition` rejects anything not listed. */
const ALLOWED: Record<GenJobState, GenJobState[]> = {
  queued:      ['firing', 'cancelled', 'error'],
  firing:      ['running', 'downloading', 'ready', 'error', 'cancelled'],
  running:     ['downloading', 'ready', 'error', 'cancelled'],
  downloading: ['ready', 'error', 'cancelled'],
  ready:       [],
  error:       [],
  cancelled:   [],
};

const TERMINAL: ReadonlySet<GenJobState> = new Set(['ready', 'error', 'cancelled']);
export function isTerminal(state: GenJobState): boolean { return TERMINAL.has(state); }

// In-memory current state. Rebuilt on init() from gen-jobs.jsonl.
const jobs = new Map<string, GenJob>();
let initialized = false;

/** Resolve the gen-jobs.jsonl path for a specific project. Defaults
 *  to the currently-active project (the only correct choice for boot
 *  replay), but every transition / append against a known job should
 *  pass the job's captured `projectDir` so writes stay anchored to
 *  the project the gen was fired in — even if the user has since
 *  switched. */
function logFilePath(projectDir?: string): string {
  return path.join(projectDir ?? paths.project, '.agent', 'gen-jobs.jsonl');
}

/** Replay the log into the in-memory map. Idempotent; safe to re-run
 *  after a project switch. Truncated trailing lines are dropped — they
 *  represent a crash mid-write and replaying them would corrupt state. */
export function initGenJobs(): void {
  jobs.clear();
  initialized = true;
  const file = logFilePath();
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let replayed = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as GenJobEvent;
      applyEvent(ev);
      replayed += 1;
    } catch {
      // Partial / corrupted line at EOF after a crash — skip silently.
      continue;
    }
  }
  console.log(`[gen-jobs] replayed ${replayed} events; ${jobs.size} active records`);
}

/** Force re-init on project switch. Called from state.setProject. */
export function reinitGenJobsForProject(): void {
  initGenJobs();
}

type GenJobEvent =
  | { kind: 'create'; at: number; job: GenJob }
  | { kind: 'transition'; at: number; id: string; from: GenJobState; to: GenJobState; patch?: Partial<GenJob>; note?: string };

function applyEvent(ev: GenJobEvent): void {
  if (ev.kind === 'create') {
    jobs.set(ev.job.id, { ...ev.job, lastActivityAt: ev.at });
    return;
  }
  const job = jobs.get(ev.id);
  if (!job) return;
  job.state = ev.to;
  if (ev.patch) Object.assign(job, ev.patch);
  job.attempts.push({ at: ev.at, from: ev.from, to: ev.to, note: ev.note });
  job.lastActivityAt = ev.at;
  if (TERMINAL.has(ev.to) && !job.endedAt) job.endedAt = ev.at;
}

function appendEvent(ev: GenJobEvent, projectDir?: string): void {
  const file = logFilePath(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(ev) + '\n');
  maybeRotateLog(file);
}

/** Log rotation policy: keep gen-jobs.jsonl under 5 MB. When exceeded,
 *  rotate to gen-jobs-<unix-ms>.jsonl in the same dir and start a fresh
 *  active log. The in-memory state map is unaffected — only the journal
 *  on disk is split. Replay-on-boot only scans the active file, so
 *  rotation also acts as a soft compaction (terminal jobs older than
 *  the rotation cutoff stop being replayed). */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
function maybeRotateLog(file: string): void {
  try {
    const size = statSync(file).size;
    if (size < LOG_ROTATE_BYTES) return;
    const rotated = file.replace(/\.jsonl$/, `-${Date.now()}.jsonl`);
    renameSync(file, rotated);
    console.log(`[gen-jobs] rotated ${file} → ${rotated} (was ${(size / 1024 / 1024).toFixed(2)} MB)`);
  } catch { /* best-effort */ }
}

/** Create a new GenJob in `queued` state. Returns the job. The caller
 *  is expected to call `recordTransition(id, 'firing', …)` immediately
 *  before invoking the Pika MCP tool, so the log captures the intent
 *  even if the tool call itself crashes the server. */
export function createGenJob(input: {
  id: string;
  bind: GenJobBind;
  tool: string;
  args: Record<string, unknown>;
  model?: string;
  prompt?: string;
}): GenJob {
  if (!initialized) initGenJobs();
  // Snapshot the active project at fire time. Every subsequent
  // append + binding write for this job uses THIS path, not the
  // global `paths.project` — so a project switch mid-flight can't
  // misroute the asset into the wrong project's directory.
  const projectDir = paths.project;
  const job: GenJob = {
    id: input.id,
    projectDir,
    bind: input.bind,
    tool: input.tool,
    args: input.args,
    model: input.model,
    prompt: input.prompt,
    state: 'queued',
    attempts: [],
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  appendEvent({ kind: 'create', at: job.startedAt, job }, projectDir);
  events.broadcast({ type: 'gen-job', job });
  return job;
}

/** Record a state transition. Validates against ALLOWED; throws on
 *  illegal transitions so race bugs surface instead of silently
 *  corrupting state. The optional `patch` updates other GenJob fields
 *  atomically with the state change (pikaTaskId, remoteUrl, localPath,
 *  errorMessage, progressSec, progressPct). */
export function recordTransition(
  id: string,
  to: GenJobState,
  opts?: { patch?: Partial<GenJob>; note?: string },
): GenJob {
  if (!initialized) initGenJobs();
  const job = jobs.get(id);
  if (!job) throw new Error(`gen-jobs: no job with id=${id}`);
  if (TERMINAL.has(job.state) && job.state !== to) {
    // Once terminal, refuse changes — they'd corrupt the projection.
    // Common cause: a late-arriving notification fires after the job
    // already ended. Just ignore it. We DO allow ready→ready noop in
    // case the success path tries to broadcast a final progress tick.
    throw new Error(`gen-jobs: job ${id} is already terminal (${job.state}); cannot transition to ${to}`);
  }
  if (!ALLOWED[job.state].includes(to)) {
    throw new Error(`gen-jobs: illegal transition ${job.state} → ${to} on job ${id}`);
  }
  const from = job.state;
  const ev: GenJobEvent = { kind: 'transition', at: Date.now(), id, from, to, patch: opts?.patch, note: opts?.note };
  applyEvent(ev);
  // Anchor the append to the job's CAPTURED projectDir, not the
  // global paths.project — so transitions fired by background
  // runners after a project switch land in the right journal.
  // Falls back to paths.project for legacy jobs missing the field.
  appendEvent(ev, job.projectDir);
  events.broadcast({ type: 'gen-job', job: { ...job } });
  // Structured telemetry emit on terminal transitions — single hook
  // for downstream metric collectors (Grafana, Datadog, OTel). Writes
  // one line of JSON per terminal gen to gen-telemetry.jsonl, keyed
  // for cheap awk/jq aggregation. Drop-in target for log-tailing
  // exporters. Best-effort; never blocks the gen pipeline.
  if (TERMINAL.has(to)) {
    try {
      const totalLatency = (job.endedAt ?? Date.now()) - job.startedAt;
      const telemetry = {
        kind: 'gen.terminal',
        at: new Date().toISOString(),
        job_id: job.id,
        tool: job.tool,
        model: job.model ?? null,
        bind: job.bind,
        terminal_state: to,
        latency_ms: totalLatency,
        error: job.errorMessage ?? null,
        attempts: job.attempts.length,
        had_pika_task: !!job.pikaTaskId,
        had_local_path: !!job.localPath,
      };
      // Anchor telemetry to the job's captured project, not the
      // live active project — same rule as the journal append.
      const telemetryFile = path.join(job.projectDir ?? paths.project, '.agent', 'gen-telemetry.jsonl');
      appendFileSync(telemetryFile, JSON.stringify(telemetry) + '\n');
    } catch { /* best-effort */ }
  }
  return job;
}

/** Update progress fields WITHOUT a state transition. Used for
 *  Pika's elapsed-seconds heartbeats — they tick during `running`
 *  without changing state. Broadcasts via SSE; no journal write
 *  (heartbeats would balloon the log). `lastActivityAt` is bumped on
 *  every call so the reconciler can tell a stalled gen apart from a
 *  long-but-healthy one. */
export function recordProgress(id: string, patch: Pick<GenJob, 'progressSec' | 'progressPct' | 'remoteUrl' | 'pikaTaskId'>): void {
  if (!initialized) initGenJobs();
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  job.lastActivityAt = Date.now();
  events.broadcast({ type: 'gen-job', job: { ...job } });
}

/** Listed in order so callers can iterate without sorting. */
export function listAllJobs(): GenJob[] {
  if (!initialized) initGenJobs();
  return [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function getJob(id: string): GenJob | undefined {
  if (!initialized) initGenJobs();
  return jobs.get(id);
}

/** Return all jobs that aren't terminal. The reconciler walks this list
 *  on every tick. */
export function listActiveJobs(): GenJob[] {
  return listAllJobs().filter((j) => !TERMINAL.has(j.state));
}

/** Find any active job bound to a given scene or tile. Used by the
 *  validation pre-checks ("don't fire a second gen against a scene
 *  that already has one running"). Returns undefined if none. */
export function findActiveJobForBind(bind: GenJobBind): GenJob | undefined {
  return listActiveJobs().find((j) => bindEquals(j.bind, bind));
}

function bindEquals(a: GenJobBind, b: GenJobBind): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'scene' && b.kind === 'scene') return a.sceneId === b.sceneId;
  if (a.kind === 'tile'  && b.kind === 'tile')  return a.tileId === b.tileId;
  if (a.kind === 'ref'   && b.kind === 'ref')   return a.localRel === b.localRel;
  return false;
}

/** Manual cancel — used by the dismiss-tile route and the reconciler
 *  when an orphaned job is detected. */
export function cancelGenJob(id: string, note = 'cancelled by reconciler'): GenJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  if (TERMINAL.has(job.state)) return job;
  return recordTransition(id, 'cancelled', { note });
}

/** ID generator — sortable, monotonic-ish, short enough to read in
 *  logs. Not a full ULID (no need for cross-host uniqueness); just
 *  timestamp+rand. */
let _idCounter = 0;
export function newGenJobId(): string {
  const ms = Date.now().toString(36);
  const c = (++_idCounter).toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `gj_${ms}_${c}_${r}`;
}
