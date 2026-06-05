/**
 * Scene CRUD — the agent loop's primary surface.
 *
 * • POST /scenes        → create a new pika-gen scene + clip on V1 at a given
 *                         start. Scene starts in status:'pending'; the agent
 *                         (this Claude conversation) picks it up, generates
 *                         via Pika MCP, then PATCHes it back to ready.
 * • GET  /scenes/pending → list pending pika-gen scenes for the agent.
 * • PATCH /scenes/:id   → partial update (used by the agent to set
 *                         status/videoSrc/errorMessage/costCredits).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readTimeline, writeTimeline, mutateTimeline, paths } from '../state.js';
import { createHash } from 'node:crypto';
import { TimelineSchema, type Timeline } from '../schema.js';
import { events } from '../events.js';
import { extractAudio } from '../workers/audio-extract.js';
import { detectSceneCuts } from '../workers/scene-detect.js';
import { splitClipAtMaster, rippleInsert } from '../agent/clip-ops.js';
import { findOrCreateAudioLane, insertAudioClip } from '../audio-track-utils.js';

const PostBody = z.object({
  prompt: z.string(),
  model: z.string().default('kling-v3-master'),
  duration: z.number().default(5),
  refs: z.array(z.string()).default([]),
  trackId: z.string().default('v1'),
  // OPTIONAL — not 0-defaulted. If the caller omits `startSec`, the server
  // computes "end of timeline" (max clip end across every video track) and
  // appends there. The old default of 0 silently dropped new clips at the
  // BEGINNING of the timeline, displacing everything else, which is the
  // bug the user kept hitting as "clips randomly added that mess up the
  // timeline." Pass an explicit startSec to override.
  startSec: z.number().optional(),
  labels: z.array(z.string()).optional(),
});

/** End of the longest video track on the master timeline. New clips are
 *  appended here by default so they never collide with existing content. */
function endOfTimelineForVideo(tl: Timeline): number {
  let max = 0;
  for (const tr of tl.tracks) {
    for (const c of tr.clips) {
      const end = c.start + (c.out - c.in) / (c.rate || 1);
      if (end > max) max = end;
    }
  }
  return Math.round(max * 1000) / 1000;
}

const PatchBody = z.object({
  status: z.enum(['pending', 'generating', 'ready', 'error']).optional(),
  videoSrc: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  costCredits: z.number().nullable().optional(),
  naturalDuration: z.number().optional(),
  sourceFps: z.number().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  refs: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
});

function nextSceneId(tl: Timeline): string {
  const n = tl.scenes.filter((s) => s.id.startsWith('sc_')).length + 1;
  return `sc_${n.toString().padStart(3, '0')}_${Date.now().toString(36).slice(-4)}`;
}
function nextClipId(tl: Timeline, sceneId: string): string {
  return `c_${sceneId}`;
}

