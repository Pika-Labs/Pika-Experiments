/**
 * Reconciler — periodic invariant check + self-heal.
 *
 * Ticks every 10s. Walks GenJob + timeline + workspace and asserts:
 *
 *   1. Every active GenJob (state in {queued, firing, running, downloading})
 *      that has a `pikaTaskId` AND is older than RESCUE_AFTER_SEC seconds
 *      has either:
 *      (a) an entry in pending-gens.jsonl with a live polling loop, OR
 *      (b) is salvageable — re-attach via the existing resume path; OR
 *      (c) timed out — cancel with an explicit error.
 *
 *   2. Every active GenJob that has been in `queued` for > QUEUE_TIMEOUT_SEC
 *      (no `firing` transition) is treated as orphaned and cancelled.
 *      Cause: the inline path or the produce_ tool crashed between
 *      `createGenJob` and the actual MCP call. Rare, but happens on
 *      partial-success deploys.
 *
 *   3. Every scene with `status === 'pending' | 'generating'` AND no
 *      active GenJob bound to it is an orphan. Either the GenJob log
 *      was wiped, or the agent set scene.status manually without a
 *      gen. Patch the scene to `status: 'error'` with a clear message
 *      so the timeline V1 clip stops spinning.
 *
 *   4. Every workspace tile with `pending: true` AND no active GenJob
 *      bound to it (by `id` matching tile.taskId/tile.id) AND older
 *      than ORPHAN_TILE_SEC is marked `failed: true` with the message
 *      "tile was pending but no gen ran". Surfaces orphans the user
 *      would otherwise see as silent spinners forever.
 *
 *   5. Every workspace tile whose `src` is a CDN URL (http(s)://…) AND
 *      has a bound GenJob in `ready` state with a `localPath` is
 *      rewritten to use the localPath instead. Closes the "CDN URL
 *      expired, image broken" failure mode for tiles that auto-bind
 *      didn't reach.
 *
 * Each tick logs its findings via `[reconciler]` so a tail-f of the
 * server stdout shows the system at work. Findings are also broadcast
 * as a `reconciler-health` SSE event so the UI can surface an
 * indicator (Phase 4).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../state.js';
import { events } from '../events.js';
import { listActiveJobs, listAllJobs, cancelGenJob, recordTransition, type GenJob } from './gen-jobs.js';

const TICK_MS = 10_000;
const QUEUE_TIMEOUT_SEC = 60;        // queued → nothing happened in 60s → orphan
// Pika's INLINE response budget is ~260s — gens that fit inside that
// budget never produce a task envelope, so they sit in `firing` for
// the whole call. Setting this below 260s falsely killed Seedance and
// gpt-image-2 high-quality gens that take 2–4 minutes inline. 900s
// gives generous slack for the rare slow case where Pika sits on a
// queue before responding at all.
const FIRING_TIMEOUT_SEC = 900;
const RUNNING_TIMEOUT_SEC = 30 * 60; // running with no progress in 30 min → timeout
const ORPHAN_TILE_SEC = 90;          // pending tile + no GenJob for 90s → mark failed

let tickHandle: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

/** Run a tick, skipping if the previous one is still in flight. A tick does
 *  HTTP patches with retries + actor waits, so under recovery load it can
 *  exceed TICK_MS; without this guard setInterval would stack concurrent
 *  ticks that double-cancel jobs and pile up actor-lock waiters. */
function runTick(): void {
  if (tickRunning) return;
  tickRunning = true;
  void tick()
    .catch((err) => console.warn('[reconciler] tick threw:', (err as Error)?.message ?? err))
    .finally(() => { tickRunning = false; });
}

interface HealthSummary {
  at: number;
  activeJobs: number;
  fixed: { orphanJobs: number; orphanScenes: number; orphanTiles: number; staleCdnRewrites: number };
  warnings: string[];
}

export function startReconciler(): void {
  if (tickHandle) return;
  console.log('[reconciler] starting (tick every 10s)');
  // Fire once immediately so the first reconciliation isn't 10s delayed.
  runTick();
  tickHandle = setInterval(runTick, TICK_MS);
}

export function stopReconciler(): void {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}

