import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWatcher } from './watcher.js';
import { paths, projectExists, readTimeline, writeTimeline } from './state.js';
import { resumePendingGens } from './agent/pika-mcp.js';
import { initGenJobs } from './agent/gen-jobs.js';
import { startReconciler } from './agent/reconciler.js';
import { startCreditsPolling } from './agent/pika-credits.js';

// Tiny dotenv shim — loads PikaAgentEditor/server/.env if present so
// secrets like ANTHROPIC_API_KEY are available without an external dep.
(function loadEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, '../.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, '');
    if (val) process.env[key] = val;
  }
})();

import { projectRoutes } from './routes/project.js';
import { timelineRoutes } from './routes/timeline.js';
import { commentRoutes } from './routes/comment.js';
import { beatsRoutes } from './routes/beats.js';
import { assetRoutes } from './routes/asset.js';
import { eventsRoutes } from './routes/events.js';
import { projectsListRoutes } from './routes/projects.js';
import { sceneRoutes } from './routes/scenes.js';
import { renderRoutes } from './routes/render.js';
import { versionRoutes } from './routes/version.js';
import { uploadRoutes } from './routes/upload.js';
import { sfxRoutes } from './routes/sfx.js';
import { musicRoutes } from './routes/music.js';
import { workspaceRoutes } from './routes/workspace.js';
import { chatRoutes } from './routes/chat.js';
import { voiceRoutes } from './routes/voice.js';
import { oauthRoutes } from './routes/oauth.js';
import { planRoutes } from './routes/plan.js';
import { captionsRoutes } from './routes/captions.js';

const PORT = parseInt(process.env.PIKA_EDITOR_PORT ?? '3080', 10);

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 50 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });

  app.addContentTypeParser(
    /^(audio|video|image)\/.+|^application\/octet-stream$/,
    { parseAs: 'buffer', bodyLimit: 500 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  await app.register(projectRoutes);
  await app.register(timelineRoutes);
  await app.register(commentRoutes);
  await app.register(beatsRoutes);
  await app.register(assetRoutes);
  await app.register(eventsRoutes);
  await app.register(projectsListRoutes);
  await app.register(sceneRoutes);
  await app.register(renderRoutes);
  await app.register(versionRoutes);
  await app.register(uploadRoutes);
  await app.register(sfxRoutes);
  await app.register(musicRoutes);
  await app.register(workspaceRoutes);
  await app.register(chatRoutes);
  await app.register(voiceRoutes);
  await app.register(oauthRoutes);
  await app.register(planRoutes);
  await app.register(captionsRoutes);

  if (!projectExists()) {
    app.log.warn(`project dir does not exist yet: ${paths.project}`);
  } else {
    // Orphan cleanup — a server restart kills in-flight background gens but
    // leaves the placeholder clips stuck in 'generating' status forever.
    // Flip them to 'error' on boot so the user can see + delete them
    // (or retry). Only touches clips genuinely stranded — leaves real
    // pending agent work alone if it has an empty src AND status:'pending'.
    try {
      const { timeline } = readTimeline();
      let changed = false;
      const audioTracks = timeline.audioTracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => {
          if (c.status === 'generating') {
            changed = true;
            return { ...c, status: 'error' as const, errorMessage: 'gen interrupted by server restart — delete and retry' };
          }
          return c;
        }),
      }));
      if (changed) {
        await writeTimeline({ ...timeline, audioTracks });
        app.log.info('cleared orphan generating audio clips on boot');
      }
    } catch (err) {
      app.log.warn({ err: String((err as Error)?.message ?? err) }, 'orphan cleanup skipped (non-fatal)');
    }
  }

  startWatcher();

  await app.listen({ host: '127.0.0.1', port: PORT });
  app.log.info(`pika-agent-editor server listening at http://127.0.0.1:${PORT}`);
  app.log.info(`  project: ${paths.project}`);

  // Replay the GenJob log for the active project — rebuilds the in-memory
  // state map so every active gen has a record. This must run BEFORE
  // resumePendingGens, since the resume path now writes GenJob
  // transitions for any in-flight Pika tasks it re-attaches to.
  try { initGenJobs(); }
  catch (err) { app.log.warn({ err: String((err as Error)?.message ?? err) }, 'initGenJobs threw'); }

  // Re-attach any in-flight Pika gens whose background task died with the
  // previous server (hot-reload, crash, deploy). Fires-and-forgets — boot
  // continues immediately, polling resumes in the background.
  void resumePendingGens()
    .catch((err: unknown) => app.log.warn({ err: String((err as Error)?.message ?? err) }, 'resumePendingGens threw'));

  // Reconciler: periodic invariant check + self-heal (Phase 3). Sweeps
  // orphan GenJobs, orphan scenes, orphan tiles, and stale CDN-only
  // tile srcs every 10s. Logs findings via `[reconciler]` and broadcasts
  // a `reconciler-health` SSE event for the UI indicator.
  startReconciler();

  // Pika credit-balance polling — once a minute background refresh +
  // opportunistic refresh after every gen. Server-owned (the agent
  // doesn't decide when to query); the topbar pill is always fresh.
  startCreditsPolling();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
