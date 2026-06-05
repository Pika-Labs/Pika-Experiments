/**
 * SFX generation via Pika MCP (`generate_music` with `kind: 'sfx'`,
 * `provider: 'elevenlabs'`). Under the hood Pika routes this to
 * ElevenLabs `/v1/sound-generation` (model `eleven_text_to_sound_v2`) —
 * sync, no polling. We just call the MCP tool, parse the asset URL out
 * of the response, download it, and swap the placeholder clip's `src`
 * to the local path.
 *
 * Server-direct (not agent-driven) because SFX prompts are atomic —
 * "thunder", "whoosh", "ding". They don't carry character refs, cast,
 * location, or anything else the briefing loop produces. The instant-
 * gratification path is correct here.
 *
 * Same flow as before:
 *   1. Pre-create a placeholder audio clip on the SFX lane so the user
 *      sees the prompt sitting there while the gen runs.
 *   2. Background call to Pika MCP. On success: download → swap clip
 *      src + out → broadcast SSE. On failure: drop the placeholder +
 *      broadcast `sfx-error`.
 *
 * Pika auth (the user clicks "Connect Pika" in the chat panel) is the
 * only credential we need now — the old `ELEVENLABS_API_KEY` env is
 * gone.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, readTimeline, writeTimeline } from '../state.js';
import { TimelineSchema, type Timeline, type AudioClip } from '../schema.js';
import { events } from '../events.js';
import { findOrCreateAudioLane, insertAudioClip, removeAudioClip, findAudioClip } from '../audio-track-utils.js';
import { callPikaTool } from '../agent/pika-mcp.js';
import { isAuthenticated } from '../agent/pika-auth.js';

const Body = z.object({
  prompt: z.string().min(1),
  startSec: z.number().default(0),
  // optional explicit duration (seconds). Omit to let ElevenLabs pick.
  durationSec: z.number().optional(),
  promptInfluence: z.number().min(0).max(1).optional(),
  // Legacy lane field accepted but ignored under the unified model — the
  // server picks a collision-free audio track automatically. Kept on the
  // schema for back-compat with older clients.
  lane: z.enum(['VO', 'SFX1', 'SFX2']).optional(),
  // Optional preferred track id (`a1`, `a2`, …) when the caller has a
  // preference; if it collides the auto-place falls through to the next
  // free track.
  trackId: z.string().optional(),
});

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'sfx';
}

function probeDuration(file: string): number {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
    const n = parseFloat((r.stdout || '').trim());
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch { return 1; }
}

/** Pluck the first audio URL out of a Pika MCP tool response. Response
 *  shape varies — sometimes JSON `{"url": "..."}` in structuredContent,
 *  sometimes a Markdown link in a text block (`✅ [Listen](https://…mp3)`),
 *  sometimes a bare URL. Regex covers all three. */
