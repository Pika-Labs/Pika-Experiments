import { useRef, useState, type PointerEvent } from 'react';
import { useStore } from '../store';
import type { Clip, Scene } from '../types';
import { computeRippleMoveGroup, type RippleMoveGroup } from '../edit';
import * as api from '../api';

interface Props {
  clip: Clip;
  scene: Scene | undefined;
  duration: number;
  laneRef: React.RefObject<HTMLDivElement>;
  selected: boolean;
  onDoubleClick?: () => void;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

type DragKind = 'move' | 'trim-l' | 'trim-r' | 'slip' | 'ripple-l' | 'ripple-r' | 'ripple-move';
interface DragSession {
  kind: DragKind;
  startX: number;
  startY: number;      // for inter-track visual feedback (lift the clip toward the lane under the cursor)
  /** Original viewport-top of the dragged clip captured at pointerdown
   *  (with NO translate applied). The inter-track snap math computes
   *  `snappedY = targetLaneTop - origTopY` so it's stable across pointer-
   *  move ticks. Reading the live `getBoundingClientRect().top` instead
   *  produces a feedback oscillation: the clip's rect already reflects
   *  the prior tick's translate, so the math collapses to 0 every other
   *  frame, causing visible flicker between lanes. */
  origTopY: number;
  pxPerSec: number;
  origStart: number;
  lastDelta: number;   // last applied session-delta (sec) — used to compute frame increments
  rippleGroup?: RippleMoveGroup;   // captured once for ripple-move so the set doesn't drift mid-drag
}

export function VideoClip({ clip, scene, duration, laneRef, selected, onDoubleClick }: Props) {
  const tool = useStore((s) => s.tool);
  const selectClip = useStore((s) => s.selectClip);
  const moveSelectedBy = useStore((s) => s.moveSelectedBy);
  const trimLeft = useStore((s) => s.trimLeft);
  const trimRight = useStore((s) => s.trimRight);
  const rippleTrimLeft = useStore((s) => s.rippleTrimLeft);
  const rippleTrimRight = useStore((s) => s.rippleTrimRight);
  const beginTransaction = useStore((s) => s.beginTransaction);
  const endTransaction = useStore((s) => s.endTransaction);
  const rippleMove = useStore((s) => s.rippleMove);
  const slipClip = useStore((s) => s.slipClip);
  const splitClipAt = useStore((s) => s.splitClipAt);
  const moveClipToTrack = useStore((s) => s.moveClipToTrack);
  const reorderClipNearClip = useStore((s) => s.reorderClipNearClip);
  const setDropIndicator = useStore((s) => s.setDropIndicator);
  const tracks = useStore((s) => s.timeline?.tracks ?? []);

  const drag = useRef<DragSession | null>(null);
  // Visual-only state for inter-track drag: when set, the clip renders
  // vertically offset by this many pixels so the user can SEE which lane
  // they're about to drop onto before releasing. The actual track switch
  // commits in onPointerUp via moveClipToTrack. Resets to 0 on pointerup.
  const [dragVisualY, setDragVisualY] = useState(0);
  // Set when the target lane the cursor is currently over has a collision
  // with this clip's time range — drop would be silently rejected. We
  // surface a red-glow class so the user knows BEFORE they release that
  // the move won't take.
  const [dropBlocked, setDropBlocked] = useState(false);

  const masterDur = (clip.out - clip.in) / (clip.rate || 1);
  const left = (clip.start / duration) * 100;
  const width = (masterDur / duration) * 100;
  // Find any LiveGen for this scene (whatever state it's in) so we can
  // both (a) show in-flight progress on a pending clip and (b) flip the
  // clip to a "Failed" label when the gen errored, even if the scene
  // PATCH to status:'error' hasn't landed yet.
  const pikaLiveGens = useStore((s) => s.pikaLiveGens);
  const liveGen = scene
    ? [...pikaLiveGens.values()].find((g) => g.sceneId === scene.id)
    : undefined;
  const pending = scene?.kind === 'pika-gen'
    && (scene.status === 'pending' || scene.status === 'generating')
    && liveGen?.status !== 'error';
  const failed = scene?.kind === 'pika-gen'
    && (scene.status === 'error' || liveGen?.status === 'error');
  const failedMessage = scene?.kind === 'pika-gen'
    ? (scene.errorMessage ?? liveGen?.errorMessage ?? null)
    : null;
  const pct = liveGen?.status === 'running' ? liveGen?.progressPct : undefined;
  const elapsedSec = liveGen?.status === 'running' ? liveGen?.progress : undefined;
  const label = scene?.labels?.[0] ?? scene?.id ?? clip.sceneId;
  // Pika sends elapsed-seconds heartbeats. We compute an estimated %
  // server-side using a typical-duration lookup and prefer that for
  // the label; fall back to raw elapsed seconds when no estimate is
  // available; fall back to a plain "Generating…" before any heartbeat.
  const sub = scene?.kind === 'pika-gen'
    ? failed ? `Failed${failedMessage ? ` · ${failedMessage.slice(0, 40)}` : ''}`
      : pending ? (
          typeof pct === 'number' ? `Generating… ${pct}%`
          : typeof elapsedSec === 'number' ? `Generating… ${elapsedSec}s`
          : 'Generating…'
        )
      : `${(scene.model || '').split('-')[0]} · ${masterDur.toFixed(1)}s`
    : scene?.kind === 'video-import' ? `import · ${masterDur.toFixed(1)}s` : '';
  // For the steady-state "model · duration" sub-label we split into
  // distinct spans so a CSS container query can hide the model name
  // (and the separator) when the clip is too narrow to fit them on
  // one line — without that, the sub-label wraps and overlaps the
  // bold title above it. Failed/Generating subs stay as one span;
  // their content is intentional (status verb + detail) and
  // shouldn't drop the verb on narrow clips.
  const subParts = scene && !failed && !pending && (scene.kind === 'pika-gen' || scene.kind === 'video-import')
    ? {
        prefix: scene.kind === 'pika-gen' ? (scene.model || '').split('-')[0] : 'import',
        dur: `${masterDur.toFixed(1)}s`,
      }
    : null;
  const darkThumb = scene?.labels?.[0]?.toLowerCase().includes('close-up') || scene?.labels?.[0]?.toLowerCase().includes('cami');

  function pxPerSec(): number {
    const w = laneRef.current?.clientWidth ?? 1;
    return w / duration;
  }

  function onPointerDownBody(e: PointerEvent) {
    // Blade tool turns left-click into "split at this x"; no drag session.
    if (tool === 'blade') {
      e.stopPropagation();
      const rect = laneRef.current!.getBoundingClientRect();
      const atTime = ((e.clientX - rect.left) / rect.width) * duration;
      splitClipAt(clip.id, atTime);
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    // Preserve multi-selection when starting a drag on an already-selected
    // clip — otherwise plain-click resets to single-select and group-move
    // collapses to one clip. Shift-click toggles membership instead.
    const alreadySelected = useStore.getState().selectedClipIds.includes(clip.id);
    if (e.shiftKey) {
      selectClip(clip.id, true);
    } else if (!alreadySelected) {
      selectClip(clip.id, false);
    }
    const kind: DragKind = tool === 'slip' ? 'slip' : tool === 'ripple' ? 'ripple-move' : 'move';
    // For ripple-move, snapshot the moving group (anchor + everything
    // downstream of its current start) ONCE here. Using a stable set keeps
    // the group from drifting when the user drags left and the anchor
    // overtakes clips that were originally just in front of it.
    const rippleGroup = kind === 'ripple-move'
      ? computeRippleMoveGroup(useStore.getState().timeline!, clip.id)
      : undefined;
    const origTopY = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    drag.current = { kind, startX: e.clientX, startY: e.clientY, origTopY, pxPerSec: pxPerSec(), origStart: clip.start, lastDelta: 0, rippleGroup };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Open a history transaction so all the per-pointermove store
    // mutations collapse into ONE undo step at pointerup. Without this,
    // a single drag fires ~30 history pushes and Ctrl-Z only rewinds
    // 1 pixel at a time.
    beginTransaction();
  }

  function onPointerDownEdge(side: 'l' | 'r', e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectClip(clip.id, false);
    const rippleMode = tool === 'ripple';
    const kind: DragKind = side === 'l' ? (rippleMode ? 'ripple-l' : 'trim-l') : (rippleMode ? 'ripple-r' : 'trim-r');
    const origTopY = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    drag.current = { kind, startX: e.clientX, startY: e.clientY, origTopY, pxPerSec: pxPerSec(), origStart: clip.start, lastDelta: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginTransaction();
  }

  function onPointerMove(e: PointerEvent) {
    const d = drag.current; if (!d) return;
    const deltaSec = (e.clientX - d.startX) / d.pxPerSec;
    if (d.kind === 'move') {
      // Incremental: apply (deltaSec - lastDelta) to every selected clip so
      // multi-select group-moves keep their offsets and we don't accumulate
      // float error over a long drag.
      const inc = deltaSec - d.lastDelta;
      if (Math.abs(inc) >= 1e-4) {
        moveSelectedBy(inc, clip.id);
        d.lastDelta = deltaSec;
      }
      // Drop-indicator: while the cursor sits inside another clip's
      // bounds on the same track, surface where the dragged clip will
      // land if released — the cut between two neighbors. Cleared on
      // pointer-up. Read tracks fresh from the store so the indicator
      // reflects in-flight moves on other clips.
      const rect = laneRef.current?.getBoundingClientRect();
      const tl = useStore.getState().timeline;
      if (rect && rect.width > 0 && tl) {
        const cursorTime = ((e.clientX - rect.left) / rect.width) * duration;
        const myTrack = tl.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
        const target = myTrack?.clips.find((c) => {
          if (c.id === clip.id) return false;
          const cDur = (c.out - c.in) / (c.rate || 1);
          return cursorTime > c.start + 1e-3 && cursorTime < c.start + cDur - 1e-3;
        });
        if (target && myTrack) {
          const tDur = (target.out - target.in) / (target.rate || 1);
          const tMid = target.start + tDur / 2;
          const slotTime = cursorTime < tMid ? target.start : target.start + tDur;
          setDropIndicator({ trackId: myTrack.id, timeSec: slotTime });
        } else {
          setDropIndicator(null);
        }
      }
      // Inter-track visual feedback: snap the clip's apparent Y position
      // to whichever video lane the cursor is currently over. The clip
      // doesn't actually change tracks until pointerup (and only if the
      // target lane has no collision at this time range); the visual is
      // just so the user can see where it'll land before committing.
      //
      // CRITICAL: snap relative to `d.origTopY` (captured ONCE at
      // pointerdown), NOT the live `currentTarget.getBoundingClientRect()`.
      // The live rect already reflects the prior tick's translate, so
      // using it produces a feedback loop where the snap collapses to
      // zero every other frame and the clip flickers between lanes.
      const targetsUnder = document.elementsFromPoint(e.clientX, e.clientY);
      let snappedY = e.clientY - d.startY;
      let blocked = false;
      for (const el of targetsUnder) {
        const targetTrackId = (el as HTMLElement).dataset?.vtrack;
        if (!targetTrackId) continue;
        if (targetTrackId === clip.trackId) { snappedY = 0; break; }
        const targetRect = (el as HTMLElement).getBoundingClientRect();
        snappedY = targetRect.top - d.origTopY;
        // Check whether the target lane has a clip overlapping THIS
        // clip's CURRENT time range. Use the live store so the check
        // reflects the latest .start (moveSelectedBy may have just
        // shifted it). If blocked, mark the drag so the CSS shows the
        // red-glow "won't land" state.
        const liveTimeline = useStore.getState().timeline;
        const targetTrack = liveTimeline?.tracks.find((t) => t.id === targetTrackId);
        const liveClip = liveTimeline?.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id);
        if (targetTrack && liveClip) {
          const myStart = liveClip.start;
          const myEnd = myStart + (liveClip.out - liveClip.in) / (liveClip.rate || 1);
          blocked = targetTrack.clips.some((c) => {
            if (c.id === clip.id) return false;
            const cEnd = c.start + (c.out - c.in) / (c.rate || 1);
            return myStart < cEnd - 1e-3 && c.start < myEnd - 1e-3;
          });
        }
        break;
      }
      setDragVisualY(snappedY);
      setDropBlocked(blocked);
      return;
    }
    if (d.kind === 'ripple-move') {
      const inc = deltaSec - d.lastDelta;
      if (Math.abs(inc) >= 1e-4 && d.rippleGroup) {
        rippleMove(d.rippleGroup, inc);
        d.lastDelta = deltaSec;
      }
      return;
    }
    // All other ops take an INCREMENTAL deltaSec (since their last call).
    const inc = deltaSec - d.lastDelta;
    if (Math.abs(inc) < 1e-4) return;
    d.lastDelta = deltaSec;
    switch (d.kind) {
      case 'trim-l':   trimLeft(clip.id, inc); break;
      case 'trim-r':   trimRight(clip.id, inc); break;
      case 'ripple-l': rippleTrimLeft(clip.id, inc); break;
      case 'ripple-r': rippleTrimRight(clip.id, inc); break;
      case 'slip':     slipClip(clip.id, inc); break;
    }
  }

  function onPointerUp(e: PointerEvent) {
    // Inter-track drop applies to the plain select-tool body drag only.
    // Ripple-move is a group operation; letting the anchor cross lanes
    // mid-group would split the move semantics and surprise the user.
    const wasMove = drag.current?.kind === 'move';
    if (!drag.current) return;
    drag.current = null;
    setDropIndicator(null);
    setDragVisualY(0);   // snap visual back; the actual track move (if any) follows
    setDropBlocked(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    // Commit the drag as ONE undo step. Any inter-track / reorder logic
    // below this point still runs through the transaction (begin/end
    // brackets every mutation between pointerdown and pointerup).
    endTransaction();
    if (wasMove) {
      // First check: did the user drop the cursor INSIDE another clip
      // on the same track? If so, that's a reorder gesture — drop in
      // the left half of `target` means "insert before"; right half
      // means "insert after". Other clips on the track pack tight
      // around the new order. The live drag is clamp-blocked against
      // neighbors so the dragged clip itself doesn't visibly cross
      // over, but the CURSOR's raw position tells us the intent.
      const myTrack = tracks.find((t) => t.clips.some((c) => c.id === clip.id));
      if (myTrack) {
        const rect = laneRef.current?.getBoundingClientRect();
        if (rect && rect.width > 0) {
          const dropTime = ((e.clientX - rect.left) / rect.width) * duration;
          const targetClip = myTrack.clips.find((c) => {
            if (c.id === clip.id) return false;
            const cDur = (c.out - c.in) / (c.rate || 1);
            return dropTime > c.start + 1e-3 && dropTime < c.start + cDur - 1e-3;
          });
          if (targetClip) {
            const targetDur = (targetClip.out - targetClip.in) / (targetClip.rate || 1);
            const targetMid = targetClip.start + targetDur / 2;
            const insertBefore = dropTime < targetMid;
            reorderClipNearClip(clip.id, targetClip.id, insertBefore);
            return;
          }
        }
      }
      // No reorder match — fall through to the inter-track drop check.
      // Inter-track drag for video clips: hit-test for a .lane-content
      // with data-vtrack different from the clip's current track. If
      // the target track has no clip overlapping [clip.start, clipEnd),
      // move the clip there. Drop-on-empty-lane only.
      const targets = document.elementsFromPoint(e.clientX, e.clientY);
      for (const el of targets) {
        const targetTrackId = (el as HTMLElement).dataset?.vtrack;
        if (!targetTrackId) continue;
        const targetTrack = tracks.find((t) => t.id === targetTrackId);
        if (!targetTrack) break;
        if (targetTrack.clips.some((c) => c.id === clip.id)) break;   // already here
        const clipEnd = clip.start + (clip.out - clip.in) / (clip.rate || 1);
        const collides = targetTrack.clips.some((c) => {
          const cEnd = c.start + (c.out - c.in) / (c.rate || 1);
          return clip.start < cEnd - 1e-3 && c.start < clipEnd - 1e-3;
        });
        if (!collides) moveClipToTrack(clip.id, targetTrackId);
        break;
      }
    }
  }

  const cls = [
    'clip', 'video',
    selected ? 'selected' : '',
    pending ? 'pending' : '',
    failed ? 'failed' : '',
    darkThumb && !pending && !failed ? 'dark-thumb' : '',
    tool === 'blade' ? 'blade-cursor' : '',
    dragVisualY !== 0 ? 'inter-track-dragging' : '',
    dropBlocked ? 'inter-track-blocked' : '',
  ].filter(Boolean).join(' ');

  const deleteClipAction = useStore((s) => s.deleteClip);

  return (
    <div
      className={cls}
      data-clip-id={clip.id}
      style={{
        left: `${left}%`,
        width: `${width}%`,
        // Inter-track drag visual: translateY follows the cursor's lane;
        // 0 means the clip sits on its real track. transition keeps it
        // smooth when snapping to a target lane mid-drag. Overflow on the
        // lane is set to visible during the drag (see CSS) so the clip
        // can render across lane boundaries.
        transform: dragVisualY !== 0 ? `translateY(${dragVisualY}px)` : undefined,
      }}
      onPointerDown={onPointerDownBody}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      title={label}
    >
      {!pending && <div className="thumb" />}
      <div
        className="trim-handle trim-l"
        onPointerDown={(e) => onPointerDownEdge('l', e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div
        className="trim-handle trim-r"
        onPointerDown={(e) => onPointerDownEdge('r', e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {/* Progress fill — paints from the left of the clip placeholder
       *  in solid lavender, matching the gen's progress %. Scales
       *  cleanly with timeline zoom because its width is a CSS
       *  percentage of the clip width (the clip itself is already
       *  zoom-aware). Behind the label + sub via z-index. */}
      {pending && typeof pct === 'number' && (
        <div
          className="clip-progress-fill"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          aria-hidden
        />
      )}
      <span className="clip-label">{label}</span>
      {subParts ? (
        <span className="clip-sub">
          <span className="clip-sub-model">{subParts.prefix}</span>
          <span className="clip-sub-sep"> · </span>
          <span className="clip-sub-dur">{subParts.dur}</span>
        </span>
      ) : (
        <span className="clip-sub">{sub}</span>
      )}
      {pending && <div className="spin" />}
      {/* × button on stuck / failed generations — Backspace works too,
       *  but stuck Pika gens are common enough that an obvious affordance
       *  beats a hotkey the user has to discover. Visible on hover for
       *  pending, always visible for failed. */}
      {(pending || failed) && (
        <button
          className="clip-x"
          title={failed ? 'Delete failed generation' : 'Cancel + delete this stuck generation'}
          aria-label="Delete clip"
          onPointerDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); deleteClipAction(clip.id); }}
        >×</button>
      )}
      {/* Link affordance on a V clip is ONE of two states, never both:
       *   - hasLinkedAudio → chain-icon INDICATOR (read-only). Tells
       *     the user "this clip's audio lives on the A-lane". Action
       *     (Unlink / Relink) lives on the A clip — single source of
       *     truth so the UI doesn't get noisy.
       *   - !hasLinkedAudio + ready video → "Extract audio" button.
       *     Promotes embedded audio to a linked A-lane clip the user
       *     can trim / fade / mix independently. */}
      <VideoClipLinkAffordance clip={clip} scene={scene} />
    </div>
  );
}

function VideoClipLinkAffordance({ clip, scene }: { clip: Clip; scene: Scene | undefined }) {
  const hasLinkedAudio = useStore((s) => {
    if (!clip.linkId || !s.timeline) return false;
    return s.timeline.audioTracks.some((t) => t.clips.some((c) => c.linkId === clip.linkId));
  });
  const [busy, setBusy] = useState(false);
  if (hasLinkedAudio) {
    return (
      <span
        className="clip-link-indicator"
        title="Audio is extracted on an A-lane · use the A-clip's Unlink / Relink to manage"
        aria-hidden
      >🔗</span>
    );
  }
  const isReadyVideo = scene?.kind === 'pika-gen'
    ? scene.status === 'ready' && !!scene.videoSrc
    : scene?.kind === 'video-import';
  if (!isReadyVideo) return null;
  async function onClick(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.extractClipAudio(clip.id);
      if (!r.ok) console.warn('[extract] failed:', r.error, r.detail);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      className="clip-extract-btn"
      title="Extract embedded audio onto an A-lane clip (still linked — moves/trims/blade cascade)"
      onPointerDown={(e) => { e.stopPropagation(); }}
      onClick={onClick}
      disabled={busy}
    >
      {busy ? '…' : '⎘ Audio'}
    </button>
  );
}
