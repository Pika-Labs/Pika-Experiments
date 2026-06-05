/**
 * Hover-scrub video thumb. Mouse-X across the element sets
 * `currentTime = (x / width) * duration`; idle ≥220ms triggers play;
 * leaving the element pauses + resets to frame 0. Pure passive cinema —
 * no click required, no overlay UI.
 *
 * Used by every place we render a video thumbnail at a glance:
 * History grid, Workspace tile grid, Library reference grid.
 */
import { useRef, useState } from 'react';

export function HoverScrubVideo({ src, className, onMeta }: {
  src: string;
  className?: string;
  /** Fires once intrinsic dims are known (after `loadedmetadata`). Lets
   *  the parent adopt the video's natural aspect so portrait videos
   *  stand tall and landscapes lay short. */
  onMeta?: (width: number, height: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const idleTimer = useRef<number | null>(null);
  // Scrub-position indicator. `scrubFrac` is 0..1 along the X axis;
  // null hides the line (cursor not over the element).
  const [scrubFrac, setScrubFrac] = useState<number | null>(null);

  function clearIdle(): void {
    if (idleTimer.current) { window.clearTimeout(idleTimer.current); idleTimer.current = null; }
  }
  function onMove(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setScrubFrac(frac);
    const v = videoRef.current; if (!v) return;
    if (!isFinite(v.duration) || v.duration <= 0) return;
    v.pause();
    try { v.currentTime = frac * v.duration; } catch {}
    clearIdle();
    idleTimer.current = window.setTimeout(() => { void v.play().catch(() => {}); }, 220);
  }
  function onLeave(): void {
    setScrubFrac(null);
    const v = videoRef.current; if (!v) return;
    clearIdle();
    v.pause();
    try { v.currentTime = 0; } catch {}
  }

  return (
    <div
      className={className ?? 'hover-scrub-video'}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        muted
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (onMeta && v.videoWidth && v.videoHeight) onMeta(v.videoWidth, v.videoHeight);
        }}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      {/* Scrub indicator — a thin lavender vertical line that follows
          the mouse-X. Makes the playhead explicit so the user sees
          *what frame* they're parked on, not just a flicker of video. */}
      {scrubFrac !== null && (
        <div
          className="hover-scrub-line"
          style={{ left: `${scrubFrac * 100}%` }}
          aria-hidden
        />
      )}
    </div>
  );
}
