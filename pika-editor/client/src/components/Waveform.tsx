import { useEffect, useState } from 'react';
import { getPeaks, type PeakSet } from '../waveform';

interface Props {
  src: string;
  color?: string;
  /** Slice the peaks to just the [in,out] window — pass 0..1 for both. */
  inFrac?: number;
  outFrac?: number;
}

/**
 * Bipolar waveform — top edge follows per-bucket max, bottom edge follows
 * per-bucket min, drawn as a single filled SVG path. This is the canonical
 * DAW look (Ableton / Logic / Pro Tools). Old version stacked symmetric
 * rects keyed on (max - min) which always renders ~80% tall for music =
 * uniform brick wall.
 *
 * Heights are normalized by the buffer's own peak so quiet tracks still
 * draw a visible waveform.
 */
export function Waveform({ src, color = 'rgba(255,255,255,0.6)', inFrac = 0, outFrac = 1 }: Props) {
  const [set, setSet] = useState<PeakSet | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPeaks(src).then((s) => { if (!cancelled) setSet(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [src]);

  if (!set) {
    return <div style={{ position: 'absolute', inset: 0, opacity: 0.3, background: 'repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 3px)', color }} />;
  }

  const { peaks, normScale } = set;
  const lo = Math.max(0, Math.floor(inFrac * peaks.length));
  const hi = Math.max(lo + 1, Math.min(peaks.length, Math.floor(outFrac * peaks.length)));
  const slice = peaks.slice(lo, hi);
  const n = slice.length;

  // Render-space coordinates.
  const w = 1000;          // wide viewBox keeps subpixel detail at any size
  const h = 24;
  const mid = h / 2;
  const amp = mid - 0.5;   // leave half a pixel of breathing room at the edges
  const dx = w / n;

  // Bail when there's nothing to draw. Without this, an empty slice
  // produces path="Z" alone (no preceding moveto), which the SVG parser
  // logs as "Expected moveto ('M' or 'm'), 'Z'." spam in the console.
  // Happens transiently while peaks are decoding for a freshly-loaded
  // audio file, or when in/out collapse to a zero-width slice mid-trim.
  if (n === 0) return null;

  // Build a single closed path: trace the top edge (max), then walk the
  // bottom edge (min) back, then close. Filled with currentColor gives the
  // canonical waveform silhouette in one element.
  let path = '';
  for (let i = 0; i < n; i++) {
    const x = i * dx;
    const y = mid - Math.max(0, slice[i].max * normScale) * amp;
    path += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
  }
  for (let i = n - 1; i >= 0; i--) {
    const x = i * dx;
    const y = mid - Math.min(0, slice[i].min * normScale) * amp;
    path += 'L' + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
  }
  path += 'Z';

  return (
    <svg
      className="waveform-svg"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.7 }}
    >
      <path d={path} fill={color} />
    </svg>
  );
}
