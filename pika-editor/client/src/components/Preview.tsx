import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { aspectRatio } from '../types';
import type { CaptionRow, CaptionStyle } from '../types';
import { audio } from '../audio';
import { collectVideoEdges } from '../hotkeys';
import { effectiveDuration } from '../edit';

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function Preview() {
  const timeline = useStore((s) => s.timeline);
  const playhead = useStore((s) => s.playhead);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const togglePlay = useStore((s) => s.togglePlay);
  const playing = useStore((s) => s.playing);

  // RAF-driven playhead while playing. Doesn't try to be sample-accurate to
  // the <video> — the Web Audio engine handles music+SFX timing with proper
  // scheduling, and the video element catches up via seek-when-out-of-sync.
  //
  // CRITICAL: gate the RAF + video.play() on audio.play() resolving. On the
  // first play after refresh, audio buffers may still be decoding (audio
  // pre-warm runs from applyServerTimeline, but the user can hit play
  // before it finishes). If we let the video and RAF run while
  // decodeAudioData is still going, the playhead advances by the load
  // duration before audio is even scheduled — that's the "video starts but
  // audio is delayed / out of sync until you stop and replay" bug.
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  const [audioReady, setAudioReady] = useState(false);
  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      audio.stop();
      setAudioReady(false);
      return;
    }
    let cancelled = false;
    const tl = useStore.getState().timeline;
    const fromPh = useStore.getState().playhead;
    setAudioReady(false);
    (async () => {
      if (tl) { await audio.play(tl as any, fromPh); }
      if (cancelled) return;
      // Anchor the tick clock AFTER audio is scheduled so the playhead
      // doesn't jump forward by the load duration. The video element's
      // own play() is gated below in the seek effect on audioReady.
      lastTickRef.current = performance.now();
      setAudioReady(true);
      const tick = (now: number) => {
        const dt = (now - lastTickRef.current) / 1000;
        lastTickRef.current = now;
        const ph = useStore.getState().playhead;
        const tl = useStore.getState().timeline;
        const dur = tl ? effectiveDuration(tl) : 0;
        const next = ph + dt;
        if (next >= dur) {
          useStore.getState().togglePlay();
          useStore.getState().setPlayhead(dur);
          return;
        }
        useStore.getState().setPlayhead(next);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    })();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      audio.stop();
    };
  }, [playing]);

  if (!timeline) return null;

  const v1 = timeline.tracks.find((t) => t.kind === 'video');
  const v2 = timeline.tracks.find((t) => t.kind === 'overlay');
  const hasAnyClips = (v1?.clips.length ?? 0) > 0 || (v2?.clips.length ?? 0) > 0;
  // Layer priority: V2 wins over V1 wherever it has coverage at the
  // playhead. Mirrors the timeline UI's stacking order (V2 above V1).
  const v2Active = v2?.clips.find((c) => {
    const dur = (c.out - c.in) / (c.rate || 1);
    return playhead >= c.start && playhead < c.start + dur;
  });
  const v1Active = v1?.clips.find((c) => {
    const dur = (c.out - c.in) / (c.rate || 1);
    return playhead >= c.start && playhead < c.start + dur;
  });
  // STRICT: the preview shows only what the playhead is over. No fallback to
  // "first clip" or "selected clip" — the user explicitly reported that
  // those fallbacks made the preview flash through unrelated frames when
  // scrubbing across empty regions. The expected behaviour is "no clip
  // here → blank preview", which matches every other timeline editor.
  //
  // Overlay handling: image-overlay scenes don't replace the video
  // underneath — they composite WITH alpha on top. So we resolve TWO
  // things separately:
  //   • BASE = the topmost VIDEO clip at the playhead (image-overlay
  //     clips are skipped for this purpose). This drives the <video>.
  //   • OVERLAY = the topmost IMAGE-OVERLAY clip at the playhead, if
  //     any. This drives an <img> layered above the <video>.
  // Both V1 and V2 are scanned; v2 wins if both are video clips (V2
  // carves V1 — existing behaviour preserved).
  const v2IsOverlay = v2Active
    && timeline.scenes.find((sc) => sc.id === v2Active.sceneId)?.kind === 'image-overlay';
  const v1IsOverlay = v1Active
    && timeline.scenes.find((sc) => sc.id === v1Active.sceneId)?.kind === 'image-overlay';
  const baseVideoClip = (v2Active && !v2IsOverlay) ? v2Active : (v1Active && !v1IsOverlay) ? v1Active : undefined;
  const overlayClip = v2IsOverlay ? v2Active : v1IsOverlay ? v1Active : undefined;
  const activeClip = baseVideoClip;
  const activeScene = activeClip ? timeline.scenes.find((sc) => sc.id === activeClip.sceneId) : undefined;
  const overlayScene = overlayClip
    ? timeline.scenes.find((sc) => sc.id === overlayClip.sceneId)
    : undefined;
  const overlayImageScene = overlayScene?.kind === 'image-overlay' ? overlayScene : undefined;
  const showPlaceholder = !activeClip
    || !activeScene
    || (activeScene.kind === 'pika-gen' && !activeScene.videoSrc)
    // An image-overlay scene as the BASE (e.g. PNG dropped on V1 with no
    // V2 video underneath) has no `<video>` source — fall through to the
    // placeholder. The overlay `<img>` layer is still rendered above, so
    // the user sees the image floating on the placeholder background.
    || activeScene.kind === 'image-overlay';

  // Seek the <video> when playhead changes (while paused) — keeps the preview
  // frame in sync with timeline scrubs. While playing the RAF loop advances
  // playhead, and the video stays in sync via the same seek logic.
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!activeClip || !activeScene || showPlaceholder) return;
    const v = videoRef.current; if (!v) return;
    const localT = (playhead - activeClip.start) * (activeClip.rate || 1) + activeClip.in;
    // Threshold + gating rules — designed to keep playback smooth across
    // clip boundaries that require non-trivial seeks in the source file
    // (e.g. blade+trim that leaves a gap in source-time between two
    // adjacent timeline clips):
    //
    // 1) `!v.seeking`: never restart a seek that's already in flight.
    //    Each new `v.currentTime=` write ABORTS the previous seek; at
    //    60fps that means the seek never completes, leaving the video
    //    freeze-framed on the previous clip's last decoded frame.
    //
    // 2) Loose `playing` threshold (0.5s) vs tight paused threshold
    //    (0.08s). While playing, v.play() drives v.currentTime forward
    //    at 1x naturally — small drift (<0.5s) between our computed
    //    localT and v.currentTime is EXPECTED (decoder latency, seek
    //    duration baked into the lag, audio-ctx vs RAF clock jitter)
    //    and correcting it on every RAF tick puts us into a "seek →
    //    land → seek → land" loop that's CHOPPY for the entire clip.
    //    The main effect only intervenes for genuine discontinuities
    //    (clip-boundary source jumps, user scrub-during-play); within
    //    a single clip during steady playback, the video element
    //    handles itself.
    //
    //    Trade-off: when a discontinuous boundary fires its one big
    //    seek (e.g. 200-500ms in-source jump from a blade+trim),
    //    audio briefly leads video by the seek duration. Lag stays
    //    constant after that — both v.currentTime and the audio clock
    //    advance at 1x. True lag elimination needs double-buffered
    //    video elements; left as a follow-up.
    //
    //    When paused, a tight threshold keeps scrubs responsive.
    const threshold = playing ? 0.5 : 0.08;
    if (Math.abs(v.currentTime - localT) > threshold && !v.seeking) {
      try { v.currentTime = Math.max(0, localT); } catch {}
    }
    // Per-clip embedded-audio gain (V clip's `gain` field, dB). Only
    // applied when the V clip has no linkId (its audio plays from the
    // <video>; if linked, audio lives on the A-clip). Convert dB → 0..1
    // amplitude: 10^(dB/20), clamped to [0, 1]. Default 0 dB = 1.0.
    const embeddedGainDb = (!activeClip.linkId ? (activeClip as any).gain : undefined) as number | undefined;
    if (typeof embeddedGainDb === 'number') {
      const amp = Math.max(0, Math.min(1, Math.pow(10, embeddedGainDb / 20)));
      if (Math.abs(v.volume - amp) > 0.01) v.volume = amp;
    } else if (Math.abs(v.volume - 1) > 0.01) {
      v.volume = 1;
    }
    // Only start the <video> once audio has actually been scheduled, so on
    // the first play after refresh we don't race ahead while music + SFX
    // are still decoding. Scrubs while paused still update v.currentTime
    // above — the gate only blocks play().
    if (playing && audioReady) { void v.play().catch(() => {}); } else { v.pause(); }
  }, [playhead, playing, audioReady, activeClip, activeScene, showPlaceholder]);

  // No corrective seeked handler. An earlier version snapped
  // v.currentTime to current localT once the post-boundary seek
  // landed, hoping to zero out the ~200ms audio/video lag the seek
  // duration introduces. But each corrective snap kicks off ANOTHER
  // seek; if in-buffer seeks take >50ms (common during active
  // playback), the seeked event re-fires before drift converges, and
  // we end up in a perpetual snap loop that feels like choppy
  // playback for the entire clip. Trade-off chosen: accept the
  // one-time ~200ms lag after a discontinuous boundary seek (audio
  // briefly leads video) in exchange for genuinely smooth playback.
  // True lag elimination needs double-buffered video elements
  // (preload the next clip into a second <video> and swap at the
  // boundary) — much bigger change; left as a follow-up if the lag
  // is perceptible enough to warrant it.

  const ar = aspectRatio(timeline.aspect);

  // Fit-into-row sizing — JS-driven because CSS aspect-ratio is
  // ignored when flex/grid has resolved BOTH dims. Read row, compute
  // largest aspect-preserving box, set inline px on the card.
  const selectedCaptionId = useStore((s) => s.selectedCaptionId);
  const captionsPanelOpen = useStore((s) => s.captionsPanelOpen);
  const showCap = !!selectedCaptionId || captionsPanelOpen;
  const cardElRef = useRef<HTMLDivElement | null>(null);
  const [cardSize, setCardSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const card = cardElRef.current;
    if (!card) {
      console.warn('[preview-fit] card ref not attached');
      return;
    }
    const row = card.closest('.stage-preview-row') as HTMLElement | null;
    if (!row) {
      console.warn('[preview-fit] could not find .stage-preview-row parent');
      return;
    }
    let cancelled = false;
    let retries = 0;
    const stage = row.closest('.stage') as HTMLElement | null;
    const fit = (): void => {
      if (cancelled) return;
      const rect = row.getBoundingClientRect();
      const W = row.clientWidth;
      const H = row.clientHeight;
      const oh = row.offsetHeight;
      const stageH = stage?.clientHeight ?? -1;
      const stageRect = stage?.getBoundingClientRect();
      const capSibling = row.querySelector(':scope > .cap-panel') as HTMLElement | null;
      const capW = capSibling ? capSibling.clientWidth + 12 : 0;
      const availW = Math.max(0, W - capW);
      if (retries < 3) {
        console.log('[preview-fit]', {
          rowW: W, rowH: H, rowOffsetH: oh, rowRectH: rect.height,
          stageH, stageRectH: stageRect?.height,
          rowDisplay: getComputedStyle(row).display,
          rowGridRow: getComputedStyle(row).gridRow,
          availW, ar,
        });
      }
      retries++;
      if (availW <= 0 || H <= 0) {
        if (retries < 60) requestAnimationFrame(fit);
        return;
      }
      let w = availW;
      let h = w / ar;
      if (h > H) { h = H; w = h * ar; }
      setCardSize({ w: Math.floor(w), h: Math.floor(h) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(row);
    return () => { cancelled = true; ro.disconnect(); };
  }, [ar, showCap]);

  // Active caption row at the playhead. Captions live in their own track on
  // timeline.captions and are rendered live as an HTML overlay so the user
  // can style them freely without re-rendering the video. Burn-in happens
  // at render time via ffmpeg subtitles= (step 5).
  const captions = timeline.captions;
  const activeCaption = captions?.enabled
    ? captions.rows.find((r) => playhead >= r.start && playhead < r.end)
    : undefined;

  return (
    <div
      className="preview-card"
      ref={cardElRef}
      style={cardSize
        ? { width: cardSize.w, height: cardSize.h }
        : { width: '100%', height: '100%' }}
    >
      <div className="preview-content">
        {!hasAnyClips ? (
          <div className="preview-empty">
            <div className="preview-empty-title">Pick a model to start</div>
            <div className="preview-empty-sub">Choose a generator on the left, write a prompt, and drop a clip on V1.</div>
          </div>
        ) : showPlaceholder ? (
          // Only show the "Generating…" spinner when there's actually a
          // pika-gen scene at the playhead that hasn't landed yet. Empty
          // gap on V1 (no clip under the playhead) used to render the
          // same spinner, which read as "still working" forever even
          // though nothing was. Empty gap → empty preview; gen in
          // flight → spinner.
          activeScene?.kind === 'pika-gen' && !activeScene.videoSrc ? (
            <div className="preview-empty">
              <div className="spin" style={{ position: 'static', borderColor: 'rgba(255,255,255,0.6)', borderTopColor: 'transparent', width: 28, height: 28, marginBottom: 14 }} />
              <div className="preview-empty-title">Generating…</div>
              <div className="preview-empty-sub">{(activeScene as any).prompt?.slice(0, 80) ?? ''}</div>
            </div>
          ) : (
            <div className="preview-empty" />
          )
        ) : (
          <video
            ref={videoRef}
            // Intentionally NO `key` on this element. Previously we keyed
            // by activeScene.videoSrc — which forced React to UNMOUNT
            // and re-mount the entire <video> every time the playhead
            // crossed a clip boundary. Browser tore down the decoder
            // and re-initialized for each new file, producing the 100–
            // 500ms black-frame stutter that gets WORSE the longer the
            // project (more clips = more transitions). Same element +
            // updated src lets the browser keep the decoder warm.
            src={`/asset/${activeScene!.videoSrc!.replace(/^assets\//, '')}`}
            // Eager preload so the browser fetches metadata + initial
            // frames as soon as the src attribute changes, instead of
            // waiting for play() to nudge it.
            preload="auto"
            // Mute when ANY of these is true:
            //   (a) the active V clip has a linkId — its audio was
            //       extracted to an A-lane clip, so the embedded track
            //       should never play (even if the A-clip was deleted).
            //   (b) the track this clip lives on has audioMuted=true —
            //       the user toggled the per-track mute icon in the
            //       lane header. Affects render too (see render-job.ts).
            muted={
              !!activeClip?.linkId ||
              !!timeline.tracks.find((t) => t.id === activeClip?.trackId)?.audioMuted
            }
            playsInline
          />
        )}
        {overlayImageScene && (
          // Static-image overlay layer. Sits on top of <video> with the
          // same dimensions, using object-fit: contain to honor the
          // image's aspect ratio. Pointer-events off so the user can
          // still scrub via the transport beneath. Matches the renderer's
          // overlay pass (scale + pad + alpha).
          <img
            className="preview-overlay-img"
            src={`/asset/${overlayImageScene.imageSrc.replace(/^assets\//, '')}`}
            alt={overlayImageScene.labels?.[0] ?? 'overlay'}
          />
        )}
        {activeCaption && <CaptionOverlay row={activeCaption} defaults={captions.defaultStyle} />}
      </div>
      <div className="preview-overlay">
        <div className="top">
          {hasAnyClips && (
            <span className="preview-tag">
              {activeScene ? `${activeScene.labels?.[0] ?? activeScene.id}` : 'No scene'}
            </span>
          )}
          {!hasAnyClips && <span />}
          <span className="preview-time">
            {formatTime(playhead)} / {formatTime(effectiveDuration(timeline))}
          </span>
        </div>
        {/* Hide the transport while the caption panel is open — the
         *  play/back/forward buttons sit at the bottom-center of the
         *  preview and were covering the caption text the user is
         *  actively styling. Space + ↑/↓ hotkeys still work, so the
         *  user can scrub without the on-screen affordance. */}
        <div className="transport" style={showCap ? { display: 'none' } : undefined}>
          <button
            title="Previous cut (↑)"
            onClick={() => {
              const edges = collectVideoEdges(timeline);
              const EPS = 0.001;
              const prev = [...edges].reverse().find((x) => x < playhead - EPS);
              if (prev !== undefined) setPlayhead(prev);
            }}
          >⏮</button>
          <button className="play" onClick={togglePlay} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button
            title="Next cut (↓)"
            onClick={() => {
              const edges = collectVideoEdges(timeline);
              const EPS = 0.001;
              const next = edges.find((x) => x > playhead + EPS);
              if (next !== undefined) setPlayhead(next);
            }}
          >⏭</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Live caption overlay rendered above the <video>. Style fields are
 * authored against a 1080-pixel reference height; we scale font + padding
 * to the rendered preview height so a 36px caption looks the same at
 * 720p / 1080p / 4K. Burn-in at render time (step 5) uses the same numbers
 * against the actual output resolution.
 */
/**
 * Both ASS `Fontsize` (libass via FreeType) and CSS `font-size` map to the
 * EM height in pixels. At PlayResY=1080 and matching CSS scale, the same
 * numeric `size` value renders glyphs with the same EM, so no multiplier
 * is needed. (Earlier this code applied 1.4× believing ASS Fontsize was
 * cap-height-in-pixels — empirically wrong, the preview rendered ~40%
 * larger than the burn-in.) Kept as a named constant so future fine-tuning
 * for specific fonts is a single-line change.
 */
const CAP_PREVIEW_BUMP = 1.0;

function CaptionOverlay({ row, defaults }: { row: CaptionRow; defaults: CaptionStyle }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  // Snap state — when the drag is currently locked to the canvas center,
  // we render a magenta Figma-style guide line on that axis. Cleared on
  // pointer-up.
  const [snapGuide, setSnapGuide] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const selectedCaptionId = useStore((s) => s.selectedCaptionId);
  const selectCaption = useStore((s) => s.selectCaption);
  const setCaptionsDefaultStyle = useStore((s) => s.setCaptionsDefaultStyle);
  const isSelected = selectedCaptionId === row.id;

  useEffect(() => {
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    const update = () => setScale(el.clientHeight / 1080);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const style: CaptionStyle = { ...defaults, ...(row.style ?? {}) };
  // Trim whitespace from each line. The inline-block wrap is content-sized
  // and `white-space: pre-wrap` preserves whitespace, so trailing spaces in
  // a Whisper-aligned row (common — the token aligner appends spaces after
  // each word) would (a) make the box wider than the visible text and (b)
  // push the text leftward under `text-align: center` because the centering
  // includes the trailing whitespace. Per-line trim keeps explicit newlines
  // for multi-line captions while killing the invisible-space drift.
  const rawText = style.textCase === 'caps' ? row.text.toUpperCase() : row.text;
  const text = rawText.split('\n').map((ln) => ln.trim()).join('\n');

  // Drag-to-position writes to the TRACK default — every row that doesn't
  // already have a per-row xPct/yPct override moves together (CapCut "global
  // subtitle position" semantics). Per-row deviation lives in the panel's
  // X%/Y% inputs. baseX/baseY come from the dragged row's effective style
  // so the drag picks up where you see the caption, not where the default
  // happens to be.
  const dragState = useRef<{ startX: number; startY: number; baseX: number; baseY: number; canvasW: number; canvasH: number } | null>(null);
  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    if (!isSelected) {
      // First click selects; user can drag right after on the second hold.
      selectCaption(row.id);
      return;
    }
    const canvas = wrapRef.current?.parentElement;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: style.xPct,
      baseY: style.yPct,
      canvasW: r.width,
      canvasH: r.height,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  }
  // Figma-style snap-to-center. SNAP_THRESHOLD is in percent of canvas —
  // anything within this distance of 50% gets pulled to 50 exactly and we
  // render a guide line. Picked at 1.5% — tight enough that you can place
  // off-center deliberately, loose enough that "near center" feels magnetic.
  const SNAP_THRESHOLD = 1.5;
  function onPointerMove(e: React.PointerEvent) {
    const d = dragState.current;
    if (!d) return;
    const dx = ((e.clientX - d.startX) / d.canvasW) * 100;
    const dy = ((e.clientY - d.startY) / d.canvasH) * 100;
    let xPct = Math.max(0, Math.min(100, d.baseX + dx));
    let yPct = Math.max(0, Math.min(100, d.baseY + dy));
    const snapX = Math.abs(xPct - 50) < SNAP_THRESHOLD;
    const snapY = Math.abs(yPct - 50) < SNAP_THRESHOLD;
    if (snapX) xPct = 50;
    if (snapY) yPct = 50;
    setSnapGuide({ x: snapX, y: snapY });
    setCaptionsDefaultStyle({ xPct, yPct });
  }
  function onPointerUp(e: React.PointerEvent) {
    if (!dragState.current) return;
    dragState.current = null;
    setSnapGuide({ x: false, y: false });
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  }

  const sh = style.shadow;
  const ol = style.outline;
  // CSS textShadow stacks two effects: outline (4 directional offsets at the
  // outline color) + shadow (single dx/dy with blur). We build only the
  // parts the user enabled so disabled effects leave no trace.
  const shadowParts: string[] = [];
  if (ol.enabled && ol.width > 0) {
    const w = ol.width * scale;
    shadowParts.push(`${w}px 0 0 ${ol.color}`, `-${w}px 0 0 ${ol.color}`, `0 ${w}px 0 ${ol.color}`, `0 -${w}px 0 ${ol.color}`);
  }
  if (sh.enabled) {
    shadowParts.push(`${sh.dx * scale}px ${sh.dy * scale}px ${sh.blur * scale}px ${sh.color}`);
  }
  const textShadow = shadowParts.length ? shadowParts.join(', ') : undefined;

  // Center-snap guides — rendered as siblings to the wrap so they sit on
  // the same coordinate system (the preview canvas).
  const guides = (snapGuide.x || snapGuide.y) ? (
    <>
      {snapGuide.x && <div className="caption-snap-guide vertical" />}
      {snapGuide.y && <div className="caption-snap-guide horizontal" />}
    </>
  ) : null;

  // Align determines which edge of the wrap snaps to the xPct anchor:
  //  - center → wrap's center at xPct (default)
  //  - left   → wrap's LEFT edge at xPct (text reads left-to-right from there)
  //  - right  → wrap's RIGHT edge at xPct
  // Without this, a tight-wrapping inline-block hides the alignment because
  // text-align inside a content-sized box looks identical for left/center/right.
  const xTranslate = style.align === 'left' ? '0' : style.align === 'right' ? '-100%' : '-50%';
  return (
    <>
      {guides}
      <div
        ref={wrapRef}
        className={`caption-overlay-wrap free ${isSelected ? 'selected' : ''}`}
        style={{
          left: `${style.xPct}%`,
          top: `${style.yPct}%`,
          transform: `translate(${xTranslate}, -50%)`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
      <span
        className="caption-overlay-text"
        style={{
          fontFamily: style.font,
          fontSize: `${style.size * scale * CAP_PREVIEW_BUMP}px`,
          fontWeight: style.weight,
          color: style.color,
          background: style.bgEnabled ? (style.bg || 'transparent') : 'transparent',
          padding: style.bgEnabled
            ? `${style.padY * scale * CAP_PREVIEW_BUMP}px ${style.padX * scale * CAP_PREVIEW_BUMP}px`
            : 0,
          borderRadius: style.bgEnabled
            ? `${(style.padY + style.size * 0.5) * scale * CAP_PREVIEW_BUMP * style.radius}px`
            : 0,
          lineHeight: 1.18,
          textShadow,
          textAlign: style.align,
        }}
      >{text}</span>
    </div>
    </>
  );
}
