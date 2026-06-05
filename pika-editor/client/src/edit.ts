/**
 * Pure timeline mutation helpers. Each function takes a Timeline and returns
 * a new one — never mutating in place. The store wraps these to register
 * undo entries.
 *
 * Linked siblings: clips and SFX clips can share a `linkId`. When set, edit
 * ops on the video clip apply the same delta to the SFX sibling so agent-
 * extracted audio stays bound to picture. Patched in via `applyLinkedSiblings`
 * inside each op below.
 */
import type { Timeline, Clip, Track } from './types';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Effective duration of the timeline — the rightmost edge of any clip on
 * any video or audio track. Replaces the stored `timeline.duration` field
 * for client-side display + scrolling: the timeline now grows and shrinks
 * with content automatically instead of being pinned to a fixed length.
 *
 * Captions are intentionally NOT counted — a stray caption row past the
 * last clip shouldn't extend the working surface; the editor's "length"
 * is the length of its material. Returns 0 for an empty timeline.
 */
export function effectiveDuration(tl: Timeline): number {
  let max = 0;
  for (const tr of tl.tracks) {
    for (const c of tr.clips) {
      const end = c.start + (c.out - c.in) / (c.rate || 1);
      if (end > max) max = end;
    }
  }
  for (const tr of tl.audioTracks ?? []) {
    for (const c of tr.clips) {
      const end = c.start + (c.out - c.in);
      if (end > max) max = end;
    }
  }
  return max;
}

function applyLinkedSiblings(tl: Timeline, before: Clip, after: Clip): Timeline {
  const linkId = after.linkId ?? before.linkId;
  if (!linkId) return tl;
  const dStart = after.start - before.start;
  const dIn = after.in - before.in;
  const dOut = after.out - before.out;
  if (Math.abs(dStart) < 1e-4 && Math.abs(dIn) < 1e-4 && Math.abs(dOut) < 1e-4) return tl;
  // Propagate the V-clip delta to every audio clip on every track that
  // shares the linkId. Tracks are independent, but a single linkId binds
  // one specific audio clip to its V counterpart so the chain works
  // regardless of which audio track the user moved the audio onto.
  return {
    ...tl,
    audioTracks: tl.audioTracks.map((tr) => ({
      ...tr,
      clips: tr.clips.map((s) => {
        if (s.linkId !== linkId) return s;
        const newIn = round3(Math.max(0, s.in + dIn));
        const newOut = round3(Math.max(newIn + 0.05, s.out + dOut));
        return { ...s, start: round3(Math.max(0, s.start + dStart)), in: newIn, out: newOut };
      }),
    })),
  };
}

// Convenience: walk every video op result. Each op returns the next Timeline;
// we look up the same clip's `before` (in `tl`) and `after` (in next) and run
// applyLinkedSiblings to ripple the change into SFX.
export function linkAfter(tl: Timeline, next: Timeline, clipId: string): Timeline {
  const before = findClip(tl, clipId)?.clip;
  const after = findClip(next, clipId)?.clip;
  if (!before || !after) return next;
  return applyLinkedSiblings(next, before, after);
}

export function findClip(tl: Timeline, clipId: string): { clip: Clip; trackId: string } | null {
  for (const tr of tl.tracks) {
    const c = tr.clips.find((c) => c.id === clipId);
    if (c) return { clip: c, trackId: tr.id };
  }
  return null;
}

// Source duration of the underlying media for a clip's scene. Used to clamp
// trim/extend so a clip can't be stretched past the actual source. Image
// overlays are stills — they have no "source duration" to exceed — so we
// hand the trimmer a generous ceiling instead of the 3s schema default,
// otherwise the right-edge drag locks at 3s even though the image can
// stay on screen as long as the user wants.
function sourceDurationFor(tl: Timeline, clip: Clip): number {
  const scene = tl.scenes.find((s) => s.id === clip.sceneId);
  if (scene?.kind === 'image-overlay') return 3600;
  return Math.max(0.1, scene?.naturalDuration ?? 5);
}

// Master end position of a clip on the timeline (start + master duration).
function clipEnd(c: Clip): number {
  return c.start + (c.out - c.in) / c.rate;
}

// Neighbors on the same track sorted by start time (excluding `clipId`).
function trackNeighbors(tl: Timeline, clipId: string): { trackId: string; prev: Clip | null; next: Clip | null; selfDur: number } {
  for (const tr of tl.tracks) {
    const self = tr.clips.find((c) => c.id === clipId);
    if (!self) continue;
    const others = tr.clips.filter((c) => c.id !== clipId).sort((a, b) => a.start - b.start);
    let prev: Clip | null = null;
    let next: Clip | null = null;
    for (const o of others) {
      if (clipEnd(o) <= self.start + 1e-3) prev = o;
      else if (o.start >= self.start + (self.out - self.in) / self.rate - 1e-3) { next = o; break; }
    }
    return { trackId: tr.id, prev, next, selfDur: (self.out - self.in) / self.rate };
  }
  return { trackId: '', prev: null, next: null, selfDur: 0 };
}

function patchClip(tl: Timeline, clipId: string, patch: Partial<Clip>): Timeline {
  return {
    ...tl,
    tracks: tl.tracks.map((tr) => ({
      ...tr,
      clips: tr.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
    })),
  };
}

