import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useStore } from '../store';
import type { AudioTrack } from '../types';
import { VideoClip } from './Clip';
import { CommentComposer } from './CommentComposer';
import { CommentMarker } from './CommentMarker';
import { AudioClipBox } from './AudioClipBox';
import { CaptionBox } from './CaptionBox';
import { AudioGenComposer } from './AudioGenComposer';
import { Mixer } from './Mixer';
import { ClipGainPopover } from './ClipGainPopover';
import * as api from '../api';
import { effectiveDuration } from '../edit';

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}

/** Collect every clip/caption-row id whose DOM rect intersects the
 *  marquee rect. Walks the live DOM (cheap — clips are 2-100 per
 *  project) and matches against the data-clip-id attribute we stamp
 *  on each .clip element. Caption rows expose their id via a .cc-clip
 *  ancestor. Lane-label / handle elements are ignored — `.clip` is the
 *  outer clip box and `data-clip-id` lives there. */
function clipsInMarquee(m: { x0: number; y0: number; x: number; y: number }, lanesEl: HTMLDivElement | null): string[] {
  if (!lanesEl) return [];
  const lanesRect = lanesEl.getBoundingClientRect();
  const left = Math.min(m.x0, m.x);
  const right = Math.max(m.x0, m.x);
  const top = Math.min(m.y0, m.y);
  const bottom = Math.max(m.y0, m.y);
  // Tiny drags (< 4px) don't count as marquees — treat as plain clicks.
  if (right - left < 4 && bottom - top < 4) return [];
  const out: string[] = [];
  const els = lanesEl.querySelectorAll<HTMLElement>('.clip[data-clip-id], .cc-clip[data-clip-id]');
  for (const el of Array.from(els)) {
    const r = el.getBoundingClientRect();
    const rLeft = r.left - lanesRect.left;
    const rRight = r.right - lanesRect.left;
    const rTop = r.top - lanesRect.top;
    const rBottom = r.bottom - lanesRect.top;
    const intersects = rLeft < right && rRight > left && rTop < bottom && rBottom > top;
    if (intersects) {
      const id = el.getAttribute('data-clip-id');
      if (id) out.push(id);
    }
  }
  return out;
}

function rulerTicks(duration: number) {
  const stepRaw = duration / 7;
  const candidates = [1, 2, 5, 10, 15, 30, 60];
  const step = candidates.find((c) => c >= stepRaw) ?? 60;
  const out: number[] = [];
  for (let t = 0; t <= duration + 1e-3; t += step) out.push(t);
  return { step, ticks: out };
}

// MusicClipBox + SfxClipBox now live in ./AudioClipBox as a single component.

interface ComposerState {
  at: number;
  clipId?: string;
  trackId?: string;
  ghostClipId?: string | null;
  screenX: number;
  screenY: number;
}

