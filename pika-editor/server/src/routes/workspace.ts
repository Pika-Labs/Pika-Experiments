/**
 * Workspace view backend — surfaces the project's brief.md (the plan) and a
 * tree of generated assets so the user can review everything inside the
 * editor without dropping to Finder.
 *
 * Two endpoints:
 *  • GET /workspace/brief   — returns the project's brief.md as text (404 if absent)
 *  • GET /workspace/assets  — returns a grouped index of assets/ with size+mtime
 *                              and an `assetRel` path the client can hand back
 *                              to /asset/* for streaming.
 *
 * Asset grouping convention (lines up with the agent skill's directory layout):
 *   refs/cast       → Cast refs (gpt-image-2 character portraits)
 *   refs/locations  → Location refs
 *   refs/storyboard → Per-beat storyboard frames
 *   pika            → Agent-generated video clips
 *   imports         → User-imported videos
 *   music           → Music sources
 *   sfx             → SFX clips
 */
import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { paths, writeWorkspaceAtomic } from '../state.js';
import { callPikaTool } from '../agent/pika-mcp.js';

interface AssetEntry {
  name: string;
  rel: string;            // path under assets/ (e.g. "refs/cast/cat_hero.png")
  kind: 'image' | 'video' | 'audio' | 'other';
  size: number;
  mtime: number;
}
interface AssetGroup {
  group: string;
  label: string;
  items: AssetEntry[];
}

const KIND_BY_EXT: Record<string, AssetEntry['kind']> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
  '.mp4': 'video', '.mov': 'video', '.webm': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.aac': 'audio',
};

function listFlat(dirAbs: string, dirRel: string): AssetEntry[] {
  if (!existsSync(dirAbs)) return [];
  const out: AssetEntry[] = [];
  for (const name of readdirSync(dirAbs)) {
    if (name.startsWith('.')) continue;
    const abs = path.join(dirAbs, name);
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) continue;       // shallow listing per group
    const ext = path.extname(name).toLowerCase();
    out.push({
      name,
      rel: path.join(dirRel, name),
      kind: KIND_BY_EXT[ext] ?? 'other',
      size: st.size,
      mtime: st.mtimeMs,
    });
  }
  // Newest first
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Curated top-level groups. Order here is the order they render in
 *  the left rail. Additional `refs/*` subdirs (not listed here) are
 *  discovered dynamically below so any `local_rel` save path the
 *  agent picks via produce_workspace_image is always visible — no
 *  per-kind allowlist to maintain. */
const GROUPS: { group: string; label: string; relDir: string }[] = [
  { group: 'cast',       label: 'Cast refs',         relDir: 'refs/cast' },
  { group: 'locations',  label: 'Location refs',     relDir: 'refs/locations' },
  { group: 'storyboard', label: 'Storyboard frames', relDir: 'refs/storyboard' },
  { group: 'pika',       label: 'Generated video',   relDir: 'pika' },
  { group: 'imports',    label: 'Imported video',    relDir: 'imports' },
  { group: 'music',      label: 'Music',             relDir: 'music' },
  { group: 'sfx',        label: 'Audio',             relDir: 'sfx' },
];

/** Discover every subdir under assets/ (and assets/refs/) that isn't
 *  already a named GROUP — so any folder the agent uses to drop assets
 *  shows up in the Library without an allowlist update. Covers:
 *   - assets/dialogue/, assets/action/, assets/whatever/  (any video
 *     subfolder the agent invents — these were invisible before)
 *   - assets/refs/<subdir>/  (cast/locations/storyboard are named; any
 *     other subdir like prop/, auto/, uploads/ is discovered here)
 *   - assets/refs/<file>     (loose files at the refs root)
 *
 *  No agent discretion over visibility — the server enumerates the
 *  filesystem, period. */