// Snap a value to the nearest beat (or downbeat) within tolerance (seconds).
// Default tolerance is intentionally tight (25ms ≈ 2px at the default zoom of
// 80 px/s) so snap doesn't feel sticky — moving the cursor a few pixels past
// a beat releases the snap. Callers that want zoom-adaptive snap should
// compute tolerance themselves; the store currently uses the default.
export function snap(value: number, beats: number[], tolerance = 0.025): number {
  if (!beats || beats.length === 0) return round3(value);
  let best = beats[0];
  let bestDist = Math.abs(value - beats[0]);
  for (const b of beats) {
    const d = Math.abs(value - b);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return bestDist <= tolerance ? round3(best) : round3(value);
}

// Collect every clip's start AND end time across every video track. Used as
// extra snap candidates so a V2 clip can dock cleanly to a V1 clip's edge
// (and vice-versa). Excludes the clip currently being dragged so it doesn't
// snap to itself.
export function allClipEdges(tl: Timeline, excludeId?: string): number[] {
  const edges: number[] = [];
  for (const tr of tl.tracks) {
    for (const c of tr.clips) {
      if (excludeId && c.id === excludeId) continue;
      edges.push(c.start);
      edges.push(c.start + (c.out - c.in) / c.rate);
    }
  }
  return edges;
}

// Loose tolerance for cross-track edge docking. Beat-snap stays tight (0.025s)
// because beats are dense; clip edges are sparse so a 50ms catch zone reads
// as deliberate "I want to dock here" without being twitchy.
const EDGE_SNAP_TOLERANCE = 0.05;

// MOVE — drag a clip horizontally. Blocked by neighbors on the same track
// (Premier-style: clips can't overlap; movement clamps to the gap edge).
export function moveClip(tl: Timeline, clipId: string, newStart: number, beats: number[], snapEnabled: boolean): Timeline {
  // Snap candidates: beats (tight) + cross-track clip edges (looser). Run beat
  // snap first; if it didn't land, try edge snap with the looser tolerance.
  let proposed = snapEnabled ? snap(newStart, beats) : Math.max(0, round3(newStart));
  if (snapEnabled && proposed === round3(newStart)) {
    proposed = snap(newStart, allClipEdges(tl, clipId), EDGE_SNAP_TOLERANCE);
  }
  const { prev, next, selfDur } = trackNeighbors(tl, clipId);
  const minStart = prev ? clipEnd(prev) : 0;
  const maxStart = next ? next.start - selfDur : Number.POSITIVE_INFINITY;
  const clamped = Math.max(minStart, Math.min(maxStart, Math.max(0, proposed)));
  return patchClip(tl, clipId, { start: round3(clamped) });
}

// TRIM LEFT — drag the left edge. Moves both `start` and `in` by Δ * rate.
// (Because the source point that lives at the new start = old in + Δ * rate.)
// Blocked by previous neighbor's end and by `in >= 0`.
//
// Snap order: beats (tight) → other clip edges (loose) → playhead (loose).
// Including the playhead lets the user dock the trim point to "where I'm
// scrubbed to right now", which is what musicians/editors actually want
// when they hear/see a moment and want a cut there.
export function trimLeft(tl: Timeline, clipId: string, deltaSec: number, beats: number[], snapEnabled: boolean, playhead?: number): Timeline {
  const found = findClip(tl, clipId);
  if (!found) return tl;
  const { clip } = found;
  const { prev } = trackNeighbors(tl, clipId);
  const proposedStart = clip.start + deltaSec;
  let snappedStart = snapEnabled ? snap(proposedStart, beats) : proposedStart;
  if (snapEnabled && snappedStart === round3(proposedStart)) {
    const extras = playhead !== undefined ? [...allClipEdges(tl, clipId), playhead] : allClipEdges(tl, clipId);
    snappedStart = snap(proposedStart, extras, EDGE_SNAP_TOLERANCE);
  }
  // Bounds: can't go before previous neighbor's end, can't expose negative
  // source time, can't cross the right edge.
  const minStartByNeighbor = prev ? clipEnd(prev) : 0;
  const minStartBySource = Math.max(0, clip.start - clip.in / clip.rate);
  const minStart = Math.max(minStartByNeighbor, minStartBySource);
  const maxStart = clip.start + (clip.out - clip.in - 0.01) / clip.rate;
  const finalStart = Math.max(minStart, Math.min(maxStart, snappedStart));
  const finalIn = clip.in + (finalStart - clip.start) * clip.rate;
  return patchClip(tl, clipId, { start: round3(finalStart), in: round3(Math.max(0, finalIn)) });
}

// TRIM RIGHT — drag the right edge. Adjusts `out`. Bounds:
//   • can't extend past the source media's natural duration (no
//     "freeze the last frame" padding — if you want longer, generate
//     more or use stretch). out ≤ sourceDur.
//   • can't overlap next neighbor on the same track
//   • can't be shorter than 0.05s
export function trimRight(tl: Timeline, clipId: string, deltaSec: number, beats: number[], snapEnabled: boolean, playhead?: number): Timeline {
  const found = findClip(tl, clipId);
  if (!found) return tl;
  const { clip } = found;
  const { next } = trackNeighbors(tl, clipId);
  const currentEnd = clip.start + (clip.out - clip.in) / clip.rate;
  const proposedEnd = currentEnd + deltaSec;
  let snappedEnd = snapEnabled ? snap(proposedEnd, beats) : proposedEnd;
  if (snapEnabled && snappedEnd === round3(proposedEnd)) {
    const extras = playhead !== undefined ? [...allClipEdges(tl, clipId), playhead] : allClipEdges(tl, clipId);
    snappedEnd = snap(proposedEnd, extras, EDGE_SNAP_TOLERANCE);
  }
  // Source duration caps how far `out` can grow. The container can't
  // exceed the underlying media's length — past that you'd be asking
  // for content that doesn't exist.
  const sourceDur = sourceDurationFor(tl, clip);
  const maxEndBySource = clip.start + (sourceDur - clip.in) / clip.rate;
  const maxEndByNeighbor = next ? next.start : Number.POSITIVE_INFINITY;
  const maxEnd = Math.min(maxEndBySource, maxEndByNeighbor);
  const minEnd = clip.start + 0.05 / clip.rate;
  const finalEnd = Math.max(minEnd, Math.min(maxEnd, snappedEnd));
  const newOut = clip.in + (finalEnd - clip.start) * clip.rate;
  return patchClip(tl, clipId, { out: round3(newOut) });
}

/**
 * Shift every item on the timeline whose start is at or past `editPoint`
 * by `shiftDelta` seconds — across V1/V2 video tracks, music, SFX, and
 * caption rows. This is the "downstream sweep" Premiere-style ripple
 * relies on: trim a clip and everything behind it slides along, no matter
 * which lane it's on. The clip being trimmed (`anchorClipId`) is exempt;
 * its own start stays where it is and its in/out get edited separately.
 */
function rippleAllDownstream(tl: Timeline, editPoint: number, shiftDelta: number, anchorClipId: string): Timeline {
  if (Math.abs(shiftDelta) < 1e-4) return tl;
  const past = (start: number): boolean => start >= editPoint - 1e-3;
  return {
    ...tl,
    tracks: tl.tracks.map((tr) => ({
      ...tr,
      clips: tr.clips.map((c) => (c.id === anchorClipId || !past(c.start)
        ? c
        : { ...c, start: round3(Math.max(0, c.start + shiftDelta)) })),
    })),
    audioTracks: tl.audioTracks.map((tr) => ({
      ...tr,
      clips: tr.clips.map((c) => (past(c.start)
        ? { ...c, start: round3(Math.max(0, c.start + shiftDelta)) }
        : c)),
    })),
    captions: {
      ...tl.captions,
      rows: tl.captions.rows.map((r) => {
        if (!past(r.start)) return r;
        const dur = r.end - r.start;
        const newStart = Math.max(0, r.start + shiftDelta);
        return { ...r, start: round3(newStart), end: round3(newStart + dur) };
      }),
    },
  };
}

// RIPPLE TRIM RIGHT — Premiere-style. Drag B's right edge: B.out changes
// and EVERY item downstream of B's old end shifts by the same delta —
// video clips on every track, music, SFX, and caption rows. The ripple
// preserves butted relationships across the whole timeline, not just B's
// own track. Upper bound: source media's natural duration — the container
// cannot exceed the underlying clip's length (matches select-tool trim).
// Lower bound stays at 0.05s.
export function rippleTrimRight(tl: Timeline, clipId: string, deltaSec: number, beats: number[], snapEnabled: boolean, playhead?: number): Timeline {
  const found = findClip(tl, clipId);
  if (!found) return tl;
  const { clip } = found;
  const currentEnd = clip.start + (clip.out - clip.in) / clip.rate;
  const proposedEnd = currentEnd + deltaSec;
  let snappedEnd = snapEnabled ? snap(proposedEnd, beats) : proposedEnd;
  if (snapEnabled && snappedEnd === round3(proposedEnd)) {
    const extras = playhead !== undefined ? [...allClipEdges(tl, clipId), playhead] : allClipEdges(tl, clipId);
    snappedEnd = snap(proposedEnd, extras, EDGE_SNAP_TOLERANCE);
  }
  // Source-duration cap — same rule as the select-tool trim. Without it,
  // ripple lets the container stretch past the underlying media and the
  // video freezes on its last frame.
  const sourceDur = sourceDurationFor(tl, clip);
  const maxEndBySource = clip.start + (sourceDur - clip.in) / clip.rate;
  const minEnd = clip.start + 0.05 / clip.rate;
  const finalEnd = Math.max(minEnd, Math.min(maxEndBySource, snappedEnd));
  const shiftDelta = finalEnd - currentEnd;
  const newOut = clip.in + (finalEnd - clip.start) * clip.rate;
  const trimmed = patchClip(tl, clipId, { out: round3(newOut) });
  return rippleAllDownstream(trimmed, currentEnd, shiftDelta, clipId);
}

// RIPPLE TRIM LEFT — Premier-style head trim with ripple. B.start stays
// anchored (so B remains butted to whatever was on its left); B.in adjusts
// to trim or restore the head; B's right edge moves with the cursor; every
// downstream item across ALL lanes (video tracks, music, SFX, captions)
// shifts by the same delta to stay butted to B's new end. Bounds:
// in ∈ [0, out - 0.05*rate].
export function rippleTrimLeft(tl: Timeline, clipId: string, deltaSec: number, beats: number[], snapEnabled: boolean, playhead?: number): Timeline {
  const found = findClip(tl, clipId);
  if (!found) return tl;
  const { clip } = found;
  // Snap the *new master end* (clip.start + new master dur) to beats — that's
  // where the visible right edge will land, and beat-snap on the moving edge
  // is far more useful than snapping the in-point.
  const oldEnd = clip.start + (clip.out - clip.in) / clip.rate;
  const proposedEnd = oldEnd - deltaSec; // dragging left edge right shrinks → end moves left
  let snappedEnd = snapEnabled ? snap(proposedEnd, beats) : proposedEnd;
  if (snapEnabled && snappedEnd === round3(proposedEnd)) {
    const extras = playhead !== undefined ? [...allClipEdges(tl, clipId), playhead] : allClipEdges(tl, clipId);
    snappedEnd = snap(proposedEnd, extras, EDGE_SNAP_TOLERANCE);
  }
  // Convert back to dx in master time.
  const dxMaster = oldEnd - snappedEnd;
  // Bounds on newIn ∈ [0, out - 0.05*rate]
  const proposedNewIn = clip.in + dxMaster * clip.rate;
  const minNewIn = 0;
  const maxNewIn = clip.out - 0.05 * clip.rate;
  const newIn = Math.max(minNewIn, Math.min(maxNewIn, proposedNewIn));
  const realDelta = (newIn - clip.in) / clip.rate; // positive = trimmed head off
  const trimmed = patchClip(tl, clipId, { in: round3(newIn) });
  // Downstream items shift LEFT by realDelta (negative delta = restore = shift right).
  return rippleAllDownstream(trimmed, oldEnd, -realDelta, clipId);
}

// RIPPLE MOVE — drag a clip's body in ripple mode: shifts the anchor
// PLUS every clip/audio-clip/caption-row whose ID is in the captured
// `group`. The caller snapshots the moving group once at drag start (via
// `computeRippleMoveGroup`) and passes it on every increment — this avoids
// the editPoint-drift bug where dragging left would otherwise pick up
// clips originally just in front of the anchor.
export interface RippleMoveGroup {
  videoClipIds: string[];
  audioClipIds: string[];
  captionRowIds: string[];
}

export function computeRippleMoveGroup(tl: Timeline, anchorClipId: string): RippleMoveGroup {
  const found = findClip(tl, anchorClipId);
  if (!found) return { videoClipIds: [anchorClipId], audioClipIds: [], captionRowIds: [] };
  const editPoint = found.clip.start;
  const past = (start: number) => start >= editPoint - 1e-3;
  return {
    videoClipIds: tl.tracks.flatMap((tr) => tr.clips.filter((c) => past(c.start)).map((c) => c.id)),
    audioClipIds: tl.audioTracks.flatMap((tr) => tr.clips.filter((c) => past(c.start)).map((c) => c.id)),
    captionRowIds: tl.captions.rows.filter((r) => past(r.start)).map((r) => r.id),
  };
}

export function rippleMove(tl: Timeline, group: RippleMoveGroup, deltaSec: number): Timeline {
  if (Math.abs(deltaSec) < 1e-4) return tl;
  // Clamp so nothing in the group goes negative — anchor clip's lower bound
  // is the strictest, and any group member at start=0 would clip too.
  const minStart = Math.min(
    ...tl.tracks.flatMap((tr) => tr.clips.filter((c) => group.videoClipIds.includes(c.id)).map((c) => c.start)),
    ...tl.audioTracks.flatMap((tr) => tr.clips.filter((c) => group.audioClipIds.includes(c.id)).map((c) => c.start)),
    ...tl.captions.rows.filter((r) => group.captionRowIds.includes(r.id)).map((r) => r.start),
    Number.POSITIVE_INFINITY,
  );
  if (!isFinite(minStart)) return tl;
  // Additional clamp for LEFT moves: keep the leftmost moving clip on each
  // track from running into its non-moving left-neighbor. By construction
  // there's no non-moving right-neighbor (every clip with start >= anchor
  // is in the group), so dragging right can't collide. The binding
  // constraint per track is (non-moving neighbor's end) - (leftmost moving
  // clip's start) — a non-positive value; we take the largest (least
  // negative) across all tracks as the lower bound on delta.
  let minDelta = -Infinity;
  if (deltaSec < 0) {
    const leftNeighborGap = (
      moving: { id: string; start: number }[],
      nonMoving: { id: string; start: number; end: number }[],
    ): number | null => {
      if (moving.length === 0 || nonMoving.length === 0) return null;
      const M1 = moving.reduce((a, b) => (a.start <= b.start ? a : b));
      const Nk = nonMoving.reduce((a, b) => (a.start >= b.start ? a : b));
      return Nk.end - M1.start;
    };
    for (const tr of tl.tracks) {
      const moving = tr.clips.filter((c) => group.videoClipIds.includes(c.id));
      const nonMoving = tr.clips
        .filter((c) => !group.videoClipIds.includes(c.id))
        .map((c) => ({ id: c.id, start: c.start, end: c.start + (c.out - c.in) / (c.rate || 1) }));
      const gap = leftNeighborGap(moving, nonMoving);
      if (gap !== null) minDelta = Math.max(minDelta, gap);
    }
    for (const tr of tl.audioTracks) {
      const moving = tr.clips.filter((c) => group.audioClipIds.includes(c.id));
      const nonMoving = tr.clips
        .filter((c) => !group.audioClipIds.includes(c.id))
        .map((c) => ({ id: c.id, start: c.start, end: c.start + (c.out - c.in) }));
      const gap = leftNeighborGap(moving, nonMoving);
      if (gap !== null) minDelta = Math.max(minDelta, gap);
    }
    const movingRows = tl.captions.rows.filter((r) => group.captionRowIds.includes(r.id));
    const nonMovingRows = tl.captions.rows
      .filter((r) => !group.captionRowIds.includes(r.id))
      .map((r) => ({ id: r.id, start: r.start, end: r.end }));
    const rowGap = leftNeighborGap(movingRows, nonMovingRows);
    if (rowGap !== null) minDelta = Math.max(minDelta, rowGap);
  }
  let realDelta = Math.max(deltaSec, -minStart);
  if (minDelta > -Infinity) realDelta = Math.max(realDelta, minDelta);
  if (Math.abs(realDelta) < 1e-4) return tl;
  const vSet = new Set(group.videoClipIds);
  const aSet = new Set(group.audioClipIds);
  const cSet = new Set(group.captionRowIds);
  return {
    ...tl,
    tracks: tl.tracks.map((tr) => ({
      ...tr,
      clips: tr.clips.map((c) => vSet.has(c.id) ? { ...c, start: round3(c.start + realDelta) } : c),
    })),
    audioTracks: tl.audioTracks.map((tr) => ({
      ...tr,
      clips: tr.clips.map((c) => aSet.has(c.id) ? { ...c, start: round3(c.start + realDelta) } : c),
    })),
    captions: {
      ...tl.captions,
      rows: tl.captions.rows.map((r) => {
        if (!cSet.has(r.id)) return r;
        const dur = r.end - r.start;
        const ns = round3(r.start + realDelta);
        return { ...r, start: ns, end: round3(ns + dur) };
      }),
    },
  };
}

// STRETCH RIGHT — drag the right edge with the rate-stretch tool. Keeps
// source range (`in`/`out`) fixed; instead changes `rate` so the master
// duration grows/shrinks to match the dragged edge. Drag right = slower
// (rate < 1), drag left = faster (rate > 1).
export function stretchRight(tl: Timeline, clipId: string, deltaSec: number, beats: number[], snapEnabled: boolean): Timeline {
  const found = findClip(tl, clipId);
  if (!found) return tl;
  const { clip } = found;
  const { next } = trackNeighbors(tl, clipId);
  const currentEnd = clip.start + (clip.out - clip.in) / clip.rate;
  const proposedEnd = currentEnd + deltaSec;
  let snappedEnd = snapEnabled ? snap(proposedEnd, beats) : proposedEnd;
  if (snapEnabled && snappedEnd === round3(proposedEnd)) {
    snappedEnd = snap(proposedEnd, allClipEdges(tl, clipId), EDGE_SNAP_TOLERANCE);
  }
  const maxEndByNeighbor = next ? next.start : Number.POSITIVE_INFINITY;
  const minEnd = clip.start + 0.1; // master dur ≥ 0.1s
  const maxEnd = maxEndByNeighbor;
  const finalEnd = Math.max(minEnd, Math.min(maxEnd, snappedEnd));
  const newMasterDur = finalEnd - clip.start;
  const sourceWindow = clip.out - clip.in;
  const newRate = Math.max(0.1, Math.min(8, sourceWindow / newMasterDur));
  return patchClip(tl, clipId, { rate: Math.round(newRate * 1000) / 1000 });
}

// SLIP — change `in` and `out` by the same delta, keeping master timing fixed.
// Direction (matches the "drag the filmstrip underneath" mental model used by
// Resolve, Final Cut, and most modern NLEs): dragging the slip handle to the
// RIGHT pushes the source content rightward in the viewport → reveals
// content from EARLIER in the source → in/out DECREASE. Pixel deltaSec is
// inverted so the visible content moves with the cursor rather than against
// it. (The earlier impl matched Premiere's "drag the window over the
// filmstrip" model where dragging right revealed later content — the user
// found that inverted from intuition; fixed 2026-05-13.)
// The source window MUST stay inside [0, sourceDur]; without clamping a clip
// whose state went out-of-range (e.g. source was re-rendered shorter than it
// used to be) becomes unrecoverable because slipping in any direction just
// keeps it out-of-range. The clamp pulls it back on first touch.
export function slipClip(tl: Timeline, clipId: string, deltaSec: number): Timeline {
  const found = findClip(tl, clipId);
  if (!found) return tl;
  const { clip } = found;
  const sourceDur = sourceDurationFor(tl, clip);
  const sourceWindow = clip.out - clip.in;
  const proposedIn = clip.in - deltaSec * clip.rate;
  const minIn = 0;
  // If the clip's source window is itself longer than the source (corrupt
  // state), allow in=0 and let trim fix it later; otherwise bound max so
  // out stays ≤ sourceDur.
  const maxIn = Math.max(0, sourceDur - sourceWindow);
  const newIn = Math.max(minIn, Math.min(maxIn, proposedIn));
  const newOut = newIn + sourceWindow;
  return patchClip(tl, clipId, { in: round3(newIn), out: round3(newOut) });
}

// SPEED CHANGE — preserves clip's master-timeline duration if `preserveDur=true`,
// or preserves the source range if false (then master duration changes).
export function setRate(tl: Timeline, clipId: string, rate: number, preserveSource = true): Timeline {
  if (rate <= 0) return tl;
  return patchClip(tl, clipId, { rate });
}

/**
 * REORDER — drop a clip "between" or onto another clip on the same
 * track to shuffle the order without changing any clip's duration. The
 * track is then re-packed tight from the original first-slot start, so
 * the only thing that changes is which clip sits where in sequence.
 *
 * Linked audio clips follow: every clip whose `linkId` matches one of
 * the moved video clips gets the same start-delta applied. So a V1 +
 * A1 pair re-shuffles as a unit.
 *
 * `dragged` = the clip the user grabbed. `target` = the clip whose
 * bounds the cursor landed inside. `insertBefore` = true if the cursor
 * landed in the LEFT half of `target` (drop before it), false if RIGHT
 * half (drop after it).
 *
 * No-op if `dragged` and `target` aren't on the same track, or either
 * isn't found. The Clip drag handler detects this case at drop time
 * from the raw cursor X — even when the live drag was clamp-blocked
 * against a neighbor, the cursor's actual position over a target clip
 * tells us the user's intent.
 */
export function reorderClipNearClip(tl: Timeline, draggedId: string, targetId: string, insertBefore: boolean): Timeline {
  let trackIdx = -1;
  let dragged: Clip | undefined;
  let target: Clip | undefined;
  for (let i = 0; i < tl.tracks.length; i++) {
    const tr = tl.tracks[i];
    const d = tr.clips.find((c) => c.id === draggedId);
    const t = tr.clips.find((c) => c.id === targetId);
    if (d && t) { trackIdx = i; dragged = d; target = t; break; }
  }
  if (trackIdx < 0 || !dragged || !target || draggedId === targetId) return tl;
  const track = tl.tracks[trackIdx];

  // Build the post-drop order. Start with all clips minus dragged,
  // sorted by current start; locate target's slot and splice dragged in.
  const others = track.clips.filter((c) => c.id !== draggedId).sort((a, b) => a.start - b.start);
  const targetIdx = others.findIndex((c) => c.id === targetId);
  if (targetIdx < 0) return tl;
  const insertAt = insertBefore ? targetIdx : targetIdx + 1;
  const ordered = [...others.slice(0, insertAt), dragged, ...others.slice(insertAt)];

  // FORWARD-ONLY REPACK.
  //
  // Old behavior: anchored to the earliest start on the track and packed
  // every clip flush, eliminating ALL gaps. That meant reordering a clip
  // could push DOWNSTREAM clips backward into pre-existing gaps —
  // dragging B before A in `A[0-5] gap B[10-15] gap C[20-25]` produced
  // `B[0-5] A[5-10] C[10-15]`, shoving C from 20 to 10. User reported
  // this as "messes up the whole timeline".
  //
  // New behavior:
  //   - The dragged clip moves freely (forward OR backward). Its new
  //     start is target.start when insertBefore, else target.start +
  //     targetDur — the dragged clip OCCUPIES the target's adjacent
  //     slot exactly.
  //   - Every OTHER clip is forward-only: it stays at its current start
  //     unless a preceding clip in the new order would overlap it, in
  //     which case it shifts forward just enough to butt against the
  //     previous clip. Pre-existing gaps are preserved.
  //   - Linked A clips + matching sfx_<sceneId> clips ride along with
  //     their V clip's delta. Caption rows with linkSceneId === sceneId
  //     also ride along, preserving their dur.
  const targetDur = (target.out - target.in) / (target.rate || 1);
  const draggedDur = (dragged.out - dragged.in) / (dragged.rate || 1);
  const draggedNewStart = insertBefore ? target.start : target.start + targetDur;

  const deltas = new Map<string, number>();              // clipId → master-time delta
  const repacked: Clip[] = [];
  let prevEnd = -Infinity;
  for (const c of ordered) {
    const dur = (c.out - c.in) / (c.rate || 1);
    let newStart: number;
    if (c.id === draggedId) {
      newStart = draggedNewStart;
    } else {
      // Forward-only: keep this clip's existing start unless a previous
      // item already occupies that space, in which case butt up to the
      // previous one's end.
      newStart = Math.max(c.start, prevEnd === -Infinity ? c.start : prevEnd);
    }
    newStart = round3(newStart);
    if (Math.abs(c.start - newStart) > 1e-4) deltas.set(c.id, newStart - c.start);
    repacked.push({ ...c, start: newStart });
    prevEnd = newStart + dur;
    if (c.id === draggedId) prevEnd = newStart + draggedDur;   // safety: use draggedDur explicitly
  }

  const nextTracks = tl.tracks.map((tr, i) => i === trackIdx ? { ...tr, clips: repacked } : tr);

  // Build the per-(linkId, sceneId) delta maps so A clips + caption rows
  // can ripple with the V clips that actually moved. Both maps are
  // keyed off the SAME repacked deltas — no fuzzy time matching.
  const linkIdDeltas = new Map<string, number>();   // linkId → delta
  const sceneIdDeltas = new Map<string, number>(); // sceneId → delta
  for (const c of repacked) {
    const d = deltas.get(c.id);
    if (d === undefined) continue;
    if (c.linkId) linkIdDeltas.set(c.linkId, d);
    if (c.sceneId) sceneIdDeltas.set(c.sceneId, d);
  }
  const nextAudioTracks = tl.audioTracks.map((tr) => ({
    ...tr,
    clips: tr.clips.map((ac) => {
      // 1. linkId match — canonical path.
      if (ac.linkId) {
        const d = linkIdDeltas.get(ac.linkId);
        if (d !== undefined) return { ...ac, start: round3(Math.max(0, ac.start + d)) };
      }
      // 2. sfx_<sceneId> convention.
      if (ac.id.startsWith('sfx_')) {
        const sceneId = ac.id.slice(4);
        const d = sceneIdDeltas.get(sceneId);
        if (d !== undefined) return { ...ac, start: round3(Math.max(0, ac.start + d)) };
      }
      return ac;
    }),
  }));
  // Captions follow by linkSceneId so the burned-in text under each
  // shot stays synced with the shot when it shifts.
  const nextCaptions = tl.captions
    ? {
        ...tl.captions,
        rows: tl.captions.rows.map((r) => {
          const d = (r as { linkSceneId?: string | null }).linkSceneId
            ? sceneIdDeltas.get((r as { linkSceneId: string }).linkSceneId)
            : undefined;
          if (d === undefined) return r;
          const dur = r.end - r.start;
          const newStart = Math.max(0, r.start + d);
          return { ...r, start: round3(newStart), end: round3(newStart + dur) };
        }),
      }
    : tl.captions;
  return { ...tl, tracks: nextTracks, audioTracks: nextAudioTracks, captions: nextCaptions };
}

// SPLIT — cut a clip at a master-timeline time. Produces two clips on
// the same track. If the clip carries a `linkId`, every other clip
// (video OR audio) on any track that shares that linkId is ALSO split
// at the same master-time, and the second halves get a fresh shared
// linkId. Result: a linked (V, A) pair becomes two independent (V, A)
// pairs that move/trim/blade independently from here on.
//
// Works in either direction:
//   - Blade the V clip → its linked A clip on A1 splits too
//   - Blade the A clip → its linked V clip on V1 splits too
//
// Mirrors splitClipAtMaster() in server/src/agent/clip-ops.ts so the
// agent's split_clip tool and the user's blade tool produce identical
// shapes.
export function splitClip(tl: Timeline, clipId: string, atTime: number): Timeline {
  // First try video tracks. If the clipId is on a V track, split it
  // there (using rate-aware math) and cascade to linked audio.
  const v = findClip(tl, clipId);
  if (v) return splitVideoClipWithLinks(tl, v.clip, v.trackId, atTime);
  // Otherwise try audio tracks — blade on a linked audio clip should
  // ALSO split the video clip on V1.
  for (const tr of tl.audioTracks) {
    const a = tr.clips.find((c) => c.id === clipId);
    if (a) return splitAudioClipWithLinks(tl, a, tr.id, atTime);
  }
  return tl;
}

function splitVideoClipWithLinks(tl: Timeline, clip: Clip, trackId: string, atTime: number): Timeline {
  const dur = (clip.out - clip.in) / clip.rate;
  if (atTime <= clip.start + 1e-3 || atTime >= clip.start + dur - 1e-3) return tl;
  const localOffset = (atTime - clip.start) * clip.rate;
  const splitIn = round3(clip.in + localOffset);
  const newLinkId = clip.linkId ? freshLinkId() : null;
  const newId = nextSuffixId(allClipIdsOnVideoTracks(tl), clip.id);
  const left: Clip = { ...clip, out: splitIn, comments: [] };
  const right: Clip = { ...clip, id: newId, in: splitIn, start: round3(atTime), linkId: newLinkId, comments: [] };
  const nextTracks = tl.tracks.map((tr) => tr.id !== trackId ? tr : {
    ...tr,
    clips: tr.clips.flatMap((c) => (c.id === clip.id ? [left, right] : [c])).sort((a, b) => a.start - b.start),
  });
  const nextAudio = clip.linkId
    ? splitAudioSiblingsByLinkId(tl.audioTracks, clip.linkId, atTime, newLinkId)
    : tl.audioTracks;
  return { ...tl, tracks: nextTracks, audioTracks: nextAudio };
}

function splitAudioClipWithLinks(tl: Timeline, ac: Timeline['audioTracks'][number]['clips'][number], trackId: string, atTime: number): Timeline {
  const dur = ac.out - ac.in;
  if (atTime <= ac.start + 1e-3 || atTime >= ac.start + dur - 1e-3) return tl;
  const splitIn = round3(ac.in + (atTime - ac.start));
  const newLinkId = ac.linkId ? freshLinkId() : null;
  const allAudioIds = tl.audioTracks.flatMap((t) => t.clips.map((c) => c.id));
  const newAudioId = nextSuffixId(allAudioIds, ac.id);
  const audioLeft  = { ...ac, out: splitIn };
  const audioRight = { ...ac, id: newAudioId, in: splitIn, start: round3(atTime), linkId: newLinkId };
  const nextAudio = tl.audioTracks.map((tr) => tr.id !== trackId ? tr : {
    ...tr,
    clips: tr.clips.flatMap((c) => (c.id === ac.id ? [audioLeft, audioRight] : [c])).sort((a, b) => a.start - b.start),
  });
  // Cascade to the linked video clip (if any) AND any other audio clips
  // on other tracks sharing the same linkId. Skips the track we just
  // edited so we don't double-split.
  let nextTracks = tl.tracks;
  let nextAudioWithSiblings = nextAudio;
  if (ac.linkId) {
    nextTracks = splitVideoSiblingsByLinkId(tl.tracks, ac.linkId, atTime, newLinkId);
    nextAudioWithSiblings = splitAudioSiblingsByLinkId(nextAudio, ac.linkId, atTime, newLinkId, trackId);
  }
  return { ...tl, tracks: nextTracks, audioTracks: nextAudioWithSiblings };
}

function splitAudioSiblingsByLinkId(audioTracks: Timeline['audioTracks'], linkId: string, atTime: number, newLinkId: string | null, skipTrackId?: string): Timeline['audioTracks'] {
  const allAudioIds = audioTracks.flatMap((t) => t.clips.map((c) => c.id));
  return audioTracks.map((track) => {
    if (track.id === skipTrackId) return track;
    const newClips: typeof track.clips = [];
    for (const sx of track.clips) {
      if (sx.linkId !== linkId) { newClips.push(sx); continue; }
      const sxDur = sx.out - sx.in;
      if (atTime <= sx.start + 1e-3 || atTime >= sx.start + sxDur - 1e-3) {
        newClips.push(sx);
        continue;
      }
      const sxSplitIn = round3(sx.in + (atTime - sx.start));
      const sxNewId = nextSuffixId(allAudioIds, sx.id);
      allAudioIds.push(sxNewId);
      newClips.push({ ...sx, out: sxSplitIn });
      newClips.push({ ...sx, id: sxNewId, start: round3(atTime), in: sxSplitIn, linkId: newLinkId });
    }
    return { ...track, clips: newClips };
  });
}

function splitVideoSiblingsByLinkId(tracks: Timeline['tracks'], linkId: string, atTime: number, newLinkId: string | null): Timeline['tracks'] {
  const allIds = tracks.flatMap((t) => t.clips.map((c) => c.id));
  return tracks.map((tr) => {
    const newClips: Clip[] = [];
    for (const c of tr.clips) {
      if (c.linkId !== linkId) { newClips.push(c); continue; }
      const dur = (c.out - c.in) / c.rate;
      if (atTime <= c.start + 1e-3 || atTime >= c.start + dur - 1e-3) {
        newClips.push(c);
        continue;
      }
      const splitIn = round3(c.in + (atTime - c.start) * c.rate);
      const newId = nextSuffixId(allIds, c.id);
      allIds.push(newId);
      newClips.push({ ...c, out: splitIn, comments: [] });
      newClips.push({ ...c, id: newId, in: splitIn, start: round3(atTime), linkId: newLinkId, comments: [] });
    }
    return { ...tr, clips: newClips.sort((a, b) => a.start - b.start) };
  });
}

function allClipIdsOnVideoTracks(tl: Timeline): string[] {
  return tl.tracks.flatMap((t) => t.clips.map((c) => c.id));
}

function freshLinkId(): string {
  return `lk_${Date.now().toString(36).slice(-6)}${Math.floor(Math.random() * 1000).toString(36)}`;
}

function nextSuffixId(existingIds: string[], baseId: string): string {
  const used = new Set(existingIds);
  for (const suf of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
    const candidate = `${baseId}_${suf}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${baseId}_${Date.now().toString(36).slice(-4)}`;
}

// RIPPLE DELETE — remove the clip and shift EVERY clip after it (all video
// tracks + every SFX lane + the music bed) left by the deleted clip's master
// duration. Standard NLE ripple semantics: if a V1 clip rips out and a 2s
// hole closes, the SFX cue 5 seconds later must move 2s earlier too, or it
// detaches from its visual beat. Same when deleting from the music lane —
// the surviving timeline (video + sfx) collapses inward.
export function rippleDelete(tl: Timeline, clipId: string): Timeline {
  const found = findClip(tl, clipId);
  if (found) {
    const { clip, trackId } = found;
    const masterDur = (clip.out - clip.in) / clip.rate;
    const cutAt = clip.start;
    const shift = (start: number): number =>
      start >= cutAt - 1e-3 ? round3(Math.max(0, start - masterDur)) : start;
    return {
      ...tl,
      tracks: tl.tracks.map((tr) => {
        if (tr.id === trackId) {
          const without = tr.clips.filter((c) => c.id !== clip.id);
          return { ...tr, clips: without.map((c) => ({ ...c, start: shift(c.start) })) };
        }
        // Other video tracks: keep their clips, just ripple the timing.
        return { ...tr, clips: tr.clips.map((c) => ({ ...c, start: shift(c.start) })) };
      }),
      audioTracks: tl.audioTracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => ({ ...c, start: shift(c.start) })),
      })),
    };
  }
  // Fallback: audio clip lookup across all audio tracks. ripple-delete on
  // an audio clip removes it from its track and shifts everything that
  // started at or after its position (across V tracks + every audio
  // track + captions) backward by the clip's duration.
  for (const audioTrack of tl.audioTracks) {
    const ac = audioTrack.clips.find((c) => c.id === clipId);
    if (!ac) continue;
    const masterDur = ac.out - ac.in;
    const cutAt = ac.start;
    const shift = (start: number): number =>
      start >= cutAt - 1e-3 ? round3(Math.max(0, start - masterDur)) : start;
    return {
      ...tl,
      tracks: tl.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => ({ ...c, start: shift(c.start) })) })),
      audioTracks: tl.audioTracks.map((tr) => ({
        ...tr,
        clips: (tr.id === audioTrack.id
          ? tr.clips.filter((c) => c.id !== clipId)
          : tr.clips
        ).map((c) => ({ ...c, start: shift(c.start) })),
      })),
    };
  }
  return tl;
}