export async function sceneRoutes(app: FastifyInstance): Promise<void> {
  app.post('/scenes', async (req, reply) => {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    const { prompt, model, duration, refs, trackId, labels } = parsed.data;
    const { timeline } = readTimeline();

    // Resolve startSec: explicit override wins; otherwise append to the end
    // of the timeline. This is the architectural choice — server keeps the
    // "where does this go" state, agents and UI just declare intent.
    const startSec = typeof parsed.data.startSec === 'number'
      ? parsed.data.startSec
      : endOfTimelineForVideo(timeline);

    const sceneId = nextSceneId(timeline);
    const scene = {
      id: sceneId,
      kind: 'pika-gen' as const,
      prompt,
      model,
      refs,
      status: 'pending' as const,
      videoSrc: null,
      errorMessage: null,
      naturalDuration: duration,
      sourceFps: 24,
      costCredits: null,
      labels: labels ?? [prompt.slice(0, 40)],
    };
    const clipId = nextClipId(timeline, sceneId);
    const clip = {
      id: clipId,
      trackId,
      sceneId,
      start: Math.max(0, Math.round(startSec * 1000) / 1000),
      in: 0,
      out: duration,
      rate: 1,
      fadeIn: 0,
      fadeOut: 0,
      smoothFps: false,
      gain: 0,
      linkId: null,
      comments: [],
    };
    // Ripple-insert: if the new clip lands MID-timeline (anything has
    // start >= clip.start), shift every downstream item — V clips on
    // every track, audio clips, caption rows, floating comments —
    // forward by the new clip's master duration. Without this, the
    // inserted clip would visually overlap existing content and
    // captions/audio would drift out of sync with the new picture.
    //
    // When the new clip lands at end-of-timeline (typical path), there
    // are no items past clip.start so rippleInsert is a no-op.
    const rippled = rippleInsert(timeline, clip.start, duration);
    const next: Timeline = {
      ...rippled,
      scenes: [...rippled.scenes, scene],
      tracks: rippled.tracks.map((tr) => tr.id === trackId
        ? { ...tr, clips: [...tr.clips, clip].sort((a, b) => a.start - b.start) }
        : tr),
      // Auto-extend timeline duration to fit either the new clip OR the
      // shifted downstream content (whichever ends later).
      duration: Math.max(rippled.duration, clip.start + duration),
    };
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true, sceneId, clipId };
  });

  app.get('/scenes/pending', async () => {
    const { timeline } = readTimeline();
    const pending = timeline.scenes
      .filter((s) => s.kind === 'pika-gen' && (s.status === 'pending' || s.status === 'error'));
    return { pending };
  });

  app.patch<{ Params: { id: string } }>('/scenes/:id', async (req, reply) => {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }

    // PHASE 1 (outside actor lock): pre-flight validation + scene-cut
    // detection. These are the slow / network / ffmpeg operations. Doing
    // them OUTSIDE the actor means we don't hold the lock while ffmpeg
    // runs (could be seconds). The race-safe commit happens in PHASE 2.
    const { timeline: preTl } = readTimeline();
    const preIdx = preTl.scenes.findIndex((s) => s.id === req.params.id);
    if (preIdx < 0) { reply.code(404); return { error: `scene not found: ${req.params.id}` }; }
    const preOrig = preTl.scenes[preIdx];
    if (preOrig.kind !== 'pika-gen') { reply.code(400); return { error: `cannot patch non-pika-gen scene (${preOrig.kind})` }; }

    // Run scene-cut detection (slow) before we acquire the actor lock.
    // We use the data from `parsed.data` (the proposed patch) since the
    // ffmpeg input is the videoSrc the caller is asking us to bind.
    const prospectiveMerged = { ...preOrig, ...parsed.data };
    let detectedCuts: number[] = [];
    const flippedToReady = parsed.data.status === 'ready' && preOrig.status !== 'ready';
    const isReadyAndOrphan = prospectiveMerged.status === 'ready' && prospectiveMerged.videoSrc
      && !preTl.audioTracks.some((t) => t.clips.some((c) => c.id === `sfx_${req.params.id}`));
    if ((flippedToReady || isReadyAndOrphan) && prospectiveMerged.videoSrc) {
      const videoAbs = path.join(paths.project, prospectiveMerged.videoSrc);
      if (existsSync(videoAbs)) {
        try { detectedCuts = await detectSceneCuts(videoAbs); }
        catch (err: any) { app.log.warn({ err: String(err?.message ?? err) }, 'scene-cut detection failed (non-fatal)'); }
      }
    }

    // PHASE 2 (inside actor lock): commit atomically. The fn reads FRESH
    // timeline state (whatever is on disk at the moment our turn in the
    // queue runs), applies the patch + any cuts, returns the next state.
    // Two parallel PATCHes for different scenes now queue and merge
    // cleanly instead of clobbering each other.
    type Result = { ok: true; scene: any; sha: string; status: string | undefined } | { ok: false; code: number; body: any };
    const result = await mutateTimeline<Result>((tl) => {
      const idx = tl.scenes.findIndex((s) => s.id === req.params.id);
      if (idx < 0) return { next: tl, result: { ok: false, code: 404, body: { error: `scene not found: ${req.params.id}` } } };
      const orig = tl.scenes[idx];
      if (orig.kind !== 'pika-gen') return { next: tl, result: { ok: false, code: 400, body: { error: `cannot patch non-pika-gen scene (${orig.kind})` } } };
      const merged = { ...orig, ...parsed.data };
      let next: Timeline = {
        ...tl,
        scenes: tl.scenes.map((s, i) => (i === idx ? merged : s)),
      };
      if (detectedCuts.length > 0 && merged.status === 'ready' && (merged as any).videoSrc) {
        let workingId = next.tracks.flatMap((tr) => tr.clips).find((c) => c.sceneId === req.params.id)?.id;
        if (workingId) {
          const baseClipStart = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === workingId)!.start;
          for (const cutSec of detectedCuts) {
            const atMasterTime = baseClipStart + cutSec;
            const r = splitClipAtMaster(next, workingId!, atMasterTime);
            if ('error' in r) break;
            next = r.timeline;
            workingId = r.secondHalfId;
          }
        }
      }
      const validated = TimelineSchema.parse(next);
      const json = JSON.stringify(validated, null, 2) + '\n';
      const sha = createHash('sha256').update(json).digest('hex');
      return { next: validated, result: { ok: true, scene: merged, sha, status: parsed.data.status } };
    });
    if (!result.ok) { reply.code(result.code); return result.body; }
    // Actor's onCommit already broadcasts timeline-changed; we add the
    // gen-progress event since the actor doesn't know about that.
    if (result.status) {
      events.broadcast({ type: 'pika-gen-progress', sceneId: req.params.id, status: result.status as any });
    }
    return { ok: true, scene: result.scene };
  });

  /**
   * POST /clips/:clipId/extract-audio
   *
   * User-driven audio extraction. Runs ffmpeg on the V clip's source
   * video, writes the WAV under assets/sfx/<sceneId>.wav, inserts an
   * A-lane clip with id `sfx_<sceneId>` linked via a fresh shared
   * linkId. Replaces auto-extract — the old PATCH /scenes/:id hook
   * no longer fires automatically. Idempotent: if an A-lane clip
   * already exists for this scene, returns ok without re-extracting.
   */
  app.post<{ Params: { clipId: string } }>('/clips/:clipId/extract-audio', async (req, reply) => {
    const { timeline } = readTimeline();
    const vClip = timeline.tracks.flatMap((tr) => tr.clips).find((c) => c.id === req.params.clipId);
    if (!vClip) { reply.code(404); return { error: `clip not found: ${req.params.clipId}` }; }
    const sceneId = vClip.sceneId;
    const scene = timeline.scenes.find((s) => s.id === sceneId);
    if (!scene || scene.kind !== 'pika-gen' || !scene.videoSrc) {
      // Imports + non-gen scenes: still pull the videoSrc off the scene
      // record if present. Otherwise reject — nothing to extract from.
      const importSrc = (scene as { src?: string } | undefined)?.src;
      if (!importSrc) { reply.code(400); return { error: 'clip has no source video to extract from' }; }
    }
    const videoRel = scene && scene.kind === 'pika-gen' ? scene.videoSrc : (scene as unknown as { src?: string })?.src;
    if (!videoRel) { reply.code(400); return { error: 'clip has no source video to extract from' }; }
    const videoAbs = path.join(paths.project, videoRel);
    if (!existsSync(videoAbs)) { reply.code(404); return { error: `source file missing: ${videoRel}` }; }

    // Already extracted? Just return the existing A-lane clip's info.
    const existing = timeline.audioTracks
      .flatMap((tr) => tr.clips.map((c) => ({ c, trackId: tr.id })))
      .find((x) => x.c.id === `sfx_${sceneId}`);
    if (existing) {
      return { ok: true, audioClipId: existing.c.id, trackId: existing.trackId, reused: true };
    }

    let result;
    try { result = await extractAudio(videoAbs, sceneId); }
    catch (err: any) { reply.code(500); return { error: 'extract failed', detail: String(err?.message ?? err) }; }
    if (!result.audioRel) { reply.code(204); return { error: 'no audio track in source video' }; }

    // Wire up a fresh shared linkId on both sides.
    const linkId = vClip.linkId ?? `lk_${sceneId}_${Date.now().toString(36).slice(-4)}`;
    let next: Timeline = {
      ...timeline,
      tracks: timeline.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => (c.id === vClip.id && !c.linkId ? { ...c, linkId } : c)),
      })),
    };
    const audioClip = {
      id: `sfx_${sceneId}`,
      src: result.audioRel,
      start: vClip.start,
      in: vClip.in,
      out: vClip.in + (vClip.out - vClip.in),
      gain: 0,
      fadeIn: 0,
      fadeOut: 0,
      linkId,
      prompt: null,
      naturalDuration: result.durationSec,
      kind: 'vo' as const,
      status: 'ready' as const,
      errorMessage: null,
    };
    const start = audioClip.start;
    const end = start + (audioClip.out - audioClip.in);
    const placement = findOrCreateAudioLane(next, start, end, {
      preferredTrackId: next.audioTracks[0]?.id,
    });
    next = insertAudioClip(placement.timeline, placement.trackId, audioClip);

    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true, audioClipId: audioClip.id, trackId: placement.trackId, reused: false };
  });

  app.delete<{ Params: { id: string } }>('/scenes/:id', async (req, reply) => {
    const { timeline } = readTimeline();
    if (!timeline.scenes.find((s) => s.id === req.params.id)) {
      reply.code(404); return { error: 'scene not found' };
    }
    const next: Timeline = {
      ...timeline,
      scenes: timeline.scenes.filter((s) => s.id !== req.params.id),
      tracks: timeline.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => c.sceneId !== req.params.id) })),
    };
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true };
  });
}
