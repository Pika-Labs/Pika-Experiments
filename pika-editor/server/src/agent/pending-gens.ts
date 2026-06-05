/**
 * Pending-gen persistence.
 *
 * The fire-and-forget gen pipeline runs in-memory background tasks. A server
 * restart (dev hot-reload, deploy, crash) silently kills those tasks. The
 * Pika side keeps cooking the gen, but our process is gone, so the asset
 * never gets downloaded and the scene/tile stays "Generating" forever.
 *
 * Fix: when Pika gives us a `task_id`, write `{task_id, sceneId|tileId, ...}`
 * to a per-project JSON file. On boot, walk the file and resume polling each
 * gen. When a gen completes (success or fail), remove its record.
 *
 * File: `<project>/.agent/pending-gens.json` — single JSON array, atomic
 * temp+rename writes. Small file; the array rarely exceeds 10 entries.
 *
 * Persistence shape is intentionally minimal — only what's needed to RESUME:
 *   - taskId      (Pika's id, used to call task_status)
 *   - genId       (our local id, kept stable across restarts for the SSE)
 *   - tool        (which generate_* call to mirror in logs)
 *   - sceneId     (bind target — video gens)
 *   - tileId      (bind target — image gens)
 *   - localRel    (optional override of save path)
 *   - model       (so the workspace tile still shows the right chip)
 *   - startedAt   (debug)
 *   - prompt      (debug, truncated)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../state.js';

export interface PendingGen {
  taskId: string;
  genId: string;
  tool: string;
  sceneId: string | null;
  tileId: string | null;
  localRel: string | null;
  model: string | undefined;
  startedAt: number;
  prompt?: string;
  /** Absolute path to the project this pending gen belongs to. Used
   *  by the boot-resume runner so an asset that lands after a
   *  project switch (or after a restart that changed the active
   *  project) still goes to the project the gen was fired in.
   *  Optional for backwards compatibility — older records default
   *  to the active project at resume time. */
  projectDir?: string;
}

function filePath(): string {
  return path.join(paths.project, '.agent', 'pending-gens.json');
}

function readAll(): PendingGen[] {
  const f = filePath();
  if (!existsSync(f)) return [];
  try {
    const raw = readFileSync(f, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => x && typeof x.taskId === 'string');
  } catch (err) {
    console.warn(`[pending-gens] read failed (treating as empty):`, (err as Error)?.message ?? err);
    return [];
  }
}

function writeAll(list: PendingGen[]): void {
  const f = filePath();
  const dir = path.dirname(f);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${f}.tmp.${process.pid}.${Date.now().toString(36)}`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  renameSync(tmp, f);
}

/** Record that we've received a Pika task_id for an in-flight gen. */
export function recordPending(entry: PendingGen): void {
  const list = readAll();
  // Dedupe by taskId in case of weird re-entry.
  const filtered = list.filter((x) => x.taskId !== entry.taskId);
  filtered.push(entry);
  writeAll(filtered);
}

/** Remove a gen record by Pika taskId (called on terminal status). */
export function clearPending(taskId: string): void {
  const list = readAll();
  const filtered = list.filter((x) => x.taskId !== taskId);
  if (filtered.length !== list.length) writeAll(filtered);
}

/** Read the full list (for boot-time resume). */
export function listPending(): PendingGen[] {
  return readAll();
}
