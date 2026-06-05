/**
 * Helpers for the unified-audio model — placing clips on tracks, finding
 * collision-free lanes, picking the canonical track for a scene's audio.
 *
 * The model: every audio clip lives on some AudioTrack in
 * `timeline.audioTracks`. Tracks are user-labeled lanes; their position
 * in the array doubles as their order in the mixer + the lane label
 * (A1, A2, … unless the user named them). When a new clip would overlap
 * an existing clip on its preferred track, we look for the next track
 * with room — and if none has room, we add a new track at the bottom.
 *
 * Convention: A1 is the "video-linked audio" lane. Audio auto-extracted
 * from a clip on V1 lands there by default. The user can move it or
 * rename the lane afterwards.
 */
import type { Timeline, AudioTrack, AudioClip } from './schema.js';

function clipEnd(c: AudioClip): number { return c.start + (c.out - c.in); }

/** True iff [aS, aE] and [bS, bE] overlap (excluding bare touch). */
function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE - 1e-3 && bS < aE - 1e-3;
}

/** Pick the first track that has no clip overlapping [start, end]; if none
 *  fits and no preferred track is given, create a new track and return it.
 *  When `preferredTrackId` is set, that track is checked first; if it has
 *  a collision we skip to the next free track instead of refusing.
 *
 *  Returns the timeline with the (possibly new) track materialized and the
 *  id of the chosen track. Caller appends the actual clip after.
 */
export function findOrCreateAudioLane(
  timeline: Timeline,
  start: number,
  end: number,
  opts: { preferredTrackId?: string; ignoreClipId?: string } = {},
): { timeline: Timeline; trackId: string } {
  const collides = (track: AudioTrack): boolean => {
    for (const c of track.clips) {
      if (opts.ignoreClipId && c.id === opts.ignoreClipId) continue;
      if (overlaps(start, end, c.start, clipEnd(c))) return true;
    }
    return false;
  };

  // Reorder tracks so the preferred one is checked first.
  const ordered = [...timeline.audioTracks];
  if (opts.preferredTrackId) {
    const i = ordered.findIndex((t) => t.id === opts.preferredTrackId);
    if (i > 0) ordered.unshift(...ordered.splice(i, 1));
  }
  for (const tr of ordered) {
    if (!collides(tr)) return { timeline, trackId: tr.id };
  }

  // No track fits — append a new one. New id = a{N+1} where N is the
  // count of existing tracks; the renderer + UI accept arbitrary string
  // ids, but keeping the convention makes the lane labels readable.
  const newId = nextAudioTrackId(timeline);
  const newTrack: AudioTrack = { id: newId, label: null, gain: 0, clips: [] };
  return {
    timeline: { ...timeline, audioTracks: [...timeline.audioTracks, newTrack] },
    trackId: newId,
  };
}

