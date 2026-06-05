/**
 * Scene-cut detection via ffmpeg's built-in `select='gt(scene,N)'` filter.
 *
 * For a multi-shot video (e.g. a 15s Seedance batch covering 3-6 beats),
 * ffmpeg compares each frame to the previous one and flags frames where
 * the "scene change score" exceeds the threshold. The score is a per-frame
 * floating-point value derived from luminance / color histogram diffs;
 * values >0.4 reliably correspond to hard cuts in stylized animation
 * (the typical Seedance output). Soft transitions / motion don't trip it.
 *
 * Output: array of cut timestamps in seconds, relative to the video start.
 * Empty array means single-shot — no cuts to split at.
 *
 * Runtime: ~real-time (15s video → ~1-3s of ffmpeg processing).
 */
import { spawn } from 'node:child_process';

const DEFAULT_THRESHOLD = 0.4;
// Ignore detected cuts within the first / last `EDGE_GUARD` seconds — those
// are usually artifacts of the first frame appearing (no previous frame to
// compare to). And cuts within `MIN_GAP` seconds of each other collapse to
// one — back-to-back near-frame flickers are not real cuts.
const EDGE_GUARD_SEC = 0.15;
const MIN_GAP_SEC = 0.5;

export async function detectSceneCuts(absPath: string, threshold = DEFAULT_THRESHOLD): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', absPath,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-f', 'null',
      '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    proc.on('close', () => {
      // showinfo lines look like:
      //   [Parsed_showinfo_1 @ 0x...] n:0 pts:60 pts_time:2.5 ...
      // Pull every pts_time, dedupe by min-gap, drop edge artifacts.
      const matches = [...stderr.matchAll(/pts_time:([0-9.]+)/g)];
      const raw = matches.map((m) => parseFloat(m[1])).filter((t) => isFinite(t));
      const duration = parseDurationFromStderr(stderr);
      const filtered: number[] = [];
      for (const t of raw) {
        if (t < EDGE_GUARD_SEC) continue;
        if (duration && t > duration - EDGE_GUARD_SEC) continue;
        if (filtered.length > 0 && t - filtered[filtered.length - 1] < MIN_GAP_SEC) continue;
        filtered.push(round3(t));
      }
      resolve(filtered);
    });
    proc.on('error', (err) => reject(err));
  });
}

function parseDurationFromStderr(stderr: string): number | null {
  // ffmpeg prints "Duration: HH:MM:SS.MM" once per input
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
