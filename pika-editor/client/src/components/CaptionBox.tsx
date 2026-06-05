import { useRef, type PointerEvent } from 'react';
import { useStore } from '../store';
import type { CaptionRow } from '../types';

interface Props {
  row: CaptionRow;
  duration: number;
  laneRef: React.RefObject<HTMLDivElement>;
}

type DragKind = 'move' | 'trim-l' | 'trim-r' | null;

/**
 * A single caption row rendered on the CC lane. Mirrors the AudioClipBox
 * interaction model — click to select, drag to move, drag handles on the
 * edges to trim. Blade tool splits the row at the click point.
 */
export function CaptionBox({ row, duration, laneRef }: Props) {
  const tool = useStore((s) => s.tool);
  // Two selection signals:
  //   - selectedCaptionId (singular) — the row the Captions panel
  //     is currently editing. Set on single-click.
  //   - selectedClipIds (array) — the unified multi-select bag used
  //     by the marquee and shift-click. Captions live in here too so
  //     a drag-rectangle can pick up many at once.
  // We render `.selected` if EITHER signal includes this row.
  const selected = useStore((s) =>
    s.selectedCaptionId === row.id || s.selectedClipIds.includes(row.id)
  );
  const selectCaption = useStore((s) => s.selectCaption);
  const selectClip = useStore((s) => s.selectClip);
  const moveCaptionRow = useStore((s) => s.moveCaptionRow);
  const moveSelectedBy = useStore((s) => s.moveSelectedBy);
  const trimCaptionRowLeft = useStore((s) => s.trimCaptionRowLeft);
  const trimCaptionRowRight = useStore((s) => s.trimCaptionRowRight);
  const splitCaptionRowAt = useStore((s) => s.splitCaptionRowAt);
  const beginTransaction = useStore((s) => s.beginTransaction);
  const endTransaction = useStore((s) => s.endTransaction);

  const drag = useRef<{ kind: DragKind; startX: number; pxPerSec: number; origStart: number; lastDelta: number } | null>(null);

  const left = (row.start / duration) * 100;
  // No JS floor on the width — the visual minimum is enforced in CSS as
  // a small pixel `min-width`. The previous percent clamp (0.4%) felt like
  // a hard lock on long timelines: 0.4% of 5 minutes is 1.2 seconds, so a
  // caption shrinking below 1.2s LOOKED the same width even as the data
  // shrank, making the trim feel stuck. Pixel-based clamp behaves the
  // same at every zoom: clip stays grabbable, but the data is free to
  // go all the way down to the trim's data floor (50ms in store.ts).
  const width = ((row.end - row.start) / duration) * 100;

  function pxPerSec(): number {
    return (laneRef.current?.clientWidth ?? 1) / duration;
  }

  function onPointerDownBody(e: PointerEvent) {
    if (tool === 'blade') {
      e.stopPropagation();
      const rect = laneRef.current!.getBoundingClientRect();
      const atTime = ((e.clientX - rect.left) / rect.width) * duration;
      splitCaptionRowAt(row.id, atTime);
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    // Single-click → both signals: panel opens on this row AND chip
    // appears in chat. Shift-click → ADD to multi-select (selectedClipIds)
    // without opening the panel for the just-clicked row (the user is
    // building a bulk selection, not switching the edit target).
    if (e.shiftKey) {
      selectClip(row.id, true);
    } else {
      selectCaption(row.id);
      selectClip(row.id, false);
    }
    drag.current = { kind: 'move', startX: e.clientX, pxPerSec: pxPerSec(), origStart: row.start, lastDelta: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginTransaction();
  }
  function onPointerDownEdge(side: 'l' | 'r', e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectCaption(row.id);
    selectClip(row.id, false);
    drag.current = { kind: side === 'l' ? 'trim-l' : 'trim-r', startX: e.clientX, pxPerSec: pxPerSec(), origStart: row.start, lastDelta: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginTransaction();
  }
  function onPointerMove(e: PointerEvent) {
    const d = drag.current; if (!d) return;
    const deltaSec = (e.clientX - d.startX) / d.pxPerSec;
    if (d.kind === 'move') {
      // Group-move: if this row is part of a multi-selection (any kind
      // of clip/row), route through the unified moveSelectedBy so the
      // entire group — video clips, audio clips, caption rows, floating
      // comments — shifts together. Previously this only moved other
      // CAPTION ROWS in the selection; mixed selections (e.g. caption +
      // V clip) would only move the captions.
      const selIds = useStore.getState().selectedClipIds;
      const inGroup = selIds.length > 1 && selIds.includes(row.id);
      if (inGroup) {
        const inc = deltaSec - d.lastDelta;
        if (Math.abs(inc) >= 1e-4) {
          moveSelectedBy(inc, row.id);
          d.lastDelta = deltaSec;
        }
      } else {
        moveCaptionRow(row.id, Math.round((d.origStart + deltaSec) * 1000) / 1000);
        d.lastDelta = deltaSec;
      }
      return;
    }
    const inc = deltaSec - d.lastDelta;
    if (Math.abs(inc) < 1e-4) return;
    d.lastDelta = deltaSec;
    if (d.kind === 'trim-l') trimCaptionRowLeft(row.id, inc);
    else trimCaptionRowRight(row.id, inc);
  }
  function onPointerUp(e: PointerEvent) {
    if (!drag.current) return;
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    endTransaction();
  }

  const cls = `clip cc-clip ${selected ? 'selected' : ''} ${tool === 'blade' ? 'blade-cursor' : ''}`.trim();
  const label = (row.text || '').slice(0, 36) || 'caption';

  return (
    <div
      className={cls}
      data-clip-id={row.id}
      style={{ left: `${left}%`, width: `${width}%` }}
      onPointerDown={onPointerDownBody}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title={row.text}
    >
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
    </div>
  );
}
