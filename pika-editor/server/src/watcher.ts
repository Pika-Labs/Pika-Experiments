import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import { paths, sha256 } from './state.js';
import { events } from './events.js';
import { readFileSync } from 'node:fs';
import { scheduleReconcile } from './workers/scene-audio-reconciler.js';

let watcher: FSWatcher | null = null;

export function startWatcher(): void {
  if (watcher) {
    void watcher.close();
    watcher = null;
  }
  const workspaceJson = path.join(paths.project, 'workspace.json');
  watcher = chokidar.watch(
    [
      paths.timeline,
      workspaceJson,
      paths.comments,
      paths.beats,
      path.join(paths.assets, '**/*'),
    ],
    {
      ignoreInitial: true,
      ignored: /(^|[\/\\])\../,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    }
  );

  watcher.on('all', (event, file) => {
    if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
    const rel = path.relative(paths.project, file);

    if (file === paths.timeline) {
      try {
        const sha = sha256(readFileSync(file, 'utf8'));
        events.broadcast({ type: 'timeline-changed', sha });
      } catch { /* mid-write */ }
      // Safety net: walk scenes + auto-extract audio for any ready
      // scene that doesn't have a matching audio clip yet. Catches
      // the case where the agent wrote timeline.json directly,
      // bypassing the PATCH /scenes/:id hook. Debounced so burst
      // edits don't fire multiple runs.
      scheduleReconcile();
      return;
    }

    // workspace.json lives outside assets/. Use the existing
    // asset-added event channel that Workspace.tsx already listens
    // for with `relPath === 'workspace.json'` — saves adding a new
    // event kind. Without this, the workspace UI stays stale until
    // the user reloads.
    if (rel === 'workspace.json') {
      events.broadcast({ type: 'asset-added', relPath: 'workspace.json' });
      return;
    }

    if (file === paths.comments) {
      events.broadcast({ type: 'comments-changed' });
      return;
    }

    if (file === paths.beats) {
      events.broadcast({ type: 'beats-changed' });
      return;
    }

    if (file.startsWith(paths.assets)) {
      events.broadcast({ type: 'asset-added', relPath: rel });
      return;
    }
  });

  console.log(`[watcher] watching ${paths.project}`);
}
