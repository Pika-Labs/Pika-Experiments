/**
 * Scene-audio reconciler — runs whenever timeline.json changes and
 * extracts audio for any `status: 'ready'` scene that has a videoSrc
 * but no matching audio clip yet.
 *
 * Background: the canonical generation flow goes through
 * PATCH /scenes/:id which auto-extracts audio + wires a linked SFX
 * clip. But the agent sometimes writes timeline.json directly (via
 * write_file or other paths) and bypasses that hook entirely — leaving
 * 6 ready video clips with zero audio extraction. This reconciler is
 * the safety net: it runs on every timeline change, finds orphans, and
 * extracts. No agent action required.
 *
 * Triggered by the watcher (see watcher.ts) with a debounce so a burst
 * of edits doesn't fire N redundant extracts.
 */
import path from 'node:path';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { paths, readTimeline, writeTimeline } from '../state.js';
import { extractAudio } from './audio-extract.js';
import { findOrCreateAudioLane, insertAudioClip, findAudioClip, removeAudioClip } from '../audio-track-utils.js';
import { events } from '../events.js';
import type { Timeline } from '../schema.js';

// In-flight set so a second timeline-change while we're still
// extracting doesn't kick off a duplicate run for the same scene.
const inFlight = new Set<string>();

let pending: NodeJS.Timeout | null = null;
const DEBOUNCE_MS = 400;

export function scheduleReconcile(): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void reconcileSceneAudio();
  }, DEBOUNCE_MS);
}