export function Timeline() {
  const timeline = useStore((s) => s.timeline);
  const playhead = useStore((s) => s.playhead);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const selectedClipIds = useStore((s) => s.selectedClipIds);
  const dropIndicator = useStore((s) => s.dropIndicator);
  const clearSelection = useStore((s) => s.clearSelection);
  const snapEnabled = useStore((s) => s.snapEnabled);
  const toggleVideoTrackMute = useStore((s) => s.toggleVideoTrackMute);
  const toggleSnap = useStore((s) => s.toggleSnap);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setZoom = useStore((s) => s.setZoom);

  const v1LaneRef = useRef<HTMLDivElement>(null);
  const v2LaneRef = useRef<HTMLDivElement>(null);
  const cmtLaneRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef<boolean>(false);
  const addVideoImport = useStore((s) => s.addVideoImport);
  const addImageOverlay = useStore((s) => s.addImageOverlay);
  const setRippleDropIndicator = useStore((s) => s.setRippleDropIndicator);
  const rippleDropIndicator = useStore((s) => s.rippleDropIndicator);
  const rippleInsertAt = useStore((s) => s.rippleInsertAt);
  const addAudioImport = useStore((s) => s.addAudioImport);
  const syncSelectionAttachments = useStore((s) => s.syncSelectionAttachments);

  // Whenever the timeline selection changes, mirror it into the chat
  // attachment chips — same effect as clicking "Talk about it" on each
  // selected clip's source asset. Manual attachments survive untouched
  // (the store's sync action keeps them); selecting nothing clears the
  // selection-derived chips but never the manual ones.
  useEffect(() => {
    if (!timeline) {
      syncSelectionAttachments([]);
      return;
    }
    type Att = { id: string; rel: string; kind: 'image' | 'video' | 'audio' | 'other'; name: string; startSec?: number; endSec?: number };
    const atts: Att[] = [];
    for (const id of selectedClipIds) {
      // Look on video tracks first, then audio tracks.
      let pushed = false;
      for (const tr of timeline.tracks) {
        const v = tr.clips.find((c) => c.id === id);
        if (v) {
          const scene = timeline.scenes.find((s) => s.id === v.sceneId);
          const rel = scene?.kind === 'pika-gen' ? scene.videoSrc
            : (scene as { src?: string } | undefined)?.src;
          if (rel) {
            const normalizedRel = rel.startsWith('assets/') ? rel : `assets/${rel}`;
            const masterDur = (v.out - v.in) / (v.rate || 1);
            atts.push({
              id: `sel_${id}`,
              rel: normalizedRel,
              kind: 'video',
              name: scene?.labels?.[0] ?? v.sceneId,
              startSec: v.start,
              endSec: v.start + masterDur,
            });
          }
          pushed = true;
          break;
        }
      }
      if (pushed) continue;
      for (const tr of timeline.audioTracks ?? []) {
        const a = tr.clips.find((c) => c.id === id);
        if (a && a.src) {
          const normalizedRel = a.src.startsWith('assets/') ? a.src : `assets/${a.src}`;
          const audioDur = a.out - a.in;
          atts.push({
            id: `sel_${id}`,
            rel: normalizedRel,
            kind: 'audio',
            name: id,
            startSec: a.start,
            endSec: a.start + audioDur,
          });
          break;
        }
      }
    }
    syncSelectionAttachments(atts);
  }, [selectedClipIds, timeline, syncSelectionAttachments]);

  // Zoom centered on the playhead: after pxPerSec changes, adjust scrollLeft
  // so the playhead's screen position stays put. (Without this, zooming feels
  // like the timeline slides under the cursor.)
  function zoomTo(newPx: number) {
    const el = scrollRef.current;
    if (!el || !timeline) { setZoom(newPx); return; }
    const oldPx = pxPerSec;
    const ph = useStore.getState().playhead;
    const oldPlayheadAbsX = ph * oldPx;
    const viewportRelX = oldPlayheadAbsX - el.scrollLeft;   // current screen offset
    setZoom(newPx);
    // Apply scrollLeft on the next frame so the new canvas width is in place.
    requestAnimationFrame(() => {
      const real = useStore.getState().pxPerSec;             // honor clamp inside setZoom
      const newPlayheadAbsX = ph * real;
      el.scrollLeft = Math.max(0, newPlayheadAbsX - viewportRelX);
    });
  }
  function zoomFit() {
    const el = scrollRef.current;
    if (!el || !timeline) return;
    // Subtract the 42px lane-label gutter so the actual content fits.
    // No local floor — setZoom owns the clamp (currently 4 px/sec). If
    // we floored here at 20, long projects would overflow the viewport
    // and "fit to width" would feel broken/locked.
    const target = (el.clientWidth - 42) / Math.max(1, effectiveDuration(timeline));
    setZoom(target);
    requestAnimationFrame(() => { if (el) el.scrollLeft = 0; });
  }

  // Expose for global hotkeys (0, −, +). Hotkeys handler can't access the
  // Timeline component's closure directly, so we stash the callbacks on
  // window. Cleaned up on unmount.
  useEffect(() => {
    (window as any).__paeZoomIn = () => zoomTo(useStore.getState().pxPerSec * 1.25);
    (window as any).__paeZoomOut = () => zoomTo(useStore.getState().pxPerSec / 1.25);
    (window as any).__paeZoomFit = zoomFit;
    return () => {
      delete (window as any).__paeZoomIn;
      delete (window as any).__paeZoomOut;
      delete (window as any).__paeZoomFit;
    };
  });

  // Auto fit-to-window once on first paint where both the timeline and the
  // scroll container are ready. Same behavior as pressing '0'. Latched
  // per-project (by name) so subsequent re-renders (clip moves, scrubs)
  // don't snap the zoom back; opening a different project re-fits.
  const didAutoFit = useRef<string | null>(null);
  useEffect(() => {
    if (!timeline) return;
    const el = scrollRef.current;
    if (!el || el.clientWidth <= 0) return;
    if (didAutoFit.current === timeline.name) return;
    didAutoFit.current = timeline.name;
    // Defer one frame so the layout has stabilized (panels mounted, scroll
    // container reflowed). zoomFit reads clientWidth.
    requestAnimationFrame(() => zoomFit());
  }, [timeline]);

  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [audioComposer, setAudioComposer] = useState<{ kind: 'sfx' | 'music'; at: number; durationSec?: number; screenX: number; screenY: number; targetTrackId?: string } | null>(null);
  const [dropHover, setDropHover] = useState(false);
  /** Marquee selection — drag a rectangle on empty lane space to
   *  select every clip / caption that intersects it. Stored in DOM
   *  pixel coords relative to the lanes container so the rendered
   *  overlay div can position itself directly. */
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x: number; y: number; additive: boolean } | null>(null);
  const marqueeStarted = useRef<boolean>(false);

  function onMarqueePointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    if (tool !== 'select') return;
    // Only start a marquee on the empty lane background — never on a
    // clip / handle / button / etc. `lane-content` is the empty area
    // inside each lane row; `lanes` is the outer wrapper. Anything
    // else (a clip, the ruler, a lane label) is off-limits so the
    // marquee doesn't fight existing interactions.
    const t = e.target as HTMLElement;
    const onEmpty = t.classList.contains('lane-content')
      || t.classList.contains('lanes')
      || (t.classList.contains('lane') && !t.closest('.clip'));
    if (!onEmpty) return;
    const rect = lanesRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setMarquee({ x0: x, y0: y, x, y, additive: e.shiftKey || e.metaKey });
    // NOTE: do NOT set marqueeStarted=true here — that's the "real drag
    // happened, suppress the synthetic click that follows pointerup"
    // flag. Setting it on bare pointerdown blocked the CC-lane click-
    // to-add-caption interaction (a zero-distance click). The promise
    // in the comment up top was "tiny drags don't count" and now we
    // actually honor it: only flip the flag once the cursor has moved
    // past MARQUEE_MIN_PX (see onMarqueePointerMove).
    //
    // NOTE 2: we deliberately do NOT call e.preventDefault() here.
    // preventDefault on pointerdown suppresses the synthetic mouse
    // events that follow pointerup — including the `click` event we
    // rely on to fire ccLaneClick / v1EmptyClick. Text selection on
    // drag is prevented via `user-select: none` on .lanes in CSS
    // (the wrapper element this handler is attached to).
    //
    // NOTE 3: we also do NOT call setPointerCapture here. Capture
    // redirects the synthetic `click` that fires after pointerup to
    // the capturing element (lanes wrapper), and React's onClick on
    // `.lane-content` then never runs — that's why click-to-add on
    // the CC lane stopped working. Capture is only needed once a
    // real drag is in progress (so dragging off the wrapper still
    // sees pointermove/up), so we defer it to onMarqueePointerMove,
    // gated on marqueeStarted.
  }
  function onMarqueePointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!marquee) return;
    const rect = lanesRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const next = { ...marquee, x, y };
    setMarquee(next);
    // Only count this as a real marquee once the pointer has moved
    // more than a few pixels — distinguishes a drag from a click.
    const MARQUEE_MIN_PX = 4;
    const dx = x - marquee.x0;
    const dy = y - marquee.y0;
    if (!marqueeStarted.current && (dx * dx + dy * dy) >= MARQUEE_MIN_PX * MARQUEE_MIN_PX) {
      marqueeStarted.current = true;
      // Now that we're sure this is a drag, capture the pointer so
      // releasing outside the lanes wrapper still fires pointerup
      // here. Doing this BEFORE the threshold blocked the click-
      // to-add interactions on empty lanes (see onMarqueePointerDown
      // NOTE 3).
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    }
    // Live-update selection only while a real drag is happening — a
    // pre-threshold mousewobble shouldn't clear the existing selection.
    if (!marqueeStarted.current) return;
    const ids = clipsInMarquee(next, lanesRef.current);
    const baseline = marquee.additive ? useStore.getState().selectedClipIds : [];
    const merged = Array.from(new Set([...baseline, ...ids]));
    useStore.setState({ selectedClipIds: merged });
  }
  function onMarqueePointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (!marquee) return;
    setMarquee(null);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    // Tail of the drag prevents the synthetic click from firing
    // v1EmptyClick / ccLaneClick etc. We clear the latch on the
    // next tick so a fresh click still works.
    setTimeout(() => { marqueeStarted.current = false; }, 0);
  }
  const ccLaneRef = useRef<HTMLDivElement>(null);
  const addCaptionRow = useStore((s) => s.addCaptionRow);
  const selectCaption = useStore((s) => s.selectCaption);
  const setCaptionsPanelOpen = useStore((s) => s.setCaptionsPanelOpen);
  const captionsPanelOpen = useStore((s) => s.captionsPanelOpen);

  function ccLaneClick(e: React.MouseEvent) {
    // A marquee drag that just ended will fire a synthetic click on
    // whichever lane it ended over — ignore so it doesn't spawn a
    // stray caption row at the drop point.
    if (marqueeStarted.current) return;
    // Only insert a new row when the user clicked the empty lane background
    // (not on an existing CaptionBox). Default new-row length is 2.5s — easy
    // to drag to fit.
    if (!(e.target as HTMLElement).classList.contains('lane-content')) {
      // Clicked an existing row — selection is handled by CaptionBox itself.
      return;
    }
    if (!timeline) return;
    const rect = ccLaneRef.current!.getBoundingClientRect();
    const at = Math.max(0, ((e.clientX - rect.left) / rect.width) * duration);
    // Clamp the new row inside the gap between the click point and the
    // next existing row. Otherwise a 2.5s default extends into the
    // neighbour and we get overlapping captions stacking at different
    // heights in the preview. We don't need a lower-bound clamp — the
    // .lane-content guard above means the click can't land inside an
    // existing row, so `at` is already past the previous row's end.
    const rows = timeline.captions.rows;
    let upperBound = duration;
    for (const r of rows) {
      if (r.start > at && r.start < upperBound) upperBound = r.start;
    }
    const room = upperBound - at;
    if (room < 0.2) return; // nothing meaningful would fit
    const len = Math.min(2.5, room);
    const id = addCaptionRow(at, at + len, '');
    selectCaption(id);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropHover(false);
    setRippleDropIndicator(null);
    if (!timeline) return;
    const rect = v1LaneRef.current!.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left);
    const startSecBase = (x / rect.width) * duration;
    // Library drops always land BETWEEN cuts. Snap the raw cursor time
    // to the nearest cut boundary on V1+V2 (clip starts + ends), with
    // 0 and the timeline end always in the set so a drop near the
    // beginning or after the last clip works cleanly. Once snapped, the
    // ripple-insert below pushes every clip / audio clip / caption /
    // floating comment AT OR AFTER that time forward by the new clip's
    // duration — so the rest of the cut keeps its relative timing.
    const snappedStart = snapToCut(startSecBase);

    // Internal drag from the Reference Library — a JSON payload pointing
    // at a file that's already on disk under assets/. We just probe the
    // duration client-side and add it as a scene/clip without re-uploading.
    const refPayload = e.dataTransfer?.getData('application/x-pae-ref');
    if (refPayload) {
      try {
        const ref = JSON.parse(refPayload) as { rel: string; kind: 'video' | 'audio'; name: string };
        const dur = await probeMediaDuration(ref.rel, ref.kind);
        rippleInsertAt(snappedStart, dur);
        if (ref.kind === 'video') {
          addVideoImport({
            rel: ref.rel.replace(/^assets\//, ''),
            filename: ref.name,
            duration: dur,
            startSec: snappedStart,
            sfxRel: null, linkId: null,
          });
        } else if (ref.kind === 'audio') {
          addAudioImport({
            rel: ref.rel.startsWith('assets/') ? ref.rel : `assets/${ref.rel}`,
            name: ref.name,
            duration: dur,
            startSec: snappedStart,
          });
        }
      } catch (err) { console.error('ref drop failed', err); }
      return;
    }

    // External file drag from Finder — upload then add.
    const all = Array.from(e.dataTransfer?.files ?? []);
    const videos = all.filter((f) => f.type.startsWith('video/'));
    const audios = all.filter((f) => f.type.startsWith('audio/'));
    // PNG / WebP / JPG → image-overlay scene on V2 (composites over V1
    // with alpha rather than carving the timeline like a video clip).
    // Anim-PNG / GIF aren't differentiated here — they're imported as a
    // static at frame 0 for now; future iteration can detect via the
    // server upon upload and pick a different renderer path.
    const images = all.filter((f) => f.type.startsWith('image/'));
    if (videos.length === 0 && audios.length === 0 && images.length === 0) return;
    let startSec = startSecBase;
    for (const file of videos) {
      try {
        const r = await api.uploadImport(file);
        addVideoImport({
          rel: r.rel, filename: r.filename, duration: r.duration,
          startSec, sfxRel: r.sfxRel, linkId: r.linkId,
        });
        startSec += r.duration;
      } catch (err) {
        console.error('video import failed', err);
      }
    }
    let musicStartSec = startSecBase;
    for (const file of audios) {
      try {
        const r = await api.uploadMusic(file, musicStartSec);
        musicStartSec += r.durationSec;
      } catch (err) {
        console.error('music import failed', err);
      }
    }
    let imageStartSec = startSecBase;
    for (const file of images) {
      try {
        const r = await api.uploadImport(file);
        // Default duration 3s — matches the schema default. User can
        // trim afterwards. Lands on V2 (above V1) by default so the
        // overlay sits over whatever video is playing underneath.
        addImageOverlay({
          rel: r.rel, filename: r.filename,
          duration: r.duration || 3,
          startSec: imageStartSec,
        });
        imageStartSec += r.duration || 3;
      } catch (err) {
        console.error('image import failed', err);
      }
    }
  }

  /** Collect every cut boundary on the timeline (V clip starts + ends).
   *  Used to snap library drops to the nearest cut so a new clip always
   *  lands BETWEEN existing clips, never partially overlapping one.
   *  Boundaries include 0 and the timeline end so drops near either
   *  edge still snap cleanly. */
  function getCutBoundaries(): number[] {
    if (!timeline) return [0];
    const set = new Set<number>([0, duration]);
    for (const tr of timeline.tracks) {
      for (const c of tr.clips) {
        const end = c.start + (c.out - c.in) / (c.rate || 1);
        set.add(Math.round(c.start * 1000) / 1000);
        set.add(Math.round(end * 1000) / 1000);
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  /** Snap a raw cursor-time to the nearest cut boundary. */
  function snapToCut(t: number): number {
    const cuts = getCutBoundaries();
    let best = cuts[0];
    let bestDist = Math.abs(cuts[0] - t);
    for (const c of cuts) {
      const d = Math.abs(c - t);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return Math.max(0, best);
  }

  function handleDragOver(e: React.DragEvent) {
    // Accept both desktop file drags and internal Library ref drags.
    const items = Array.from(e.dataTransfer?.items ?? []);
    const hasFile = items.some((it) => it.kind === 'file');
    const hasRef = items.some((it) => it.type === 'application/x-pae-ref');
    if (hasFile || hasRef) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropHover(true);
      // Live snap indicator — show the user EXACTLY where the clip will
      // land (cut boundary), spanning every lane, so they understand the
      // ripple-insert before committing. Only fires for library/file
      // drags, not for in-timeline clip drags (those use the existing
      // per-track dropIndicator).
      const rect = v1LaneRef.current?.getBoundingClientRect();
      if (rect) {
        const x = Math.max(0, e.clientX - rect.left);
        const raw = (x / rect.width) * duration;
        setRippleDropIndicator({ timeSec: snapToCut(raw) });
      }
    }
  }
  function handleDragLeave(e: React.DragEvent) {
    const to = e.relatedTarget as Node | null;
    if (!to || !e.currentTarget.contains(to)) {
      setDropHover(false);
      setRippleDropIndicator(null);
    }
  }

  if (!timeline) return null;
  // Dynamic timeline length — rightmost edge of any clip. 1s minimum so
  // an empty timeline still has a non-zero ruler width.
  const duration = Math.max(effectiveDuration(timeline), 1);
  const { ticks } = rulerTicks(duration);
  // Width of the timeline canvas in px. Lanes use percentage-based clip
  // positioning, so scaling the wrapper width scales everything inside.
  const canvasWidthPx = Math.max(400, Math.round(pxPerSec * duration));

  const v1 = timeline.tracks.find((t) => t.kind === 'video');
  const v2 = timeline.tracks.find((t) => t.kind === 'overlay');
  const playheadPct = (playhead / duration) * 100;
  const floating = timeline.floatingComments ?? [];

  function rulerPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    scrubbing.current = true;
    const rect = rulerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setPlayhead((x / rect.width) * duration);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function rulerPointerMove(e: PointerEvent) {
    if (!scrubbing.current) return;
    const rect = rulerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setPlayhead((x / rect.width) * duration);
  }
  function rulerPointerUp(e: PointerEvent) {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  }

  // Click empty CMT lane → open composer at that x.
  function cmtLaneClick(e: React.MouseEvent) {
    if (marqueeStarted.current) return;   // tail of a marquee drag
    if (!(e.target as HTMLElement).classList.contains('lane-content')) return;
    const rect = cmtLaneRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const at = (x / rect.width) * duration;
    setComposer({ at, screenX: e.clientX, screenY: e.clientY });
  }

  // Click empty V1 (in select tool, no shift) → create a ghost clip + comment.
  async function v1EmptyClick(e: React.MouseEvent) {
    if (marqueeStarted.current) return;   // tail of a marquee drag
    // Click bubbled up from a child (e.g. a clip) — leave selection
    // alone; the clip's own handler owns it. Without this guard, every
    // clip click would clear the selection the clip just set.
    if (!(e.target as HTMLElement).classList.contains('lane-content')) {
      return;
    }
    if (tool !== 'select') return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    clearSelection();
    const rect = v1LaneRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const at = (x / rect.width) * duration;
    // Generate a ghost-clip id; the composer saves with this id so the
    // floating comment renders as a placeholder on V1 + a marker on CMT.
    const ghostClipId = `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    setComposer({ at, trackId: 'v1', ghostClipId, screenX: e.clientX, screenY: e.clientY });
  }

  function clipDoubleClick(clipId: string) {
    const c = timeline?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    if (!c) return;
    // Open composer at the playhead-or-clip-midpoint, attached to this clip.
    const midTime = c.start + ((c.out - c.in) / (c.rate || 1)) / 2;
    // Pin near the timeline header so the dblclick doesn't depend on a fresh mouse pos.
    setComposer({ at: midTime, clipId: c.id, screenX: window.innerWidth / 2 - 140, screenY: 120 });
  }

  return (
    <div className="timeline">
      <div className="tl-head">
        <div className="tl-left">
          <span className="time">{fmt(playhead)}</span>
          <span>/ {fmt(duration)}</span>
          <span>· {timeline.fps} fps</span>
          <button
            onClick={toggleSnap}
            data-tip-below=""
            data-tip="Snap to beat · S"
            style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 'var(--r-full)',
              background: snapEnabled ? 'var(--acc-4)' : 'var(--surf-3)',
              color: snapEnabled ? 'var(--acc-dark)' : 'var(--ink-3)',
              fontWeight: 600, marginLeft: 4,
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}
          >snap</button>
        </div>
        <div className="tl-tools">
          <button className={`tool ${tool === 'select' ? 'on' : ''}`} onClick={() => setTool('select')} data-tip-below="" data-tip="Select · V">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7 18 2.5-8 8-2.5z"/></svg>
          </button>
          <button className={`tool ${tool === 'blade' ? 'on' : ''}`} onClick={() => setTool('blade')} data-tip-below="" data-tip="Razor · C">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 4l-9 9 4 4 9-9z"/><path d="M14 4l6 6"/></svg>
          </button>
          <button className={`tool ${tool === 'slip' ? 'on' : ''}`} onClick={() => setTool('slip')} data-tip-below="" data-tip="Slip · Y">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M5 12l4-4M5 12l4 4M19 12l-4-4M19 12l-4 4"/></svg>
          </button>
          <button className={`tool ${tool === 'ripple' ? 'on' : ''}`} onClick={() => setTool('ripple')} data-tip-below="" data-tip="Ripple · B">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" opacity="0.5"/></svg>
          </button>
          <button className={`tool ${tool === 'comment' ? 'on' : ''}`} onClick={() => setTool('comment')} data-tip-below="" data-tip="Comment · N">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          </button>
          <Mixer />
          <ClipGainPopover />
          <div className="zoom">
            <button className="zoom-btn" onClick={() => zoomTo(pxPerSec / 1.25)} data-tip-below="" data-tip="Zoom out · −">−</button>
            <button className="zoom-btn" onClick={zoomFit} data-tip-below="" data-tip="Fit to width · 0">⊡</button>
            <div className="bar" onClick={(e) => {
              const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              const frac = (e.clientX - r.left) / r.width;
              zoomTo(4 + frac * (400 - 4));
            }}>
              <div className="bar-fill" style={{ width: `${((pxPerSec - 4) / (400 - 4)) * 100}%` }} />
            </div>
            <button className="zoom-btn" onClick={() => zoomTo(pxPerSec * 1.25)} data-tip-below="" data-tip="Zoom in · +">+</button>
          </div>
        </div>
      </div>

      <div className="timeline-scroll" ref={scrollRef} onWheel={(e) => {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          zoomTo(pxPerSec * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        }
      }}>
      <div className="lanes" style={{ marginLeft: 42, width: canvasWidthPx }}>
        <div
          className="ruler"
          ref={rulerRef}
          onPointerDown={rulerPointerDown}
          onPointerMove={rulerPointerMove}
          onPointerUp={rulerPointerUp}
          onPointerCancel={rulerPointerUp}
        >
          {ticks.map((t) => (
            <span key={t} className="ruler-tick" style={{ left: `${(t / duration) * 100}%` }}>{fmt(t).slice(0, 5)}</span>
          ))}
          <span className="playhead" style={{ left: `${playheadPct}%` }} />
        </div>
      </div>

      <div
        ref={lanesRef}
        className={`lanes ${dropHover ? 'drop-hover-area' : ''}`}
        style={{ width: canvasWidthPx + 42, position: 'relative' }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPointerDown={onMarqueePointerDown}
        onPointerMove={onMarqueePointerMove}
        onPointerUp={onMarqueePointerUp}
        onPointerCancel={onMarqueePointerUp}
      >
        {marquee && (
          <div
            className="marquee-rect"
            style={{
              left: Math.min(marquee.x0, marquee.x),
              top: Math.min(marquee.y0, marquee.y),
              width: Math.abs(marquee.x - marquee.x0),
              height: Math.abs(marquee.y - marquee.y0),
            }}
          />
        )}
        {/* Library / file drop indicator — full-height vertical line that
            spans every track at the snapped insert point. Distinct from
            per-track .drop-indicator (used for in-timeline clip drags)
            because library drops do a ripple-insert across V + A + CC. */}
        {rippleDropIndicator && (
          <div
            className="drop-indicator drop-indicator-ripple"
            style={{
              left: 42 + (rippleDropIndicator.timeSec / duration) * (canvasWidthPx),
            }}
          />
        )}
        {/* CC lane sits at the very top — captions overlay everything else
            visually, so the lane ordering mirrors the z-stack. Click empty
            space to drop a new row; click an existing row to edit it in the
            captions panel. */}
        <div className="lane lane-cc">
          <button
            className={`lane-label lane-label-btn ${captionsPanelOpen ? 'on' : ''}`}
            onClick={() => setCaptionsPanelOpen(!captionsPanelOpen)}
            title="Captions panel — auto-caption everything + edit default style"
          >CC</button>
          <div
            className="lane-content"
            ref={ccLaneRef}
            onClick={ccLaneClick}
          >
            {timeline.captions?.rows.map((r) => (
              <CaptionBox key={r.id} row={r} duration={duration} laneRef={ccLaneRef} />
            ))}
          </div>
        </div>

        {/* Layer order matches Premiere convention: V2 on top, V1 below.
              A V2 clip overrides V1 at the same time range (see Preview.tsx
              + render-job.ts flattenOverlay). */}
        <div className="lane lane-v2">
          <div className="lane-label">
            V2
            {v2 && (
              <button
                className={`lane-mute-btn ${v2.audioMuted ? 'muted' : ''}`}
                title={v2.audioMuted ? 'V2 audio muted — click to unmute' : 'Mute V2 audio (preview + render)'}
                aria-label={v2.audioMuted ? 'Unmute V2 audio' : 'Mute V2 audio'}
                onClick={(e) => { e.stopPropagation(); toggleVideoTrackMute(v2.id); }}
              >{v2.audioMuted ? '🔇' : '🔊'}</button>
            )}
          </div>
          <div className="lane-content" ref={v2LaneRef} data-vtrack="v2" onClick={(e) => { if ((e.target as HTMLElement).classList.contains('lane-content')) clearSelection(); }}>
            {dropIndicator?.trackId === 'v2' && (
              <div className="drop-indicator" style={{ left: `${(dropIndicator.timeSec / duration) * 100}%` }} />
            )}
            {v2?.clips.map((c) => (
              <VideoClip
                key={c.id}
                clip={c}
                scene={timeline.scenes.find((sc) => sc.id === c.sceneId)}
                duration={duration}
                laneRef={v2LaneRef}
                selected={selectedClipIds.includes(c.id)}
              />
            ))}
          </div>
        </div>

        <div className="lane lane-v1">
          <div className="lane-label">
            V1
            {v1 && (
              <button
                className={`lane-mute-btn ${v1.audioMuted ? 'muted' : ''}`}
                title={v1.audioMuted ? 'V1 audio muted — click to unmute' : 'Mute V1 audio (preview + render)'}
                aria-label={v1.audioMuted ? 'Unmute V1 audio' : 'Mute V1 audio'}
                onClick={(e) => { e.stopPropagation(); toggleVideoTrackMute(v1.id); }}
              >{v1.audioMuted ? '🔇' : '🔊'}</button>
            )}
          </div>
          <div
            className="lane-content"
            ref={v1LaneRef}
            data-vtrack="v1"
            onClick={v1EmptyClick}
          >
            {dropIndicator?.trackId === 'v1' && (
              <div className="drop-indicator" style={{ left: `${(dropIndicator.timeSec / duration) * 100}%` }} />
            )}
            {timeline.downbeats.map((t, i) => (
              <div key={`db${i}`} className="beat down" style={{ left: `${(t / duration) * 100}%` }} />
            ))}
            {timeline.beats.filter(b => !timeline.downbeats.includes(b)).map((t, i) => (
              <div key={`b${i}`} className="beat" style={{ left: `${(t / duration) * 100}%` }} />
            ))}
            {v1?.clips.map((c) => (
              <VideoClip
                key={c.id}
                clip={c}
                scene={timeline.scenes.find((sc) => sc.id === c.sceneId)}
                duration={duration}
                laneRef={v1LaneRef}
                selected={selectedClipIds.includes(c.id)}
                onDoubleClick={() => clipDoubleClick(c.id)}
              />
            ))}
            {/* Ghost-clip placeholders rendered from floatingComments with a ghostClipId */}
            {floating.filter(fc => fc.ghostClipId && fc.trackId === 'v1' && !fc.resolved).map((fc) => (
              <div
                key={fc.id}
                className="clip video pending ghost-clip"
                style={{ left: `${(fc.at / duration) * 100}%`, width: `8%` }}
                title={fc.note}
              >
                <span className="clip-label">{fc.note.slice(0, 24) || 'Ghost clip'}</span>
                <span className="clip-sub">awaiting agent</span>
              </div>
            ))}
          </div>
        </div>

        {/* Dynamic audio lanes — one row per AudioTrack in timeline order.
            Lane label = track.label if set, else "A{index+1}". Click empty
            space to drop a generated SFX placeholder at the click point.
            Double-click the label to rename the track. */}
        {timeline.audioTracks.map((track, idx) => (
          <AudioLane
            key={track.id}
            track={track}
            index={idx}
            duration={duration}
            audioComposer={audioComposer}
            setAudioComposer={setAudioComposer}
          />
        ))}

        <div className="lane lane-cmt">
          <div className="lane-label">Cmt</div>
          <div className="lane-content" ref={cmtLaneRef} onClick={cmtLaneClick}>
            {/* Floating comments */}
            {floating.map((fc) => (
              <CommentMarker
                key={fc.id}
                id={fc.id}
                note={fc.note}
                author={fc.author}
                resolved={fc.resolved}
                agentReply={fc.agentReply}
                leftPct={(fc.at / duration) * 100}
                kind={fc.ghostClipId ? 'ghost' : 'floating'}
              />
            ))}
            {/* Clip-attached comments */}
            {timeline.tracks.flatMap((tr) => tr.clips.flatMap((c) =>
              (c.comments ?? []).map((cm) => ({ ...cm, clipStart: c.start, clipDur: (c.out - c.in) / (c.rate || 1) }))
            )).map((cm) => (
              <CommentMarker
                key={cm.id}
                id={cm.id}
                note={cm.note}
                author={(cm.author ?? 'user') as 'user' | 'agent'}
                resolved={cm.resolved}
                agentReply={cm.agentReply ?? null}
                leftPct={((cm.clipStart + cm.at) / duration) * 100}
                kind="clip"
              />
            ))}
            {composer && (
              <CommentComposer
                at={composer.at}
                clipId={composer.clipId}
                trackId={composer.trackId}
                ghostClipId={composer.ghostClipId}
                screenX={composer.screenX}
                screenY={composer.screenY}
                onClose={() => setComposer(null)}
              />
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

/**
 * Probe an asset's duration via a hidden HTMLMediaElement. Used when the
 * user drops a Library ref onto the timeline — the file is already on
 * disk (no upload needed), we just need to know how long it is so the
 * new clip's `out` lands correctly. Falls back to 5s on any failure so
 * the drop still produces something the user can fix manually.
 */
function probeMediaDuration(rel: string, kind: 'video' | 'audio'): Promise<number> {
  return new Promise((resolve) => {
    const url = '/asset/' + rel.replace(/^assets\//, '');
    const el = kind === 'video' ? document.createElement('video') : document.createElement('audio');
    el.preload = 'metadata';
    const finish = (d: number) => { try { el.src = ''; } catch {} resolve(d > 0 && isFinite(d) ? d : 5); };
    el.onloadedmetadata = () => finish(el.duration);
    el.onerror = () => finish(0);
    el.src = url;
    // Safety timeout so a broken file doesn't hang the drop forever.
    setTimeout(() => finish(el.duration), 4000);
  });
}

/**
 * Dynamic audio lane — one rendered row per AudioTrack. Label is the
 * user-set name or the canonical "A{index+1}" fallback; double-clicking
 * the label opens an inline rename input. Click empty space inside the
 * lane to drop an SFX generation placeholder at the click point.
 */
function AudioLane({ track, index, duration, audioComposer, setAudioComposer }: {
  track: AudioTrack;
  index: number;
  duration: number;
  audioComposer: { kind: 'sfx' | 'music'; at: number; durationSec?: number; screenX: number; screenY: number; targetTrackId?: string } | null;
  setAudioComposer: (s: any) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const setAudioTrackLabel = useStore((s) => s.setAudioTrackLabel);
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(track.label ?? '');

  const fallbackLabel = `A${index + 1}`;
  const displayLabel = track.label && track.label.trim() ? track.label : fallbackLabel;

  function onLaneClick(e: React.MouseEvent) {
    if (!(e.target as HTMLElement).classList.contains('lane-content')) return;
    const rect = laneRef.current!.getBoundingClientRect();
    const at = ((e.clientX - rect.left) / rect.width) * duration;
    setAudioComposer({ kind: 'sfx', at, screenX: e.clientX, screenY: e.clientY, targetTrackId: track.id });
  }

  function commitLabel() {
    const trimmed = draftLabel.trim();
    setAudioTrackLabel(track.id, trimmed.length === 0 ? null : trimmed);
    setEditing(false);
  }

  return (
    <div className="lane lane-audio">
      {editing ? (
        <input
          className="lane-label lane-label-input"
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLabel();
            else if (e.key === 'Escape') { setDraftLabel(track.label ?? ''); setEditing(false); }
          }}
          autoFocus
          placeholder={fallbackLabel}
        />
      ) : (
        <button
          className="lane-label lane-label-btn"
          onDoubleClick={() => { setDraftLabel(track.label ?? ''); setEditing(true); }}
          title={`Audio track ${track.id} — double-click to rename`}
        >{displayLabel}</button>
      )}
      <div className="lane-content" ref={laneRef} data-track={track.id} onClick={onLaneClick}>
        {track.clips.map((c) => (
          <AudioClipBox
            key={c.id}
            kind={c.kind === 'music' ? 'music' : 'sfx'}
            clip={c as any}
            src={c.kind === 'music' ? c.src : undefined}
            duration={duration}
            laneRef={laneRef}
          />
        ))}
        {audioComposer?.kind === 'sfx' && audioComposer.targetTrackId === track.id && (
          <AudioGenComposer {...audioComposer} onClose={() => setAudioComposer(null)} />
        )}
      </div>
    </div>
  );
}