// ─── Music-specific editing ────────────────────────────────────────────
//
// Music clips on the music lane share a single source audio file (the one
// at `timeline.music.src`) and the timeline's beats array describes that
// source's beat grid. So beat-snap on the music lane has two meanings:
//   1. Master-time snap (clip.start lands on a beat) — same as video.
//   2. SOURCE-time snap (clip.in lands on a source beat) — keeps the
//      music's phase aligned. This is what slip needs.
//
// We also auto-apply crossfades when two music clips end up adjacent (gap
// within FADE_SEC of zero, OR overlapping by ≤ FADE_SEC * 2). The crossfade
// is implemented as overlap + symmetric fadeIn/fadeOut: clip B.start is
// pulled back so it overlaps A by FADE_SEC, then A.fadeOut and B.fadeIn are
// set to FADE_SEC. The render pipeline's amix sums the overlapping audio,
// producing a real equal-length crossfade rather than a dipped cut.
//
// Default fadeIn/fadeOut on music clips is 0; this module is the only thing
// that ever sets them.

const MUSIC_FADE_FRAMES = 4;
export function musicFadeSec(fps: number = 60): number { return MUSIC_FADE_FRAMES / fps; }

// Snap `time` to the closest beat. Returns the original time if beats is
// empty or no beat is within `tolerance` (default: any beat is acceptable).
function snapToNearestBeat(time: number, beats: number[], tolerance = Infinity): number {
  if (!beats || beats.length === 0) return time;
  let best = beats[0];
  let bestDist = Math.abs(time - best);
  for (const b of beats) {
    const d = Math.abs(time - b);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return bestDist <= tolerance ? round3(best) : round3(time);
}

// Walk music clips in order, find adjacent pairs, and apply symmetric
// fadeIn/fadeOut where they touch. Pure function — never mutates the input
// and NEVER moves clips. Resets all fades to 0 first so a previously-
// crossfaded pair that's no longer adjacent has its fades cleared.
//
// We deliberately do NOT shift positions to create overlap. Shifting
// caused dragged-insert UX confusion — placing C between A and B, the
// overlap-shift would visibly slide C and B by ~4 frames, making it look
// like "everything moved" instead of "I dropped C in the cut". Trade-off:
// touching clips get a brief audio dip at the join (rather than a true
// equal-power crossfade) since the symmetric fades hit zero at the meeting
// point. Acceptable at FADE_FRAMES=4 (~67ms at 60fps).
//
// If/when true crossfades are needed, do them at render time by extending
// each clip's source by ±FADE_SEC in the audio mix filter rather than
// changing master positions.
export function applyMusicCrossfades(music: NonNullable<Timeline['music']>, fps: number = 60): NonNullable<Timeline['music']> {
  if (!music.clips || music.clips.length === 0) return music;
  const FADE = musicFadeSec(fps);
  const sorted = [...music.clips].sort((a, b) => a.start - b.start);
  const out = sorted.map((c) => ({ ...c, fadeIn: 0, fadeOut: 0 }));
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i];
    const b = out[i + 1];
    const aEnd = a.start + (a.out - a.in);
    const gap = b.start - aEnd;
    // Touching (small positive gap) OR slightly overlapping → apply fades.
    // No position changes.
    if (gap <= FADE && gap >= -FADE * 2) {
      a.fadeOut = FADE;
      b.fadeIn = FADE;
    }
  }
  return { ...music, clips: out };
}