async function reconcileSceneAudio(): Promise<void> {
  let timeline: Timeline;
  try { timeline = readTimeline().timeline; }
  catch { return; }

  // Find ready scenes missing extracted audio. Convention: extracted
  // audio for scene <id> lives as an AudioClip with id `sfx_<id>`.
  // If that clip already exists anywhere in audioTracks, this scene
  // is fine — skip.
  const orphans: { sceneId: string; videoSrc: string; replaceExisting?: boolean }[] = [];
  // Helper — has this scene's audio already been wired up under ANY
  // clip id? Three independent signals; if any match, we're done.
  // Defensive on purpose: this reconciler must NEVER duplicate-extract
  // a scene that already has audio in the timeline, no matter how the
  // agent originally wired it.
  const alreadyHasAudio = (sceneId: string): boolean => {
    // 1. Canonical convention: clip id = `sfx_<sceneId>`
    if (findAudioClip(timeline, `sfx_${sceneId}`)) return true;
    // 2. linkId match: any audio clip sharing the V1 clip's linkId
    const v1Clip = timeline.tracks.flatMap((tr) => tr.clips).find((c) => c.sceneId === sceneId);
    if (v1Clip?.linkId) {
      const linked = timeline.audioTracks?.some((t) => t.clips.some((c) => c.linkId === v1Clip.linkId));
      if (linked) return true;
    }
    // 3. src match: any audio clip already pointing at the extracted
    //    path we'd produce (handles the case where the agent named the
    //    clip differently but the file was already extracted).
    const expectedExtractRel = `assets/sfx/sc_${sceneId.replace(/^sc_/, '')}_audio.wav`;
    const fallbackExtractRel = `assets/sfx/${sceneId}_audio.wav`;
    const bySrc = timeline.audioTracks?.some((t) => t.clips.some((c) =>
      c.src === expectedExtractRel || c.src === fallbackExtractRel
    ));
    return !!bySrc;
  };

  // Tiny-file detector — a valid WAV is at minimum ~10KB even for a
  // 1-second clip. If the existing extracted file is < 2KB, ffmpeg
  // failed silently (often happens if extract ran while the source
  // video was mid-download). Wipe it + the audio clip referencing it,
  // and re-queue. The audio engine throws EncodingError on these and
  // blocks playback for every other clip in the timeline.
  const TINY_WAV_THRESHOLD = 2048;
  for (const s of timeline.scenes ?? []) {
    if (s.kind !== 'pika-gen') continue;
    if (s.status !== 'ready') continue;
    if (!s.videoSrc) continue;
    if (inFlight.has(s.id)) continue;

    // Check the canonical extract path for a tiny/corrupt file.
    const canonicalAudioRel = `assets/sfx/${s.id}.wav`;
    const canonicalAudioAbs = path.join(paths.project, canonicalAudioRel);
    let needsReextract = false;
    if (existsSync(canonicalAudioAbs)) {
      try {
        const size = statSync(canonicalAudioAbs).size;
        if (size < TINY_WAV_THRESHOLD) {
          console.warn(`[scene-audio-reconciler] ${canonicalAudioRel} is ${size}B (< ${TINY_WAV_THRESHOLD}) — corrupt, will delete + re-extract`);
          unlinkSync(canonicalAudioAbs);
          needsReextract = true;
        }
      } catch {/* stat failed — treat as missing */}
    }

    // Reconciler is now CORRUPT-FILE-RESCUE ONLY. We deliberately do
    // NOT create new audio clips for scenes that have never been
    // extracted — video clips own their audio embedded by default;
    // the user opts in to extraction via the per-clip Extract button.
    // The only case we still act on is `needsReextract`: a previously
    // extracted WAV has gone tiny/corrupt (e.g. ffmpeg ran mid-
    // download). In that case the audio clip already exists in the
    // timeline pointing at a broken file — leaving it would silently
    // mute that clip — so we re-extract to keep the existing A-lane
    // clip functional.
    if (!needsReextract) continue;

    orphans.push({ sceneId: s.id, videoSrc: s.videoSrc, replaceExisting: true });
  }
  if (orphans.length === 0) return;

  // Extract one at a time, refreshing the timeline between each so
  // concurrent writes don't clobber each other. ffmpeg per extract is
  // fast (~1-2s); this is fine.
  for (const o of orphans) {
    inFlight.add(o.sceneId);
    try {
      const videoAbs = path.join(paths.project, o.videoSrc);
      if (!existsSync(videoAbs)) continue;
      const result = await extractAudio(videoAbs, o.sceneId);
      if (!result.audioRel) continue;

      // Re-read the timeline (it may have changed during extract).
      let next = readTimeline().timeline;
      const clipId = `sfx_${o.sceneId}`;

      if (o.replaceExisting) {
        // Corrupt-file rescue path — wipe the stale audio clip (which
        // pointed at the just-deleted tiny WAV) so we can write the
        // fresh extract in its place.
        next = removeAudioClip(next, clipId);
      } else {
        // Idempotency re-check for new extractions (3-signal).
        const v1Now = next.tracks.flatMap((tr) => tr.clips).find((c) => c.sceneId === o.sceneId);
        const linkedNow = v1Now?.linkId && next.audioTracks?.some((t) => t.clips.some((c) => c.linkId === v1Now.linkId));
        const srcNow = next.audioTracks?.some((t) => t.clips.some((c) => c.src === result.audioRel));
        if (findAudioClip(next, clipId) || linkedNow || srcNow) continue;
      }

      // Find the V1 clip for this scene to anchor placement (same
      // start time, same linkId binding the audio to the video).
      const linkClip = next.tracks.flatMap((tr) => tr.clips).find((c) => c.sceneId === o.sceneId);
      const linkId = linkClip?.linkId ?? `lk_${o.sceneId}_${Date.now().toString(36).slice(-4)}`;
      // If the V1 clip exists and isn't yet linked, bind it.
      if (linkClip && !linkClip.linkId) {
        next = {
          ...next,
          tracks: next.tracks.map((tr) => ({
            ...tr,
            clips: tr.clips.map((c) => c.id === linkClip.id ? { ...c, linkId } : c),
          })),
        };
      }
      const audioClip = {
        id: clipId,
        src: result.audioRel,
        start: linkClip?.start ?? 0,
        in: linkClip?.in ?? 0,
        out: linkClip ? linkClip.in + (linkClip.out - linkClip.in) : result.durationSec,
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
      await writeTimeline(next);
      events.broadcast({ type: 'timeline-changed', sha: '' });
      console.log(`[scene-audio-reconciler] extracted audio for scene ${o.sceneId} → ${result.audioRel}`);
    } catch (err: any) {
      console.warn(`[scene-audio-reconciler] failed for scene ${o.sceneId}:`, err?.message ?? err);
    } finally {
      inFlight.delete(o.sceneId);
    }
  }
}
