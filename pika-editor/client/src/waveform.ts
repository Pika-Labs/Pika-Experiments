/**
 * Peak extraction for audio waveform rendering. Reuses the AudioEngine's
 * decoded buffer cache so we never re-fetch + re-decode a file we're already
 * about to play.
 *
 * For each bucket we record (max, min) and, alongside the per-bucket pair,
 * a single per-buffer normalization factor so the renderer can scale to a
 * standard ±1 amplitude regardless of the source's actual peak loudness.
 * Quiet tracks become visible; clipped tracks don't smash the gutters.
 *
 * Channels are summed and averaged (mono mix) rather than reading just
 * channel 0 — hard-panned content was previously showing as silence on the
 * "wrong" half, which made the music waveform look broken.
 */
import { audio } from './audio';

export interface Peak { max: number; min: number }
export interface PeakSet {
  peaks: Peak[];
  /** 1 / max(|sample|). Multiply peak.max / peak.min by this to fit ±1. */
  normScale: number;
}

const cache = new Map<string, PeakSet>();
const pending = new Map<string, Promise<PeakSet>>();

// 600 buckets gives sub-second detail even on 5-minute tracks while staying
// cheap to draw as an SVG path. 200 (the old value) smeared long music into
// a uniform block.
const BUCKETS = 600;

export async function getPeaks(rel: string): Promise<PeakSet> {
  if (cache.has(rel)) return cache.get(rel)!;
  if (pending.has(rel)) return pending.get(rel)!;
  const p = (async () => {
    const buf = await audio.load(rel);
    const nCh = buf.numberOfChannels;
    const len = buf.length;
    const channels: Float32Array[] = [];
    for (let c = 0; c < nCh; c++) channels.push(buf.getChannelData(c));

    const bucketSize = Math.max(1, Math.floor(len / BUCKETS));
    const peaks: Peak[] = new Array(BUCKETS);
    let globalAbs = 0;
    for (let i = 0; i < BUCKETS; i++) {
      let lo = 0, hi = 0;
      const start = i * bucketSize;
      const end = i === BUCKETS - 1 ? len : Math.min(len, start + bucketSize);
      for (let j = start; j < end; j++) {
        // Mono-mix all channels so hard-panned audio still draws as a real
        // waveform instead of one-sided silence.
        let sum = 0;
        for (let c = 0; c < nCh; c++) sum += channels[c][j];
        const v = sum / nCh;
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
      peaks[i] = { max: hi, min: lo };
      const a = Math.max(hi, -lo);
      if (a > globalAbs) globalAbs = a;
    }
    // Avoid div-by-zero on silence; clamp the smallest meaningful peak so a
    // near-silent track doesn't get scaled into noise.
    const normScale = globalAbs > 1e-4 ? 1 / globalAbs : 1;
    const result: PeakSet = { peaks, normScale };
    cache.set(rel, result);
    pending.delete(rel);
    return result;
  })();
  pending.set(rel, p);
  return p;
}
