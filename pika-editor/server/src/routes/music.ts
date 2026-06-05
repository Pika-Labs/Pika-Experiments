/**
 * Music generation via Pika MCP (`generate_music` with `kind: 'music'`,
 * `provider: 'elevenlabs'`). Under the hood Pika routes this to
 * ElevenLabs `/v1/music` — same engine as before, but we no longer
 * need a separate `ELEVENLABS_API_KEY`; Pika's MCP credential covers
 * it. `force_instrumental: true` is preserved as a hard rule.
 *
 * Flow:
 *   1. User drags region on music lane → POST /music/generate
 *   2. We immediately create a `pending` music clip with the user's prompt
 *      so the lane shows a placeholder
 *   3. Background: call the MCP tool, download the resulting MP3 to
 *      assets/music/, swap the placeholder's `src` + `status: ready`
 *   4. SSE pushes `timeline-changed` so the lane refreshes
 *
 * If Pika isn't connected, the request still creates the pending clip
 * (so the user sees their intent) and errors with a `status: error` +
 * `errorMessage` patch pointing them at the Connect Pika button.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, readTimeline, writeTimeline } from '../state.js';
import { TimelineSchema, type Timeline, type AudioClip } from '../schema.js';
import { events } from '../events.js';
import { enhanceMusicPrompt } from '../workers/music-prompt-enhance.js';
import { findOrCreateAudioLane, insertAudioClip, removeAudioClip, findAudioClip } from '../audio-track-utils.js';
import { callPikaTool } from '../agent/pika-mcp.js';
import { isAuthenticated } from '../agent/pika-auth.js';

const PostBody = z.object({
  prompt: z.string().min(1),
  startSec: z.number().default(0),
  durationSec: z.number().min(3).max(600).default(30),   // ElevenLabs allows 3-600s
});

const PatchBody = z.object({
  src: z.string().optional(),
  status: z.enum(['pending', 'generating', 'ready', 'error']).optional(),
  errorMessage: z.string().nullable().optional(),
});

function safeImportFilename(name: string): string {
  // Strip dirs + dodgy chars, prepend timestamp to dedupe.
  const base = name.split('/').pop()!.replace(/[^\w.\-]+/g, '_').slice(0, 80);
  const stamp = Date.now().toString(36);
  return `imp_${stamp}_${base || 'track.mp3'}`;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'music';
}

function probeDuration(file: string): number {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
    const n = parseFloat((r.stdout || '').trim());
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch { return 1; }
}

/**
 * Patch a single audio clip's fields anywhere on the audioTracks. Used by
 * the background ElevenLabs gen worker to flip a placeholder from
 * `generating` to `ready` (and set src + duration) once the mp3 lands.
 */
async function patchClipFields(clipId: string, patch: Partial<AudioClip>, clipSrc?: string): Promise<void> {
  const { timeline } = readTimeline();
  const located = findAudioClip(timeline, clipId);
  if (!located) return;
  const merged: AudioClip = { ...located.clip, ...patch, ...(clipSrc !== undefined ? { src: clipSrc } : {}) };
  const next: Timeline = {
    ...timeline,
    audioTracks: timeline.audioTracks.map((t) => t.id !== located.track.id ? t : {
      ...t,
      clips: t.clips.map((c) => c.id === clipId ? merged : c),
    }),
  };
  const { sha } = await writeTimeline(TimelineSchema.parse(next));
  events.broadcast({ type: 'timeline-changed', sha });
}