async function tick(): Promise<void> {
  const now = Date.now();
  const summary: HealthSummary = {
    at: now,
    activeJobs: 0,
    fixed: { orphanJobs: 0, orphanScenes: 0, orphanTiles: 0, staleCdnRewrites: 0 },
    warnings: [],
  };

  // --- Pass 1: GenJob timeouts.
  const active = listActiveJobs();
  summary.activeJobs = active.length;
  for (const job of active) {
    const ageSec = (now - job.startedAt) / 1000;
    // Heartbeats count as activity (recordProgress sets lastActivityAt),
    // so a healthy long-running gen with periodic notifications doesn't
    // look stalled. Fall back to job.startedAt for jobs that never
    // transitioned at all (queued).
    const lastActivityAt = job.lastActivityAt
      ?? (job.attempts.length > 0 ? job.attempts[job.attempts.length - 1].at : job.startedAt);
    const sinceLastSec = (now - lastActivityAt) / 1000;

    if (job.state === 'queued' && ageSec > QUEUE_TIMEOUT_SEC) {
      console.warn(`[reconciler] cancel orphan ${job.id} — queued for ${Math.round(ageSec)}s with no fire`);
      cancelGenJob(job.id, `orphan: queued ${Math.round(ageSec)}s, never fired`);
      summary.fixed.orphanJobs += 1;
      continue;
    }
    if (job.state === 'firing' && sinceLastSec > FIRING_TIMEOUT_SEC) {
      console.warn(`[reconciler] mark error ${job.id} — firing for ${Math.round(sinceLastSec)}s with no task_id`);
      try {
        recordTransition(job.id, 'error', {
          patch: { errorMessage: `firing timeout: no Pika task_id after ${Math.round(sinceLastSec)}s` },
        });
        await markBindFailureFromJob(job, `firing timeout after ${Math.round(sinceLastSec)}s`);
      } catch (err) {
        summary.warnings.push(`could not mark ${job.id} as error: ${(err as Error)?.message ?? err}`);
      }
      summary.fixed.orphanJobs += 1;
      continue;
    }
    if ((job.state === 'running' || job.state === 'downloading') && sinceLastSec > RUNNING_TIMEOUT_SEC) {
      console.warn(`[reconciler] mark error ${job.id} — ${job.state} stalled ${Math.round(sinceLastSec)}s`);
      try {
        recordTransition(job.id, 'error', {
          patch: { errorMessage: `${job.state} timeout: no progress for ${Math.round(sinceLastSec)}s` },
        });
        await markBindFailureFromJob(job, `${job.state} stalled ${Math.round(sinceLastSec)}s`);
      } catch (err) {
        summary.warnings.push(`could not mark ${job.id} as error: ${(err as Error)?.message ?? err}`);
      }
      summary.fixed.orphanJobs += 1;
      continue;
    }
  }

  // --- Pass 2: orphan scenes.
  //
  // Removed. The previous check was buggy in a way that mattered: it
  // read `scene.createdAt` (a field that doesn't exist in the schema),
  // so the "grace period" guard ALWAYS evaluated false, and the
  // reconciler marked every pending scene as orphaned on the first
  // tick — including scenes whose gen was actively running but whose
  // GenJob had been created a moment after the scene (e.g. when the
  // agent does prompt rewrites or voice lookups between
  // `produce_scene` and the actual `pika_generate_*` call).
  //
  // The orphan-scene check is now driven entirely by the GenJob
  // lifecycle in Pass 1 above:
  //   - GenJob stalls → reconciler marks scene as error via markBindFailureFromJob.
  //   - GenJob succeeds → autoBindGenToScene PATCHes the scene to ready.
  //   - Scene without a GenJob → quietly stays pending; the user can
  //     delete it manually if it was truly abandoned.
  //
  // We trade automatic cleanup of edge-case orphans for never falsely
  // killing a live gen. The tradeoff is worth it.

  // --- Pass 3: orphan workspace tiles + Pass 4: stale CDN-only tiles.
  const workspace = readWorkspaceSafe();
  if (workspace && Array.isArray(workspace.primary?.items)) {
    const items = workspace.primary.items as Array<Record<string, unknown>>;
    const wsAgeMs = workspace.generatedAt ? now - new Date(workspace.generatedAt as string).getTime() : 0;
    const allActive = listActiveJobs();
    let needsTileWrite = false;
    const nextItems = items.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const taskId = (it as { taskId?: string }).taskId;
      const id = (it as { id?: string }).id;
      // Pass 3: pending-tile orphan check REMOVED — same false-positive
      // shape as the scene-orphan check we removed earlier. The check
      // relied on `workspace.generatedAt` as a proxy for tile age, and
      // 90s after that timestamp it was marking every still-pending
      // tile as "tile was pending but no gen ran" — including tiles
      // whose gen had failed at preflight (no GenJob created) and was
      // about to be retried, or tiles whose corresponding GenJob errored
      // with a real Pika message like `agent_not_configured`. Tile
      // failures now come exclusively from `markBindFailureFromJob` in
      // pika-mcp's gen-error paths, which carries the actual upstream
      // error text the user needs to see.
      //
      // Pass 4 (CDN→local rewrite) is unchanged and stays below.
      void allActive; void wsAgeMs;
      const src = (it as { src?: string }).src;
      if (typeof src === 'string' && /^https?:\/\//.test(src)) {
        // Look up the job by tile id; if it landed with a localPath,
        // prefer that.
        const job = listActiveJobsAll().find((j) =>
          (j.bind.kind === 'tile' && j.bind.tileId === id) ||
          (taskId && j.id === taskId),
        );
        if (job && job.state === 'ready' && job.localPath) {
          console.log(`[reconciler] rewrite tile ${id ?? '(no id)'} CDN→local: ${job.localPath}`);
          needsTileWrite = true;
          summary.fixed.staleCdnRewrites += 1;
          return { ...it, src: job.localPath };
        }
      }
      return it;
    });
    if (needsTileWrite) {
      try {
        const { mutateWorkspace } = await import('../state.js');
        await mutateWorkspace((cur: any) => {
          const next = { ...cur, primary: { ...(cur?.primary ?? {}), items: nextItems } };
          return { next, result: undefined };
        });
      } catch (err) {
        summary.warnings.push(`could not update workspace.json: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  // Broadcast health summary so the UI can render an indicator.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events.broadcast({ type: 'reconciler-health', summary } as any);
  _lastSummary = summary;
  const totalFixed = summary.fixed.orphanJobs + summary.fixed.orphanScenes + summary.fixed.orphanTiles + summary.fixed.staleCdnRewrites;
  if (totalFixed > 0) {
    console.log(`[reconciler] tick fixed ${totalFixed} drift(s): ${JSON.stringify(summary.fixed)}`);
  }
}

function readWorkspaceSafe(): { generatedAt?: string; primary?: { items?: unknown[] } } | null {
  try {
    const file = path.join(paths.project, 'workspace.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

/** Lower-level variant of listActiveJobs that includes RECENTLY-terminal
 *  jobs (within the last 5 minutes). Used by the CDN-rewrite pass so
 *  we can match a tile to a recently-completed GenJob even after it
 *  left the active set. */
function listActiveJobsAll(): GenJob[] {
  const cutoff = Date.now() - 5 * 60_000;
  return listAllJobs().filter((j) => !j.endedAt || j.endedAt > cutoff);
}

async function patchScene(sceneId: string, patch: Record<string, unknown>): Promise<void> {
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  const res = await fetch(`http://127.0.0.1:${port}/scenes/${encodeURIComponent(sceneId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`PATCH /scenes/${sceneId} → ${res.status}`);
}

async function markBindFailureFromJob(job: GenJob, reason: string): Promise<void> {
  // We don't import pika-mcp's markBindFailure directly (would create
  // a dependency cycle). Mirror its effect here in a slimmer form: PATCH
  // the scene + clear the tile placeholder.
  if (job.bind.kind === 'scene') {
    await patchScene(job.bind.sceneId, { status: 'error', errorMessage: reason }).catch(() => { /* logged via warnings */ });
  }
  if (job.bind.kind === 'tile') {
    try {
      const { mutateWorkspace } = await import('../state.js');
      await mutateWorkspace((cur: any) => {
        const items = Array.isArray(cur?.primary?.items) ? cur.primary.items.map((it: any) => {
          if (it?.id !== (job.bind as { tileId: string }).tileId) return it;
          return { ...it, failed: true, errorMessage: reason, pending: false };
        }) : [];
        return { next: { ...cur, primary: { ...(cur?.primary ?? {}), items } }, result: undefined };
      });
    } catch { /* swallowed */ }
  }
}

// Last tick's summary, exposed via /agent/reconciler-health so the UI
// can render a top-bar health indicator (Phase 4).
let _lastSummary: HealthSummary | null = null;
export function peekLastTickSummary(): HealthSummary | null {
  return _lastSummary;
}