function discoverAdditionalGroups(): { group: string; label: string; relDir: string }[] {
  if (!existsSync(paths.assets)) return [];
  const namedTopLevel = new Set(
    GROUPS.filter((g) => !g.relDir.includes('/')).map((g) => g.relDir),
  );
  const namedRefsSub = new Set(
    GROUPS.filter((g) => g.relDir.startsWith('refs/')).map((g) => g.relDir.slice('refs/'.length)),
  );
  const out: { group: string; label: string; relDir: string }[] = [];

  // Pass 1 — every NON-curated top-level subdir of assets/. The
  // exception is `refs/`, which is handled specially in Pass 2 (we
  // surface its subdirs as their own groups so cast/locations/etc.
  // stay separated). Files saved at the root of assets/ (rare) are
  // also surfaced under a synthetic 'Other' header.
  let assetsEntries: string[] = [];
  try { assetsEntries = readdirSync(paths.assets); } catch { return []; }
  for (const name of assetsEntries) {
    if (name.startsWith('.')) continue;
    if (name === 'refs') continue;  // handled in Pass 2
    if (namedTopLevel.has(name)) continue;  // already in GROUPS
    let st; try { st = statSync(path.join(paths.assets, name)); } catch { continue; }
    if (!st.isDirectory()) continue;
    // Pretty label: "dialogue" → "Dialogue", "action" → "Action"
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    out.push({ group: `dir-${name}`, label, relDir: name });
  }

  // Pass 2 — assets/refs/ subdirs and loose root-level refs files.
  const refsAbs = path.join(paths.assets, 'refs');
  if (existsSync(refsAbs)) {
    let refsEntries: string[] = [];
    try { refsEntries = readdirSync(refsAbs); } catch { refsEntries = []; }
    const rootHasFiles = refsEntries.some((name) => {
      if (name.startsWith('.')) return false;
      try { return statSync(path.join(refsAbs, name)).isFile(); } catch { return false; }
    });
    if (rootHasFiles) out.push({ group: 'refs-root', label: 'Refs', relDir: 'refs' });
    for (const name of refsEntries) {
      if (name.startsWith('.')) continue;
      if (namedRefsSub.has(name)) continue;
      let st; try { st = statSync(path.join(refsAbs, name)); } catch { continue; }
      if (!st.isDirectory()) continue;
      const label = name === 'auto' ? 'Auto-saved refs'
        : name === 'uploads' ? 'Uploaded refs'
        : `Refs · ${name}`;
      out.push({ group: `refs-${name}`, label, relDir: `refs/${name}` });
    }
  }
  return out;
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /workspace/state — the agent's "what's next" briefing card. This is
   * the primary surface for the workspace tab. Lives at
   * `<project>/workspace.json`. Schema is intentionally open — the client
   * renders known `primary.kind` values and ignores fields it doesn't know,
   * so the agent can evolve the schema without breaking the UI.
   */
  app.get('/workspace/state', async (_req, reply) => {
    const file = path.join(paths.project, 'workspace.json');
    if (!existsSync(file)) { reply.code(404); return { error: 'no workspace.json yet — agent hasn’t briefed' }; }
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e: any) {
      reply.code(500);
      return { error: 'workspace.json parse failed', detail: e?.message };
    }
  });

  /**
   * POST /workspace/dismiss-tile { index } — user-driven removal of a
   * single primary.items tile from workspace.json. Used when a gen has
   * hung forever / a placeholder is orphaned / a failed gen needs to
   * be cleared so the workspace can recover without waiting on the
   * agent. Persists by rewriting the file atomically. The agent's next
   * write_workspace overrides everything as usual.
   *
   * Bounded: only operates on primary.items, only the requested index,
   * leaves every other field (headline, body, ask, activity, etc.)
   * untouched.
   */
  const DismissBody = z.object({ index: z.number().int().nonnegative() });
  app.post('/workspace/dismiss-tile', async (req, reply) => {
    const parsed = DismissBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad request', detail: parsed.error.message }; }
    const file = path.join(paths.project, 'workspace.json');
    if (!existsSync(file)) { reply.code(404); return { error: 'no workspace.json yet' }; }
    let doc: any;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e: any) { reply.code(500); return { error: 'workspace.json parse failed', detail: e?.message }; }

    const items: unknown[] = Array.isArray(doc?.primary?.items) ? doc.primary.items : [];
    if (parsed.data.index >= items.length) {
      reply.code(404);
      return { error: `index ${parsed.data.index} out of range (have ${items.length} items)` };
    }
    // Capture the tile we're about to drop so we can also cancel its
    // upstream Pika task. Without this, a "stuck" tile just disappears
    // from the UI but the actual generation keeps consuming credits
    // until it hits the MCP server's own timeout.
    const removedTile = items[parsed.data.index] as { taskId?: string } | null;
    const nextItems = items.filter((_, i) => i !== parsed.data.index);
    doc.primary = { ...doc.primary, items: nextItems };

    // Atomic write + direct SSE broadcast — same contract as every
    // other workspace mutation in the codebase. The watcher would
    // eventually fire too, but its ~120ms stability delay sometimes
    // loses the event entirely on rapid renames, which the user
    // sees as "stuck UI until I refresh."
    await writeWorkspaceAtomic(doc);

    // Best-effort cancel of the underlying Pika task. Fire-and-forget
    // because the user's dismiss action shouldn't block on a cancel
    // round-trip, and the cancel failing doesn't affect the dismissal.
    let cancelAttempted = false;
    if (removedTile?.taskId) {
      cancelAttempted = true;
      void callPikaTool('mcp__pika__task_cancel', { task_id: removedTile.taskId })
        .catch((err: unknown) => app.log.warn({ err: String((err as Error)?.message ?? err) }, 'pika task_cancel failed (non-fatal)'));
    }

    return { ok: true, removed: parsed.data.index, remaining: nextItems.length, cancelAttempted };
  });

  app.get('/workspace/brief', async (_req, reply) => {
    const file = path.join(paths.project, 'brief.md');
    if (!existsSync(file)) { reply.code(404); return { error: 'no brief.md yet' }; }
    const text = readFileSync(file, 'utf8');
    reply.header('content-type', 'text/plain; charset=utf-8');
    return text;
  });

  app.get('/workspace/assets', async () => {
    // Named curated groups + any additional refs/<subdir> we discovered
    // dynamically. `listFlat` is shallow per group, so a file under
    // refs/cast/ never shows up in the synthetic "refs root" group and
    // vice-versa — no duplicates.
    const allGroups = [...GROUPS, ...discoverAdditionalGroups()];
    const groups: AssetGroup[] = allGroups.map((g) => ({
      group: g.group,
      label: g.label,
      items: listFlat(path.join(paths.assets, g.relDir), g.relDir),
    })).filter((g) => g.items.length > 0);
    return { groups };
  });

  /**
   * GET /workspace/history — list timestamps of prior workspace.json
   * snapshots so the Workspace card can offer a Previous/Next stepper.
   * Newest first. Stamps are ISO strings with ":" → "-" (filesystem safe);
   * the client uses them as opaque ids when fetching a specific snapshot.
   */
  app.get('/workspace/history', async () => {
    const dir = path.join(paths.project, '.agent', 'workspace-history');
    if (!existsSync(dir)) return { snapshots: [] };
    const stamps = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
      .reverse();
    return { snapshots: stamps };
  });

  app.get<{ Params: { stamp: string } }>('/workspace/history/:stamp', async (req, reply) => {
    const dir = path.join(paths.project, '.agent', 'workspace-history');
    const file = path.join(dir, `${req.params.stamp}.json`);
    // Stay inside the history dir — reject any path traversal attempt.
    if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) {
      reply.code(403); return { error: 'forbidden' };
    }
    if (!existsSync(file)) { reply.code(404); return { error: 'snapshot not found' }; }
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch (e: any) { reply.code(500); return { error: 'parse failed', detail: e?.message }; }
  });
}
