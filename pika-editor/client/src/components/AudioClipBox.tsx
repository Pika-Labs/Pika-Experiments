import { useRef, useState, type PointerEvent } from 'react';
import { useStore } from '../store';
import { Waveform } from './Waveform';
import { audio } from '../audio';
import type { MusicClip, SfxClip } from '../types';

interface BaseProps {
  duration: number;
  laneRef: React.RefObject<HTMLDivElement>;
}

interface MusicProps extends BaseProps {
  kind: 'music';
  clip: MusicClip;
  // Optional: a pending/generating music clip has no audio yet. The
  // component already guards `src` as possibly-absent (see the `src ? …`
  // and `!pending && src &&` checks below), so the prop is optional too.
  src?: string;
}

interface SfxProps extends BaseProps {
  kind: 'sfx';
  clip: SfxClip;
}

type Props = MusicProps | SfxProps;

type DragKind = 'move' | 'trim-l' | 'trim-r' | null;

export function AudioClipBox(props: Props) {
  const { kind, clip, duration, laneRef } = props as any;
  const tool = useStore((s) => s.tool);
  const selectClip = useStore((s) => s.selectClip);
  const selectedClipIds = useStore((s) => s.selectedClipIds);
  const moveMusicClip = useStore((s) => s.moveMusicClip);
  const trimMusicClipLeft = useStore((s) => s.trimMusicClipLeft);
  const trimMusicClipRight = useStore((s) => s.trimMusicClipRight);
  const moveSfxClip = useStore((s) => s.moveSfxClip);
  const trimSfxClipLeft = useStore((s) => s.trimSfxClipLeft);
  const trimSfxClipRight = useStore((s) => s.trimSfxClipRight);
  const splitSfxClipAt = useStore((s) => s.splitSfxClipAt);
  const splitMusicClipAt = useStore((s) => s.splitMusicClipAt);
  const moveAudioClipToTrack = useStore((s) => s.moveAudioClipToTrack);
  const moveSelectedBy = useStore((s) => s.moveSelectedBy);
  const audioTracks = useStore((s) => s.timeline?.audioTracks ?? []);
  const breakLink = useStore((s) => s.breakLink);
  const relinkAudioClip = useStore((s) => s.relinkAudioClip);
  const beginTransaction = useStore((s) => s.beginTransaction);
  const endTransaction = useStore((s) => s.endTransaction);
  // Whether THIS audio clip has a relink target — i.e. a V clip with
  // the same sceneId (parsed from the `sfx_<sceneId>` id convention).
  // Used to show a "Relink" affordance when the clip was extracted
  // previously but is currently detached.
  const hasRelinkTarget = useStore((s) => {
    if (clip.linkId) return false;             // already linked
    if (!clip.id?.startsWith('sfx_')) return false;
    const sceneId = clip.id.slice(4);
    return !!s.timeline?.tracks.flatMap((tr) => tr.clips).some((c) => c.sceneId === sceneId);
  });

  const selected = selectedClipIds.includes(clip.id);

  const drag = useRef<{ kind: DragKind; startX: number; startY: number; pxPerSec: number; origStart: number; lastDelta: number } | null>(null);
  // Visual-only Y-offset applied to the dragged clip so it follows the
  // cursor across lanes. Doesn't change the data model — the actual
  // track move happens on pointer-up via moveAudioClipToTrack(). Body
  // attribute `data-audio-dragging` relaxes lane `overflow: hidden` so
  // the clip can render outside its original lane during the drag.
  const [dragVisualY, setDragVisualY] = useState(0);

  const pending = kind === 'music' ? (clip.status === 'pending' || clip.status === 'generating' || !(props as MusicProps).src) : !clip.src;
  const left = (clip.start / duration) * 100;
  const width = ((clip.out - clip.in) / duration) * 100;

  function pxPerSec(): number {
    const w = laneRef.current?.clientWidth ?? 1;
    return w / duration;
  }

  function moveAction(absStart: number) {
    if (kind === 'music') moveMusicClip(clip.id, absStart);
    else moveSfxClip(clip.id, absStart);
  }
  function trimLAction(inc: number) {
    if (kind === 'music') trimMusicClipLeft(clip.id, inc);
    else trimSfxClipLeft(clip.id, inc);
  }
  function trimRAction(inc: number) {
    if (kind === 'music') trimMusicClipRight(clip.id, inc);
    else trimSfxClipRight(clip.id, inc);
  }

  function onPointerDownBody(e: PointerEvent) {
    if (tool === 'blade' && (kind === 'sfx' || kind === 'music')) {
      e.stopPropagation();
      const rect = laneRef.current!.getBoundingClientRect();
      const atTime = ((e.clientX - rect.left) / rect.width) * duration;
      if (kind === 'music') splitMusicClipAt(clip.id, atTime);
      else splitSfxClipAt(clip.id, atTime);
      return;
    }
    if (e.button !== 0 || pending) return;
    e.stopPropagation();
    selectClip(clip.id, e.shiftKey);
    drag.current = { kind: 'move', startX: e.clientX, startY: e.clientY, pxPerSec: pxPerSec(), origStart: clip.start, lastDelta: 0 };
    document.body.setAttribute('data-audio-dragging', 'true');
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginTransaction();
  }
  function onPointerDownEdge(side: 'l' | 'r', e: PointerEvent) {
    if (e.button !== 0 || pending) return;
    e.stopPropagation();
    selectClip(clip.id, false);
    drag.current = { kind: side === 'l' ? 'trim-l' : 'trim-r', startX: e.clientX, startY: e.clientY, pxPerSec: pxPerSec(), origStart: clip.start, lastDelta: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginTransaction();
  }
  function onPointerMove(e: PointerEvent) {
    const d = drag.current; if (!d) return;
    const deltaSec = (e.clientX - d.startX) / d.pxPerSec;
    if (d.kind === 'move') {
      // Multi-select: if more than just this clip is selected, route
      // through moveSelectedBy so the entire group (video + audio +
      // captions + comments) shifts together. Single-select: use the
      // per-kind moveAction which keeps snap + per-track collision
      // checks for the audio clip's own lane.
      const isGroup = selectedClipIds.length > 1 && selectedClipIds.includes(clip.id);
      if (isGroup) {
        const inc = deltaSec - d.lastDelta;
        if (Math.abs(inc) >= 1e-4) {
          moveSelectedBy(inc, clip.id);
          d.lastDelta = deltaSec;
        }
      } else {
        moveAction(Math.round((d.origStart + deltaSec) * 1000) / 1000);
        d.lastDelta = deltaSec;
      }
      // Visual cursor-follow on the Y axis so the clip lifts up off
      // its original lane and tracks the cursor toward the target
      // lane. The actual moveAudioClipToTrack happens on pointer-up.
      setDragVisualY(e.clientY - d.startY);
      return;
    }
    const inc = deltaSec - d.lastDelta;
    if (Math.abs(inc) < 1e-4) return;
    d.lastDelta = deltaSec;
    if (d.kind === 'trim-l') trimLAction(inc);
    else if (d.kind === 'trim-r') trimRAction(inc);
  }
  function onPointerUp(e: PointerEvent) {
    const wasMoveDrag = drag.current?.kind === 'move';
    if (!drag.current) return;
    drag.current = null;
    setDragVisualY(0);
    document.body.removeAttribute('data-audio-dragging');
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    endTransaction();
    // Inter-track drag (any audio clip): hit-test under the cursor for a
    // .lane-content[data-track] element; if that track differs from the
    // clip's current one AND has no clip overlapping the dragged clip's
    // [start, end) range, move it. The collision check matches the
    // server-side findOrCreateAudioLane policy — same-track only ever
    // allows one clip at a time.
    if (wasMoveDrag) {
      const targets = document.elementsFromPoint(e.clientX, e.clientY);
      let found = false;
      for (const el of targets) {
        const targetTrackId = (el as HTMLElement).dataset?.track;
        if (!targetTrackId) continue;
        found = true;
        const targetTrack = audioTracks.find((t) => t.id === targetTrackId);
        if (!targetTrack) { console.log('[audio-drag] no such track', targetTrackId); break; }
        const onThisTrack = targetTrack.clips.some((c) => c.id === clip.id);
        if (onThisTrack) { console.log('[audio-drag] same track — no move'); break; }
        const clipEnd = clip.start + (clip.out - clip.in);
        const collides = targetTrack.clips.some((c) =>
          clip.start < c.start + (c.out - c.in) - 1e-3 && c.start < clipEnd - 1e-3);
        if (collides) { console.log('[audio-drag] collision — can\'t drop here'); break; }
        console.log('[audio-drag] moving clip', clip.id, '→ track', targetTrackId);
        moveAudioClipToTrack(clip.id, targetTrackId);
        break;
      }
      if (!found) console.log('[audio-drag] no [data-track] under cursor at', e.clientX, e.clientY);
    }
  }

  const baseCls = kind === 'music' ? 'clip audio-clip' : 'clip sfx-clip';
  const pendingCls = pending ? (kind === 'music' ? 'music-pending' : 'sfx-pending') : '';
  const selectedCls = selected ? 'selected' : '';
  const cls = `${baseCls} ${pendingCls} ${selectedCls} ${tool === 'blade' && (kind === 'sfx' || kind === 'music') ? 'blade-cursor' : ''}`.trim();

  const label = kind === 'music'
    ? (pending
        ? (clip.status === 'generating' ? 'Generating…' : 'Music · pending')
        : (clip.prompt ? clip.prompt.slice(0, 60) : 'music'))
    : (pending
        ? `SFX · ${clip.prompt ? clip.prompt.slice(0, 40) : 'generating'}`
        : (clip.prompt ? clip.prompt.slice(0, 40) : (clip.src.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/^sfx_[^_]+_/, '').replace(/_/g, ' ') ?? 'sfx')));
  const src = kind === 'music' ? (props as MusicProps).src : clip.src;
  const waveColor = kind === 'music' ? 'rgba(255,255,255,0.6)' : 'rgba(13,13,13,0.5)';
  // Slice the waveform peaks by [in, out] within the SOURCE audio's
  // duration so trimming reveals/hides peaks truthfully. Precedence
  // matches the trim handlers in store.ts:
  //   1) clip.naturalDuration if the schema knows it,
  //   2) the decoded AudioBuffer's duration (covers VO clips auto-extracted
  //      before naturalDuration was being written),
  //   3) the legacy fallback to clip.out, which makes the waveform stretch
  //      to fit because we don't know the real source length.
  const buffered = src ? audio.buffers.get(src)?.duration ?? 0 : 0;
  const natural = clip.naturalDuration && clip.naturalDuration > 0
    ? clip.naturalDuration
    : (buffered > 0 ? buffered : (clip.out > 0 ? clip.out : 1));
  const inFrac = Math.max(0, Math.min(1, clip.in / natural));
  const outFrac = Math.max(inFrac + 1e-3, Math.min(1, clip.out / natural));

  return (
    <div
      className={`${cls} ${dragVisualY !== 0 ? 'audio-clip-dragging' : ''}`}
      data-clip-id={clip.id}
      style={{
        left: `${left}%`,
        width: `${width}%`,
        transform: dragVisualY !== 0 ? `translateY(${dragVisualY}px)` : undefined,
        zIndex: dragVisualY !== 0 ? 100 : undefined,
      }}
      onPointerDown={onPointerDownBody}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title={kind === 'music' ? (clip.prompt ?? '') : ''}
    >
      {!pending && src && <Waveform src={src} color={waveColor} inFrac={inFrac} outFrac={outFrac} />}
      <div className="trim-handle trim-l"
        onPointerDown={(e) => onPointerDownEdge('l', e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="trim-handle trim-r"
        onPointerDown={(e) => onPointerDownEdge('r', e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <span className="clip-label">{label}</span>
      {pending && <div className="spin" />}
      {clip.linkId ? (
        <button
          className="clip-link-badge clip-link-badge-on"
          title="Unlink from source video — moves/trims stop cascading"
          onPointerDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => {
            e.stopPropagation();
            if (clip.linkId) breakLink(clip.linkId);
          }}
        >🔗 Unlink</button>
      ) : hasRelinkTarget ? (
        <button
          className="clip-link-badge clip-link-badge-off"
          title="Relink to its source video — moves/trims/blade cascade again"
          onPointerDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => {
            e.stopPropagation();
            relinkAudioClip(clip.id);
          }}
        >⛓ Relink</button>
      ) : null}
    </div>
  );
}