// Slip a music clip with source-beat snapping. The master-time position
// (clip.start, clip.duration) stays fixed; clip.in shifts by deltaSec and
// snaps to the nearest source beat from `beats` (which is the music's beat
// grid). Source-window bounds are enforced so clip.out stays within the
// source duration.
export function slipMusicClip(
  music: NonNullable<Timeline['music']>,
  clipId: string,
  deltaSec: number,
  beats: number[],
  snapEnabled: boolean,
  sourceDur: number,
): NonNullable<Timeline['music']> {
  const idx = music.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return music;
  const c = music.clips[idx];
  const window = c.out - c.in;
  // Direction match for slipClip — drag-right moves source content right
  // (reveals earlier source), so deltaSec is inverted before adding to in.
  const proposedIn = c.in - deltaSec;
  const snappedIn = snapEnabled ? snapToNearestBeat(proposedIn, beats) : proposedIn;
  const minIn = 0;
  const maxIn = Math.max(0, sourceDur - window);
  const newIn = Math.max(minIn, Math.min(maxIn, snappedIn));
  const newOut = newIn + window;
  const next = music.clips.slice();
  next[idx] = { ...c, in: round3(newIn), out: round3(newOut) };
  return { ...music, clips: next };
}

// Trim the LEFT edge of a music clip with master-beat snapping. Both
// clip.start AND clip.in move by the same delta (the source point under
// the new edge stays the same as before the trim). The new edge snaps to
// the nearest master-time beat.
export function trimMusicClipLeft(
  music: NonNullable<Timeline['music']>,
  clipId: string,
  deltaSec: number,
  beats: number[],
  snapEnabled: boolean,
): NonNullable<Timeline['music']> {
  const idx = music.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return music;
  const c = music.clips[idx];
  const proposedStart = c.start + deltaSec;
  const snappedStart = snapEnabled ? snapToNearestBeat(proposedStart, beats) : proposedStart;
  const minStart = Math.max(0, c.start - c.in);            // can't expose negative source
  const maxStart = c.start + (c.out - c.in - 0.05);        // keep ≥ 50ms of duration
  const finalStart = Math.max(minStart, Math.min(maxStart, snappedStart));
  const finalIn = c.in + (finalStart - c.start);
  const next = music.clips.slice();
  next[idx] = { ...c, start: round3(finalStart), in: round3(Math.max(0, finalIn)) };
  return { ...music, clips: next };
}