/** Generate the next free `a{N}` id. */
export function nextAudioTrackId(timeline: Timeline): string {
  const used = new Set(timeline.audioTracks.map((t) => t.id));
  for (let i = 1; i < 1000; i++) {
    const candidate = `a${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `a_${Date.now().toString(36)}`;
}

/** Insert (or replace by id) a clip on the given track. */
export function insertAudioClip(timeline: Timeline, trackId: string, clip: AudioClip): Timeline {
  return {
    ...timeline,
    audioTracks: timeline.audioTracks.map((t) => t.id !== trackId ? t : {
      ...t,
      clips: [...t.clips.filter((c) => c.id !== clip.id), clip],
    }),
  };
}

/** Remove a clip by id from whichever track holds it. */
export function removeAudioClip(timeline: Timeline, clipId: string): Timeline {
  return {
    ...timeline,
    audioTracks: timeline.audioTracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => c.id !== clipId),
    })),
  };
}

/** Find an audio clip + its track by id. */
export function findAudioClip(timeline: Timeline, clipId: string): { track: AudioTrack; clip: AudioClip } | null {
  for (const t of timeline.audioTracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return null;
}

/** Find an audio clip linked to a specific scene (via linkId on a V clip
 *  with the same sceneId, or directly by id convention `sfx_<sceneId>`,
 *  or by an explicit linkSceneId-style match).
 *
 *  This is the LEGACY lookup — fast-path the canonical name first, then
 *  the linkId chain. Misses any unlinked VO clip a user dropped onto the
 *  scene's master-time window manually. For auto-caption, prefer
 *  `findCaptionAudioForScene` below which does proper overlap search. */
export function findSceneVoClip(timeline: Timeline, sceneId: string): { track: AudioTrack; clip: AudioClip } | null {
  // First try the canonical id (audio-extract uses `sfx_<sceneId>`).
  for (const t of timeline.audioTracks) {
    const direct = t.clips.find((c) => c.id === `sfx_${sceneId}` || c.id === `vo_${sceneId}` || c.id === sceneId);
    if (direct) return { track: t, clip: direct };
  }
  // Fall back to the linkId chain: find the V clip whose sceneId matches,
  // then find an audio clip with the same linkId.
  let linkId: string | null = null;
  for (const vt of timeline.tracks) {
    const vc = vt.clips.find((c) => c.sceneId === sceneId);
    if (vc?.linkId) { linkId = vc.linkId; break; }
  }
  if (linkId) {
    for (const t of timeline.audioTracks) {
      const c = t.clips.find((x) => x.linkId === linkId);
      if (c) return { track: t, clip: c };
    }
  }
  return null;
}

/**
 * Find the audio clip an auto-caption pass should transcribe for a scene.
 *
 * Old behaviour (findSceneVoClip): only finds the linked / canonically-named
 * VO clip. Misses the very common case where the user dropped a separate VO
 * file onto the timeline that overlaps the scene but isn't linked. The
 * captions then got generated for the WRONG audio (or fell through to
 * "no-vo-clip-for-scene").
 *
 * New behaviour: actually look at the scene's master-time window and find
 * whichever A-lane clip best matches what's audible there.
 *
 * Algorithm:
 *   1. Find the V-clip for `sceneId` → its master range [vStart, vEnd).
 *   2. Score every A-clip across every audio track:
 *        - score 0 if no time overlap with the V-clip's window
 *        - score 0 if kind === 'music' (we never caption music)
 *        - kind priority: vo / voice = 3 ; imported / generated = 2 ; sfx = 1
 *        - tie-break on overlap length (more overlap wins)
 *   3. Return the best, plus the source-time `in`/`out` of the OVERLAP
 *      window only — so we don't transcribe the parts of a long file that
 *      sit outside the scene.
 *
 * Returns null when the V-clip can't be found OR no eligible A-clip exists
 * (caller then falls back to caption-by-script or returns 404).
 */
export function findCaptionAudioForScene(
  timeline: Timeline,
  sceneId: string,
): { track: AudioTrack; clip: AudioClip; overlapInSec: number; overlapOutSec: number } | null {
  let vStart: number | null = null;
  let vEnd: number | null = null;
  for (const vt of timeline.tracks) {
    const vc = vt.clips.find((c) => c.sceneId === sceneId);
    if (vc) {
      const dur = (vc.out - vc.in) / (vc.rate || 1);
      vStart = vc.start;
      vEnd = vc.start + dur;
      break;
    }
  }
  // No V-clip on the timeline for this scene → fall back to the legacy
  // lookup, which at least returns the canonical sfx_<sceneId> if present.
  if (vStart === null || vEnd === null) {
    const legacy = findSceneVoClip(timeline, sceneId);
    if (!legacy) return null;
    return { track: legacy.track, clip: legacy.clip, overlapInSec: legacy.clip.in, overlapOutSec: legacy.clip.out };
  }

  let best: { track: AudioTrack; clip: AudioClip; overlapInSec: number; overlapOutSec: number; score: number } | null = null;

  const KIND_PRIORITY: Record<string, number> = {
    vo: 3,
    voice: 3,
    imported: 2,
    generated: 2,
    sfx: 1,
    // music intentionally absent — skipped below.
  };

  for (const t of timeline.audioTracks) {
    for (const c of t.clips) {
      if (c.kind === 'music') continue;
      const cStart = c.start;
      const cEnd = c.start + (c.out - c.in);
      const overlapStart = Math.max(cStart, vStart);
      const overlapEnd = Math.min(cEnd, vEnd);
      const overlapDur = overlapEnd - overlapStart;
      if (overlapDur <= 1e-3) continue;

      const prio = KIND_PRIORITY[c.kind] ?? 1;
      // Score: heavily weight kind priority, then overlap length, so a
      // 1s VO clip beats a 5s SFX clip but two VO clips compete on length.
      const score = prio * 1000 + overlapDur;
      if (!best || score > best.score) {
        // Convert master overlap window → source-time window inside `c`.
        const overlapInSec = c.in + (overlapStart - c.start);
        const overlapOutSec = c.in + (overlapEnd - c.start);
        best = { track: t, clip: c, overlapInSec, overlapOutSec, score };
      }
    }
  }
  if (!best) return null;
  return { track: best.track, clip: best.clip, overlapInSec: best.overlapInSec, overlapOutSec: best.overlapOutSec };
}
