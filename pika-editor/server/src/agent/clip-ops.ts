/**
 * Pure timeline operations shared between the agent's split_clip tool and
 * the server-side auto-split hook in routes/scenes.ts. No I/O — takes a
 * Timeline + clipId + atMasterTime, returns the next Timeline.
 *
 * The contract matches the agent tool: first half keeps the original id +
 * linkId; second half gets a fresh id (suffix _b, _c, ...) and a brand new
 * linkId. If the original clip has a linked SFX clip on S1, that SFX clip
 * is split at the same master-time with the matching new linkId on its
 * second half — so each (V1, S1) pair moves independently after the cut.
 */
import type { Timeline, Clip } from '../schema.js';

export interface SplitResult {
  timeline: Timeline;
  firstHalfId: string;
  secondHalfId: string;
}

export function splitClipAtMaster(timeline: Timeline, clipId: string, atMasterTime: number): SplitResult | { error: string } {
  let trackIdx = -1, clipIdx = -1, clip: Clip | undefined;
  for (let ti = 0; ti < timeline.tracks.length; ti++) {
    const ci = timeline.tracks[ti].clips.findIndex((c) => c.id === clipId);
    if (ci >= 0) { trackIdx = ti; clipIdx = ci; clip = timeline.tracks[ti].clips[ci]; break; }
  }
  if (!clip || trackIdx < 0) return { error: `clip not found: ${clipId}` };
  const clipDur = clip.out - clip.in;
  const clipEnd = clip.start + clipDur;
  if (atMasterTime <= clip.start + 1e-3 || atMasterTime >= clipEnd - 1e-3) {
    return { error: `atMasterTime ${atMasterTime}s outside (${clip.start.toFixed(3)}, ${clipEnd.toFixed(3)})` };
  }
  const localT = atMasterTime - clip.start + clip.in;
  const newLinkId = clip.linkId ? `lk_${Date.now().toString(36).slice(-6)}${Math.floor(Math.random() * 1000).toString(36)}` : null;
  const newClipId = nextSuffixId(timeline.tracks.flatMap((t) => t.clips).map((c) => c.id), clip.id);

  const firstHalf: Clip = { ...clip, out: localT };
  const secondHalf: Clip = { ...clip, id: newClipId, start: atMasterTime, in: localT, linkId: newLinkId };

  const nextTracks = timeline.tracks.map((tr, ti) => ti === trackIdx ? {
    ...tr,
    clips: [
      ...tr.clips.slice(0, clipIdx),
      firstHalf,
      secondHalf,
      ...tr.clips.slice(clipIdx + 1),
    ],
  } : tr);

  // Propagate the split to any audio clips on any audio track that share
  // the trimmed clip's linkId. Each matching audio clip is split at the
  // same master time; the second half gets a fresh linkId so the (V,A)
  // pair becomes two independent (V,A) pairs after the cut.
  let nextAudioTracks = timeline.audioTracks;
  if (clip.linkId) {
    const allAudioIds = nextAudioTracks.flatMap((t) => t.clips.map((c) => c.id));
    nextAudioTracks = nextAudioTracks.map((track) => {
      const newClips: typeof track.clips = [];
      for (const sx of track.clips) {
        if (sx.linkId !== clip.linkId) { newClips.push(sx); continue; }
        const sxDur = sx.out - sx.in;
        const sxEnd = sx.start + sxDur;
        if (atMasterTime <= sx.start + 1e-3 || atMasterTime >= sxEnd - 1e-3) {
          newClips.push(sx);
          continue;
        }
        const sxLocalT = atMasterTime - sx.start + sx.in;
        const sxNewId = nextSuffixId(allAudioIds, sx.id);
        allAudioIds.push(sxNewId);
        newClips.push({ ...sx, out: sxLocalT });
        newClips.push({ ...sx, id: sxNewId, start: atMasterTime, in: sxLocalT, linkId: newLinkId });
      }
      return { ...track, clips: newClips };
    });
  }

  return {
    timeline: { ...timeline, tracks: nextTracks, audioTracks: nextAudioTracks },
    firstHalfId: clip.id,
    secondHalfId: newClipId,
  };
}

function nextSuffixId(existingIds: string[], baseId: string): string {
  const used = new Set(existingIds);
  for (const suf of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
    const candidate = `${baseId}_${suf}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${baseId}_${Date.now().toString(36).slice(-4)}`;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Premiere-style ripple INSERT. Shift every clip / row / floating
 * comment whose master-time start is >= `editPoint` forward by
 * `shiftDelta` seconds. Used when the server (or agent) inserts a new
 * clip mid-timeline — otherwise the inserted clip would collide with
 * existing content. Mirrors the client's rippleAllDownstream in
 * edit.ts but on the server's Timeline type.
 *
 * The `exemptClipId`, when set, is left in place (used when the
 * inserter places the new clip at editPoint and doesn't want it
 * shoved further forward).
 *
 * Touched fields:
 *   - tracks[*].clips[*].start (video)
 *   - audioTracks[*].clips[*].start (all audio kinds)
 *   - captions.rows[*].start + .end (preserve duration)
 *   - floatingComments[*].at
 *
 * No-op when `shiftDelta` is effectively zero. Negative shifts pull
 * downstream content forward (used by upstream trim cascades; unused
 * here but kept for symmetry with the client helper).
 */
export function rippleInsert(timeline: Timeline, editPoint: number, shiftDelta: number, exemptClipId?: string): Timeline {
  if (Math.abs(shiftDelta) < 1e-4) return timeline;
  const past = (start: number): boolean => start >= editPoint - 1e-3;
  return {
    ...timeline,
    tracks: timeline.tracks.map((tr) => ({
      ...tr,
      clips: tr.clips.map((c) => (c.id === exemptClipId || !past(c.start)
        ? c
        : { ...c, start: round3(Math.max(0, c.start + shiftDelta)) })),
    })),
    audioTracks: timeline.audioTracks.map((tr) => ({
      ...tr,
      clips: tr.clips.map((c) => (past(c.start)
        ? { ...c, start: round3(Math.max(0, c.start + shiftDelta)) }
        : c)),
    })),
    captions: {
      ...timeline.captions,
      rows: timeline.captions.rows.map((r) => {
        if (!past(r.start)) return r;
        const dur = r.end - r.start;
        const newStart = Math.max(0, r.start + shiftDelta);
        return { ...r, start: round3(newStart), end: round3(newStart + dur) };
      }),
    },
    floatingComments: (timeline.floatingComments ?? []).map((fc) =>
      past(fc.at) ? { ...fc, at: round3(Math.max(0, fc.at + shiftDelta)) } : fc,
    ),
  };
}