export async function musicRoutes(app: FastifyInstance): Promise<void> {
  app.post('/music/generate', async (req, reply) => {
    const parsed = PostBody.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    const { prompt, startSec, durationSec } = parsed.data;
    const pikaReady = isAuthenticated();

    // Always create the placeholder clip first so the user sees the intent.
    const id = `mu_${Date.now().toString(36)}`;
    const { timeline } = readTimeline();
    const start = Math.max(0, Math.round(startSec * 1000) / 1000);
    const end = start + durationSec;
    const placement = findOrCreateAudioLane(timeline, start, end);
    const clip: AudioClip = {
      id,
      src: '',
      start,
      in: 0,
      out: durationSec,
      gain: 0,
      fadeIn: 1,
      fadeOut: 2,
      linkId: null,
      prompt,
      naturalDuration: 0,
      kind: 'music',
      status: pikaReady ? 'generating' : 'error',
      errorMessage: pikaReady ? null : 'Pika not connected — click "Connect Pika" in the chat panel.',
    };
    const next = insertAudioClip(placement.timeline, placement.trackId, clip);
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });

    if (!pikaReady) {
      reply.code(503);
      return { ok: false, id, error: 'pika not connected', hint: 'Click "Connect Pika" in the chat panel — music now generates through the Pika MCP (no separate ElevenLabs API key needed).' };
    }

    // Background gen.
    void doGenerate({ id, prompt, durationSec });
    return { ok: true, id };
  });

  // Agent surface for back-compat — the agent can still process pending
  // music if a project arrives with pending music clips from elsewhere.
  app.get('/music/pending', async () => {
    const { timeline } = readTimeline();
    const pending = timeline.audioTracks
      .flatMap((t) => t.clips)
      .filter((c) => c.kind === 'music' && (c.status === 'pending' || c.status === 'error'));
    return { pending };
  });

  app.patch<{ Params: { id: string } }>('/music/:id', async (req, reply) => {
    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    const { timeline } = readTimeline();
    const located = findAudioClip(timeline, req.params.id);
    if (!located) { reply.code(404); return { error: `audio clip not found: ${req.params.id}` }; }
    const merged: AudioClip = { ...located.clip, ...parsed.data };
    const next: Timeline = {
      ...timeline,
      audioTracks: timeline.audioTracks.map((t) => t.id !== located.track.id ? t : {
        ...t,
        clips: t.clips.map((c) => c.id === req.params.id ? merged : c),
      }),
    };
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true, clip: merged };
  });

  // POST /music/import?filename=track.mp3&startSec=12.5&durationSec=180
  // Body = raw audio bytes (handled by the audio content-type parser in index.ts).
  // Imports a user-supplied audio file as a ready music clip on the music lane.
  // Same edit ops as a generated music clip (move/trim/blade) afterwards.
  app.post<{ Querystring: { filename?: string; startSec?: string } }>(
    '/music/import',
    async (req, reply) => {
      const body = req.body as Buffer | undefined;
      if (!body || !(body instanceof Buffer)) { reply.code(400); return { error: 'missing binary body' }; }
      const rawName = (req.query.filename ?? `import_${Date.now()}.mp3`).toString();
      const fname = safeImportFilename(rawName);
      const startSec = Math.max(0, parseFloat(req.query.startSec ?? '0') || 0);
      const dir = path.join(paths.assets, 'music');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, fname);
      writeFileSync(abs, body);
      const dur = probeDuration(abs);
      const rel = path.relative(paths.project, abs);

      const { timeline } = readTimeline();
      const id = `mu_imp_${Date.now().toString(36)}`;
      const start = Math.round(startSec * 1000) / 1000;
      const placement = findOrCreateAudioLane(timeline, start, start + dur);
      const clip: AudioClip = {
        id,
        src: rel,
        start,
        in: 0,
        out: dur,
        gain: 0,
        fadeIn: 0,
        fadeOut: 0,
        linkId: null,
        prompt: rawName,
        naturalDuration: dur,
        kind: 'imported',
        status: 'ready',
        errorMessage: null,
      };
      const next = insertAudioClip(placement.timeline, placement.trackId, clip);
      const { sha } = await writeTimeline(TimelineSchema.parse(next));
      events.broadcast({ type: 'timeline-changed', sha });
      events.broadcast({ type: 'asset-added', relPath: rel });
      return { ok: true, id, rel, durationSec: dur };
    },
  );

  app.delete<{ Params: { id: string } }>('/music/:id', async (req, _reply) => {
    const { timeline } = readTimeline();
    const next = removeAudioClip(timeline, req.params.id);
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true };
  });
}

/** Pluck the first audio URL out of a Pika MCP tool response. Response
 *  shape varies — JSON `{"url": "..."}` in structuredContent, Markdown
 *  link in a text block, or a bare URL. The text content from callPikaTool
 *  preserves all three forms; one regex catches the lot. */
function extractAudioUrl(content: string): string | undefined {
  const matches = content.match(/https?:\/\/[^\s"'<>()\\]+/gi) ?? [];
  for (const url of matches) {
    if (/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$|#)/i.test(url)) return url;
  }
  return undefined;
}

async function doGenerate(opts: { id: string; prompt: string; durationSec: number }): Promise<void> {
  const { id, prompt, durationSec } = opts;
  try {
    const { prompt: enhanced } = enhanceMusicPrompt(prompt);
    // generate_music with kind:'music' + provider:'elevenlabs' routes
    // to ElevenLabs /v1/music on Pika's side. force_instrumental is
    // preserved as a hard rule (the agent skill enforces this too).
    const result = await callPikaTool('generate_music', {
      kind: 'music',
      provider: 'elevenlabs',
      prompt: enhanced,
      music_length_ms: Math.round(Math.max(3, Math.min(600, durationSec)) * 1000),
      force_instrumental: true,
      model_id: 'music_v1',
    });
    if (result.error) {
      await patchClipFields(id, { status: 'error', errorMessage: `pika MCP: ${result.content.slice(0, 300)}` });
      return;
    }
    const url = extractAudioUrl(result.content);
    if (!url) {
      await patchClipFields(id, { status: 'error', errorMessage: `pika MCP returned no audio URL (response: ${result.content.slice(0, 200)})` });
      return;
    }
    const res = await fetch(url);
    if (!res.ok) {
      await patchClipFields(id, { status: 'error', errorMessage: `download ${url} → ${res.status}` });
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dir = path.join(paths.assets, 'music');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const extMatch = url.match(/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$|#)/i);
    const ext = (extMatch?.[1] ?? 'mp3').toLowerCase();
    const fname = `mu_${Date.now().toString(36)}_${slugify(prompt)}.${ext}`;
    const dest = path.join(dir, fname);
    writeFileSync(dest, buf);
    const dur = probeDuration(dest);
    const rel = path.relative(paths.project, dest);

    // Stamp the per-clip src — does NOT touch the project-level music.src
    // anymore, so other music clips keep playing their own audio.
    await patchClipFields(
      id,
      { status: 'ready', errorMessage: null, out: dur, naturalDuration: dur },
      rel,
    );
    events.broadcast({ type: 'asset-added', relPath: rel });
  } catch (err: any) {
    await patchClipFields(id, { status: 'error', errorMessage: err?.message ?? String(err) });
  }
}