function extractAudioUrl(content: string): string | undefined {
  const matches = content.match(/https?:\/\/[^\s"'<>()\\]+/gi) ?? [];
  for (const url of matches) {
    if (/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$|#)/i.test(url)) return url;
  }
  return undefined;
}

export async function sfxRoutes(app: FastifyInstance): Promise<void> {
  app.post('/sfx/generate', async (req, reply) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    const { prompt, startSec, durationSec, promptInfluence, trackId } = parsed.data;
    if (!isAuthenticated()) {
      reply.code(503);
      return {
        error: 'pika not connected',
        hint: 'Click "Connect Pika" in the chat panel — SFX now generates through the Pika MCP (no separate ElevenLabs API key needed).',
      };
    }

    // Pre-create a placeholder audio clip so the user sees the prompt
    // sitting on a lane while the gen runs. Auto-place picks the first
    // collision-free track (or creates a new one); we swap src + out via
    // SSE when the mp3 lands.
    const placeholderId = `sfx_pending_${Date.now().toString(36)}`;
    const guessDur = Math.max(0.5, Math.min(22, durationSec ?? 2));
    const start = Math.max(0, Math.round(startSec * 1000) / 1000);
    {
      const { timeline } = readTimeline();
      const placement = findOrCreateAudioLane(timeline, start, start + guessDur, { preferredTrackId: trackId });
      const clip: AudioClip = {
        id: placeholderId,
        src: '',                       // empty src signals "pending"
        start,
        in: 0,
        out: guessDur,
        gain: -3,
        fadeIn: 0,
        fadeOut: 0,
        linkId: null,
        prompt,                        // shown on the clip while generating
        naturalDuration: 0,
        kind: 'sfx',
        status: 'generating',
        errorMessage: null,
      };
      const next = insertAudioClip(placement.timeline, placement.trackId, clip);
      const { sha } = await writeTimeline(TimelineSchema.parse(next));
      events.broadcast({ type: 'timeline-changed', sha });
    }

    // Background gen — return immediately.
    void doGenerate({ prompt, durationSec, promptInfluence, placeholderId });
    return { ok: true, placeholderId };
  });
}

async function doGenerate(opts: {
  prompt: string; durationSec?: number; promptInfluence?: number;
  placeholderId: string;
}): Promise<void> {
  const { prompt, durationSec, promptInfluence, placeholderId } = opts;
  try {
    // Pika's generate_music with kind:'sfx' + provider:'elevenlabs'
    // routes to ElevenLabs /v1/sound-generation (model
    // eleven_text_to_sound_v2). Sync — no polling, no [queued] envelope.
    const pikaArgs: Record<string, unknown> = {
      kind: 'sfx',
      provider: 'elevenlabs',
      prompt,
    };
    if (typeof durationSec === 'number' && durationSec > 0) {
      pikaArgs.duration_seconds = Math.min(22, Math.max(0.5, durationSec));
    }
    if (typeof promptInfluence === 'number') pikaArgs.prompt_influence = promptInfluence;

    const result = await callPikaTool('generate_music', pikaArgs);
    if (result.error) {
      events.broadcast({
        type: 'sfx-error',
        placeholderId,
        message: result.content.slice(0, 300),
      });
      // Drop the placeholder clip on error.
      const { timeline } = readTimeline();
      const next = removeAudioClip(timeline, placeholderId);
      const { sha } = await writeTimeline(TimelineSchema.parse(next));
      events.broadcast({ type: 'timeline-changed', sha });
      return;
    }

    const url = extractAudioUrl(result.content);
    if (!url) {
      events.broadcast({
        type: 'sfx-error',
        placeholderId,
        message: `Pika MCP returned no audio URL (response: ${result.content.slice(0, 200)})`,
      });
      const { timeline } = readTimeline();
      const next = removeAudioClip(timeline, placeholderId);
      const { sha } = await writeTimeline(TimelineSchema.parse(next));
      events.broadcast({ type: 'timeline-changed', sha });
      return;
    }

    const res = await fetch(url);
    if (!res.ok) {
      events.broadcast({
        type: 'sfx-error',
        placeholderId,
        status: res.status,
        message: `download ${url} → ${res.status}`,
      });
      const { timeline } = readTimeline();
      const next = removeAudioClip(timeline, placeholderId);
      const { sha } = await writeTimeline(TimelineSchema.parse(next));
      events.broadcast({ type: 'timeline-changed', sha });
      return;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const sfxDir = path.join(paths.assets, 'sfx');
    if (!existsSync(sfxDir)) mkdirSync(sfxDir, { recursive: true });
    // Preserve the source extension when we can; fall back to mp3.
    const extMatch = url.match(/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$|#)/i);
    const ext = (extMatch?.[1] ?? 'mp3').toLowerCase();
    const fname = `sfx_${Date.now().toString(36)}_${slugify(prompt)}.${ext}`;
    const dest = path.join(sfxDir, fname);
    writeFileSync(dest, buf);

    const duration = probeDuration(dest);
    const rel = path.relative(paths.project, dest);

    // Swap the placeholder for the real clip (src + out + naturalDuration).
    const { timeline } = readTimeline();
    const located = findAudioClip(timeline, placeholderId);
    if (!located) { events.broadcast({ type: 'sfx-error', placeholderId, message: 'placeholder vanished' }); return; }
    const merged: AudioClip = {
      ...located.clip,
      src: rel,
      out: duration,
      naturalDuration: duration,
      prompt,
      status: 'ready',
      errorMessage: null,
    };
    const next: Timeline = {
      ...timeline,
      audioTracks: timeline.audioTracks.map((t) => t.id !== located.track.id ? t : {
        ...t,
        clips: t.clips.map((c) => c.id === placeholderId ? merged : c),
      }),
    };
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    events.broadcast({ type: 'sfx-ready', placeholderId, relPath: rel, duration, prompt });
    events.broadcast({ type: 'asset-added', relPath: rel });
  } catch (err: any) {
    events.broadcast({ type: 'sfx-error', placeholderId, message: err?.message ?? String(err) });
  }
}