// Trim the RIGHT edge of a music clip with master-beat snapping. clip.out
// moves; clip.start and clip.in stay fixed. The new edge snaps to the
// nearest master-time beat.
export function trimMusicClipRight(
  music: NonNullable<Timeline['music']>,
  clipId: string,
  deltaSec: number,
  beats: number[],
  snapEnabled: boolean,
  sourceDur: number,
): NonNullable<Timeline['music']> {
  const idx = music.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return music;
  const c = music.clips[idx];
  const currentEnd = c.start + (c.out - c.in);
  const proposedEnd = currentEnd + deltaSec;
  const snappedEnd = snapEnabled ? snapToNearestBeat(proposedEnd, beats) : proposedEnd;
  const maxEnd = c.start + (sourceDur - c.in);             // can't run past source
  const minEnd = c.start + 0.05;                           // ≥ 50ms duration
  const finalEnd = Math.max(minEnd, Math.min(maxEnd, snappedEnd));
  const newOut = c.in + (finalEnd - c.start);
  const next = music.clips.slice();
  next[idx] = { ...c, out: round3(newOut) };
  return { ...music, clips: next };
}

// PLAIN DELETE — leaves a gap. Handles video tracks, music lane, AND
// the SFX lane. Earlier this function ignored sfx.clips, so deleting an
// SFX clip from the timeline silently no-op'd (selection cleared, but
// the clip stayed). Now it filters from all three.
export function deleteClip(tl: Timeline, clipId: string): Timeline {
  const next: Timeline = {
    ...tl,
    tracks: tl.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => c.id !== clipId) })),
  };
  if (tl.music) {
    next.music = {
      ...tl.music,
      clips: tl.music.clips.filter((c) => c.id !== clipId),
    };
  }
  if (tl.sfx) {
    next.sfx = {
      ...tl.sfx,
      clips: tl.sfx.clips.filter((c) => c.id !== clipId),
    };
  }
  return next;
}
