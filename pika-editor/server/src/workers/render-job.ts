/**
 * Render pipeline — pure pika-gen / video-import timeline → MP4.
 *
 * Architecture:
 *  1. For each V1 clip, ffmpeg trims its source video by [in, out], scales
 *     to project W×H (cover-fit), applies the clip's rate (setpts/atempo),
 *     and emits a self-contained mp4 segment to renders/segments/.
 *     Segments are cached by content hash so re-renders only re-cut what
 *     changed.
 *  2. ffmpeg concat-demuxer joins all V1 segments end-to-end. Gaps on V1
 *     are filled with black silence segments of the right duration.
 *  3. Audio mix: music track (single src, trimmed per-clip, gain + fades)
 *     and SFX clips, summed with amix, ducked under nothing for v1.
 *  4. Final mux: combine the concatenated video stream with the mixed audio,
 *     output to renders/jobs/{jobId}.mp4.
 *
 * Limitations (v1):
 *  - Single V1 track only (V2 overlay is read but rendered as a future pass)
 *  - No greenscreen / mixed-base composites (PikaCut-only)
 *  - No crossfades between clips on V1
 *  - Music: single layer, supports the per-clip trim/gain/fade
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, createWriteStream, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { paths } from '../state.js';
import { events } from '../events.js';
import { resolveDimensions, type Timeline, type Clip, type Scene, type Aspect, type Resolution, type Captions, type CaptionStyle } from '../schema.js';

/**
 * One renderable video segment in master time. V1 clips that are partially
 * covered by V2 get split into multiple FlatSegs; V2 clips appear at their
 * native ranges. fadeIn/fadeOut are carried only by the *original* clip's
 * head/tail piece — interior pieces of a carved V1 clip should not fade.
 */
interface FlatSeg {
  clipId: string;
  sceneId: string;
  trackId: string;         // source video track id — used to honor the
                           // per-track audioMuted flag in the audio mix
                           // (skip this segment's embedded audio if the
                           // user toggled mute on its lane header).
  start: number;   // master time, seconds
  end: number;     // master time, seconds
  in: number;      // source time, seconds
  out: number;     // source time, seconds
  rate: number;
  fadeIn: number;
  fadeOut: number;
  linkId: string | null;   // when set, the V clip has a linked A-lane
                           // sibling; audio comes from there, NOT from
                           // the source video's embedded track
  gainDb: number;          // per-clip embedded-audio gain (dB). 0 = unchanged.
                           // Only applied on the embedded-audio path (i.e.
                           // when linkId is null and the source has audio).
}

function clipMasterEnd(c: Clip): number {
  return c.start + (c.out - c.in) / (c.rate || 1);
}

/**
 * Build the flat segment list by stacking N video tracks. Later array
 * index = on top (matches Premiere's V1/V2/V3 convention, where Vn
 * obscures everything below). Top-down carve: every track's clips knock
 * out the matching time ranges from all tracks below.
 *
 * Algorithm: iterate tracks from top to bottom. Each track contributes its
 * clips intact at their native time ranges. For every track below the
 * current one, carve out any portion that overlaps a higher-track clip.
 * Fades only apply where a piece still owns the head/tail of the original.
 */
function flattenStack(tracks: Clip[][]): FlatSeg[] {
  type Piece = { ref: Clip; mStart: number; mEnd: number; sIn: number; sOut: number; hasHead: boolean; hasTail: boolean };
  // Per-track piece lists. Build top-down: top track keeps its clips
  // unmodified, each lower track gets carved by the union of all higher
  // tracks' time ranges. Single pass per track using the cumulative
  // "blocker" ranges so far.
  const blockers: { start: number; end: number }[] = [];
  // Accumulate pieces in track order (top → bottom).
  const allPieces: Piece[] = [];

  for (const trackClips of tracks) {
    const newBlockers: { start: number; end: number }[] = [];
    for (const c of trackClips) {
      const cEnd = clipMasterEnd(c);
      newBlockers.push({ start: c.start, end: cEnd });
      let pieces: Piece[] = [{
        ref: c, mStart: c.start, mEnd: cEnd, sIn: c.in, sOut: c.out, hasHead: true, hasTail: true,
      }];
      // Carve this clip's pieces against every higher-track range collected so far.
      for (const b of blockers) {
        if (b.end <= c.start || b.start >= cEnd) continue;
        pieces = pieces.flatMap((p) => {
          if (b.start >= p.mEnd || b.end <= p.mStart) return [p];
          const next: Piece[] = [];
          if (b.start > p.mStart) {
            const dur = b.start - p.mStart;
            next.push({
              ref: p.ref, mStart: p.mStart, mEnd: b.start,
              sIn: p.sIn, sOut: p.sIn + dur * (p.ref.rate || 1),
              hasHead: p.hasHead, hasTail: false,
            });
          }
          if (b.end < p.mEnd) {
            const skipDur = b.end - p.mStart;
            next.push({
              ref: p.ref, mStart: b.end, mEnd: p.mEnd,
              sIn: p.sIn + skipDur * (p.ref.rate || 1), sOut: p.sOut,
              hasHead: false, hasTail: p.hasTail,
            });
          }
          return next;
        });
      }
      allPieces.push(...pieces);
    }
    blockers.push(...newBlockers);
  }

  return allPieces
    .map((p) => ({
      clipId: p.ref.id,
      sceneId: p.ref.sceneId,
      trackId: p.ref.trackId,
      start: p.mStart, end: p.mEnd,
      in: p.sIn, out: p.sOut,
      rate: p.ref.rate,
      fadeIn: p.hasHead ? p.ref.fadeIn : 0,
      fadeOut: p.hasTail ? p.ref.fadeOut : 0,
      linkId: p.ref.linkId ?? null,
      gainDb: (p.ref as { gain?: number }).gain ?? 0,
    }))
    .sort((a, b) => a.start - b.start);
}

const PRESETS = {
  draft:    { crf: 23, preset: 'ultrafast' },
  standard: { crf: 18, preset: 'fast' },
  high:     { crf: 14, preset: 'fast' },
} as const;

type Preset = keyof typeof PRESETS;

function segmentsDir(): string { return path.join(paths.renders, 'segments'); }
function jobsDir(): string { return path.join(paths.renders, 'jobs'); }

function shaShort(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function runFfmpeg(args: string[], onProgress?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onProgress) for (const line of s.split('\n')) if (line.trim()) onProgress(line);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

async function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', () => resolve(parseFloat(out.trim()) || 0));
    p.on('error', () => resolve(0));
  });
}

/** True iff `file` has at least one audio stream. Used by the render
 *  pipeline before including a video file's embedded audio in the
 *  final mix — without this, an `anullsrc` injection / `[N:a?]` style
 *  optional-stream filter both fail in filter_complex (ffmpeg doesn't
 *  support the `?` optional specifier inside the graph syntax).
 *  Pre-probing once per render is cheap. */
async function ffprobeHasAudio(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', () => resolve(out.trim() === 'audio'));
    p.on('error', () => resolve(false));
  });
}

interface RenderOpts {
  fps?: 24 | 30 | 60;
  preset?: Preset;
  format?: 'mp4';
}

export async function renderTimeline(tl: Timeline, jobId: string, opts: RenderOpts = {}): Promise<{ outAbs: string; outRel: string }> {
  const fps = opts.fps ?? tl.fps ?? 24;
  const preset: Preset = opts.preset ?? 'standard';
  const { width, height } = resolveDimensions(tl.aspect as Aspect, tl.resolution as Resolution);
  const presetCfg = PRESETS[preset];

  // Frame-grid quantization. Timeline values are float-second; ffmpeg
  // encodes in discrete frames. Without snapping, each segment's `-t`
  // snaps DOWN to the last full frame (≈42ms loss at 24fps); audio
  // adelay uses exact ms and stays anchored to timeline-time, so video
  // drifts behind audio by ~half a frame per clip. By clip 25 you're a
  // half-second behind — the "lips drift out of sync towards the end"
  // bug. Quantize EVERY timeline timestamp through `toFrame()` so the
  // entire render lives on a single frame grid, with frame counts
  // derived from differences of frame indices (which is exact integer
  // arithmetic — no rounding to accumulate).
  const toFrame = (t: number): number => Math.round(t * fps);
  const frameToMs = (f: number): number => Math.round((f * 1000) / fps);

  for (const d of [segmentsDir(), jobsDir()]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

  // Stack all video tracks in array order: later = on top. The flattener
  // carves lower-track clips around any higher-track coverage so the
  // visible video at every point in master time matches what the preview
  // shows. Empty arrays are fine (a track may have been added but no
  // clips placed yet); the renderer just skips them.
  //
  // Image-overlay clips (kind === 'image-overlay') are PEELED OUT before
  // the carve: they composite WITH alpha on top of the underlying video
  // rather than replacing it, so they shouldn't be in the carve graph
  // (otherwise V1 would be punched through where a logo sits). They're
  // collected separately and applied in a post-concat overlay pass.
  const sceneKind = new Map<string, string>(tl.scenes.map((s) => [s.id, s.kind]));
  const isOverlayClip = (c: Clip): boolean => sceneKind.get(c.sceneId) === 'image-overlay';
  const videoTracks = tl.tracks.filter((t) => t.clips.length > 0);
  const videoClipTracks = videoTracks
    .map((t) => t.clips.filter((c) => !isOverlayClip(c)))
    .filter((clips) => clips.length > 0);
  // Overlays: walk every track, keep image-overlay clips with their
  // resolved scene + track index (for z-order — lower track = behind
  // higher track when multiple overlays stack at the same time).
  const overlayClips: Array<{ clip: Clip; trackIdx: number; scene: Extract<Scene, { kind: 'image-overlay' }> }> = [];
  tl.tracks.forEach((t, trackIdx) => {
    for (const c of t.clips) {
      if (!isOverlayClip(c)) continue;
      const scene = tl.scenes.find((s) => s.id === c.sceneId);
      if (scene && scene.kind === 'image-overlay') {
        overlayClips.push({ clip: c, trackIdx, scene });
      }
    }
  });
  if (videoClipTracks.length === 0 && overlayClips.length === 0) {
    throw new Error('no video clips to render');
  }
  // If the project is ONLY overlays (no underlying video), we need a
  // black base to overlay on top of. We synthesize one V1 clip-sized
  // hole by adding a fake "video clip" — but that's an edge case for
  // later. For now, require at least one real video clip.
  if (videoClipTracks.length === 0) {
    throw new Error('only image overlays present — add at least one video clip to render');
  }
  // Pass tracks top-down to flattenStack (last index = top of stack).
  const sortedClips = flattenStack([...videoClipTracks].reverse());

  // ── Step 1: trim each clip to a normalized segment ──────────────────────
  // `frames` is the exact frame count emitted by the encoder (= the
  // segment's physical duration in frames). `startFrame`/`endFrame` are
  // the segment's snapped positions on the master timeline. The concat
  // pass uses them to derive black-filler frame counts and to verify
  // the physical cursor stays on the grid.
  const segments: { path: string; frames: number; startFrame: number; endFrame: number }[] = [];
  for (let i = 0; i < sortedClips.length; i++) {
    const clip = sortedClips[i];
    const scene = tl.scenes.find((s) => s.id === clip.sceneId);
    if (!scene) throw new Error(`scene missing for clip ${clip.clipId}: ${clip.sceneId}`);
    if (scene.kind !== 'pika-gen' && scene.kind !== 'video-import') {
      throw new Error(`unsupported scene kind: ${(scene as { kind: string }).kind}`);
    }
    if (scene.kind === 'pika-gen' && (!scene.videoSrc || scene.status !== 'ready')) {
      throw new Error(`scene ${scene.id} is not ready (status: ${scene.status}, src: ${scene.videoSrc ?? 'null'})`);
    }
    const src = path.join(paths.project, scene.videoSrc!);
    if (!existsSync(src)) throw new Error(`source missing: ${src}`);

    // Each clip's frame count comes from snapped END − snapped START
    // (both as integer frame indices). That makes the count an exact
    // integer derived from the same grid used for the next clip's
    // position — so back-to-back clips pack tight (no 1-frame seam
    // between them) and any user-placed gap snaps to an integer frame
    // count too. With masterDur derived as N/fps, the encoded segment is
    // exactly N frames long — no `-t` rounding error.
    const startFrame = toFrame(clip.start);
    const endFrame = toFrame(clip.start + (clip.out - clip.in) / (clip.rate || 1));
    const frameCount = Math.max(1, endFrame - startFrame);
    const masterDur = frameCount / fps;

    const sig = shaShort(JSON.stringify({
      src, in: clip.in, out: clip.out, rate: clip.rate, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut,
      width, height, fps, preset, frameCount,
      pad: 'frame-grid-v1',  // bust cache for pre-frame-grid segments
    }));
    const segPath = path.join(segmentsDir(), `${clip.clipId}-${sig}.mp4`);
    if (!existsSync(segPath)) {
      const vfilters = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        `setsar=1`,
        `fps=${fps}`,
      ];
      if (clip.rate !== 1) vfilters.push(`setpts=${1 / clip.rate}*PTS`);
      if (clip.fadeIn > 0) vfilters.push(`fade=t=in:st=0:d=${clip.fadeIn}`);
      if (clip.fadeOut > 0) vfilters.push(`fade=t=out:st=${masterDur - clip.fadeOut}:d=${clip.fadeOut}`);
      // CRITICAL — pad the segment to its full clip-master duration. When
      // a clip's container has been ripple-extended past the source's
      // natural duration (e.g. clip_endcard_03 wants 1.73s but the source
      // mp4 is only 1.0s), ffmpeg's `-to` caps at source EOF and produces
      // a short segment. Without padding, the rendered timeline ends
      // early. `tpad=stop_mode=clone:stop_duration` freezes the last
      // decoded frame to fill the gap — matches what the user sees in
      // preview, where the <video> element freezes on its last frame
      // until the playhead crosses the clip boundary.
      vfilters.push(`tpad=stop_mode=clone:stop_duration=${masterDur.toFixed(6)}`);

      const args = [
        '-hide_banner', '-y',
        '-ss', String(clip.in),
        '-to', String(clip.out),
        '-i', src,
        '-an',                                                    // strip audio (mixed separately below)
        '-vf', vfilters.join(','),
        // Exact frame count instead of `-t seconds`. With `-t`, ffmpeg
        // truncates to the last full frame before the cap (~½-frame
        // loss per clip, cumulative drift across the render). `-frames:v`
        // is exact and combined with the CFR `fps=` filter the segment
        // is guaranteed to be `frameCount` frames = `frameCount/fps` s.
        '-frames:v', String(frameCount),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-preset', presetCfg.preset,
        '-crf', String(presetCfg.crf),
        '-movflags', '+faststart',
        segPath,
      ];
      events.broadcast({ type: 'render-progress', jobId, pct: Math.round((i / sortedClips.length) * 60), etaSec: 0 });
      await runFfmpeg(args);
    }
    segments.push({ path: segPath, frames: frameCount, startFrame, endFrame });
  }

  // ── Step 2: concat-list (V1+V2 flattened — gaps filled with black) ──────
  //
  // Track the cursor as a frame INDEX rather than a float second. Every
  // segment occupies an exact integer-frame span (`segments[i].frames`),
  // and every gap is a difference between two integer frame indices —
  // so the cursor never gains rounding error. When the next segment's
  // snapped start is past the cursor, we fill the difference with black
  // of EXACTLY (gapFrames) frames. When it equals the cursor (the
  // common "back-to-back clip" case), no filler is inserted. Result:
  // the physical concat-output position matches the snapped timeline
  // position at every clip boundary, so audio `adelay` (computed below
  // on the same frame grid) stays in lock-step with video.
  const concatLines: string[] = [];
  let cursorFrame = 0;
  for (let i = 0; i < sortedClips.length; i++) {
    const seg = segments[i];
    if (seg.startFrame > cursorFrame) {
      const gapFrames = seg.startFrame - cursorFrame;
      const blackPath = path.join(segmentsDir(), `black-${width}x${height}-${fps}-f${gapFrames}.mp4`);
      if (!existsSync(blackPath)) {
        await runFfmpeg([
          '-hide_banner', '-y',
          '-f', 'lavfi', '-i', `color=black:s=${width}x${height}:r=${fps}`,
          '-frames:v', String(gapFrames),
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '23',
          blackPath,
        ]);
      }
      concatLines.push(`file '${blackPath.replace(/'/g, "'\\''")}'`);
      cursorFrame += gapFrames;
    }
    concatLines.push(`file '${seg.path.replace(/'/g, "'\\''")}'`);
    cursorFrame += seg.frames;
  }
  // Extend the concat with black to cover any image-overlay clips whose
  // window extends past the last video clip — e.g. a credit roll on V1
  // at the end of the timeline. Without this, the overlay's `between(t,
  // start, end)` enable= window sits past the input video's duration,
  // ffmpeg's overlay filter clamps to the input end, and the credits
  // never appear in the output. The overlay pass below operates on the
  // concat video, so the base needs to be long enough to receive them.
  if (overlayClips.length > 0) {
    let maxOverlayEndFrame = 0;
    for (const o of overlayClips) {
      const endFrame = toFrame(o.clip.start + (o.clip.out - o.clip.in) / (o.clip.rate || 1));
      if (endFrame > maxOverlayEndFrame) maxOverlayEndFrame = endFrame;
    }
    if (maxOverlayEndFrame > cursorFrame) {
      const tailFrames = maxOverlayEndFrame - cursorFrame;
      const tailPath = path.join(segmentsDir(), `black-${width}x${height}-${fps}-f${tailFrames}.mp4`);
      if (!existsSync(tailPath)) {
        await runFfmpeg([
          '-hide_banner', '-y',
          '-f', 'lavfi', '-i', `color=black:s=${width}x${height}:r=${fps}`,
          '-frames:v', String(tailFrames),
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '23',
          tailPath,
        ]);
      }
      concatLines.push(`file '${tailPath.replace(/'/g, "'\\''")}'`);
      cursorFrame += tailFrames;
    }
  }
  const concatList = path.join(segmentsDir(), `concat-${jobId}.txt`);
  const fs = await import('node:fs/promises');
  await fs.writeFile(concatList, concatLines.join('\n') + '\n');

  const videoCat = path.join(jobsDir(), `${jobId}-video.mp4`);
  await runFfmpeg([
    '-hide_banner', '-y',
    '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c', 'copy',
    videoCat,
  ]);
  events.broadcast({ type: 'render-progress', jobId, pct: 65, etaSec: 0 });

  // ── Step 2.3: composite image overlays on top of the concat ─────────────
  //
  // Each image-overlay clip becomes an `overlay=...:enable='between(t,s,e)'`
  // node in one filter graph. All overlays are layered together in a single
  // ffmpeg invocation (rather than one pass per overlay) — keeps the cost
  // at exactly one re-encode regardless of how many logos / end-cards the
  // project uses. Overlay sources are scaled to project W×H and forced to
  // RGBA so PNG/WebP alpha is preserved through libavfilter; the underlying
  // [base] stays at yuv420p for libx264.
  //
  // z-order matches Track array order: lower track index = applied first
  // (behind), higher track index = applied last (on top). Within the same
  // track, clips can't overlap in master time (timeline edits enforce that),
  // so source-clip order within the track is fine.
  let videoForOverlay = videoCat;
  if (overlayClips.length > 0) {
    overlayClips.sort((a, b) => a.trackIdx - b.trackIdx);
    const overlayedPath = path.join(jobsDir(), `${jobId}-video-ovr.mp4`);
    const inputs: string[] = ['-i', videoCat];
    const filterParts: string[] = [];
    let currentLabel = '[0:v]';
    overlayClips.forEach((o, idx) => {
      const overlaySrc = path.join(paths.project, o.scene.imageSrc);
      if (!existsSync(overlaySrc)) return;
      inputs.push('-i', overlaySrc);
      const inputIdx = idx + 1;   // +1 for the base video at input 0
      // Snap overlay window to frame grid (same grid as video & audio).
      const startSec = toFrame(o.clip.start) / fps;
      const endSec = toFrame(o.clip.start + (o.clip.out - o.clip.in) / (o.clip.rate || 1)) / fps;
      // Pre-scale the overlay source to project dimensions with alpha
      // preserved. `force_original_aspect_ratio=decrease + pad` keeps the
      // image's natural aspect ratio inside the canvas, with transparent
      // padding around it where the canvas is wider/taller. PNG with
      // transparent padding === "logo floats in the corner" UX without
      // having to bake position offsets in yet (next iteration could
      // expose x/y/scale on the clip).
      filterParts.push(
        `[${inputIdx}:v]format=rgba,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#00000000[ovr${idx}]`,
      );
      const outLabel = idx === overlayClips.length - 1 ? '[vout]' : `[vovr${idx}]`;
      filterParts.push(
        `${currentLabel}[ovr${idx}]overlay=enable='between(t,${startSec.toFixed(6)},${endSec.toFixed(6)})':format=auto${outLabel}`,
      );
      currentLabel = outLabel;
    });
    if (filterParts.length > 0) {
      await runFfmpeg([
        '-hide_banner', '-y',
        ...inputs,
        '-filter_complex', filterParts.join(';'),
        '-map', currentLabel,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-preset', presetCfg.preset, '-crf', String(presetCfg.crf),
        '-movflags', '+faststart',
        overlayedPath,
      ]);
      videoForOverlay = overlayedPath;
    }
  }
  events.broadcast({ type: 'render-progress', jobId, pct: 70, etaSec: 0 });

  // ── Step 2.5: burn captions into the video ──────────────────────────────
  //
  // Captions live as a separate live layer in the editor; at render time we
  // bake them into the video stream using ffmpeg's subtitles= filter. We
  // emit ASS (not SRT) so per-row style overrides actually transfer — SRT
  // is single-style.
  let videoForMux = videoForOverlay;
  if (tl.captions?.enabled && tl.captions.rows.length > 0) {
    const fsP = await import('node:fs/promises');
    const assPath = path.join(segmentsDir(), `subs-${jobId}.ass`);
    const ass = buildAssSubtitles(tl.captions, width, height);
    await fsP.writeFile(assPath, ass, 'utf8');
    const captionedPath = path.join(jobsDir(), `${jobId}-video-cap.mp4`);
    // ffmpeg's subtitles= filter wants forward slashes + escaped colons on
    // Windows; on macOS/Linux a quoted absolute path works. We also pass
    // `fontsdir=` pointing at the user's local font directory so brand
    // fonts (e.g. Telka Extended) that are installed for the user but not
    // system-wide still resolve in libass via fontconfig.
    const userFontsDir = path.join(process.env.HOME ?? '', 'Library', 'Fonts');
    const fontsdirArg = existsSync(userFontsDir)
      ? `:fontsdir='${userFontsDir.replace(/'/g, "\\'")}'`
      : '';
    const subsArg = `subtitles=filename='${assPath.replace(/'/g, "\\'")}'${fontsdirArg}`;
    await runFfmpeg([
      '-hide_banner', '-y',
      '-i', videoForOverlay,
      '-vf', subsArg,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-preset', presetCfg.preset, '-crf', String(presetCfg.crf),
      '-movflags', '+faststart',
      captionedPath,
    ]);
    videoForMux = captionedPath;
  }
  events.broadcast({ type: 'render-progress', jobId, pct: 75, etaSec: 0 });

  // ── Step 3: audio mix (every audio track → single AAC track) ──────────
  //
  // CRITICAL: the filter graph references audio inputs via `[N:a]` where N
  // is the ffmpeg INPUT FILE INDEX. In the mux command below, `-i videoCat`
  // is added FIRST (input 0), so all audio files start at input 1. We track
  // the file index (fileIdx) separately from the audio output label index
  // (audioIdx).
  //
  // Unified model: walk every audio track in order, every clip per track.
  // Each clip's effective gain = track.gain + clip.gain. No special-casing
  // for music vs VO vs SFX — they're all just audio clips now.
  const audioInputs: string[] = [];
  const filterChunks: string[] = [];
  let audioIdx = 0;
  const fileIdx = () => audioIdx + 1;   // +1 to skip videoCat at input 0
  for (const track of tl.audioTracks) {
    for (const ac of track.clips) {
      if (!ac.src) continue;            // skip pending / empty-src clips
      const srcAbs = path.join(paths.project, ac.src);
      if (!existsSync(srcAbs)) continue;
      audioInputs.push('-i', srcAbs);
      const gainDb = (track.gain ?? 0) + (ac.gain ?? 0);
      let f = `[${fileIdx()}:a]atrim=${ac.in}:${ac.out},asetpts=PTS-STARTPTS`;
      if (ac.fadeIn > 0)  f += `,afade=t=in:st=0:d=${ac.fadeIn}`;
      if (ac.fadeOut > 0) f += `,afade=t=out:st=${(ac.out - ac.in) - ac.fadeOut}:d=${ac.fadeOut}`;
      if (gainDb !== 0)   f += `,volume=${gainDb}dB`;
      // Clamp adelay to >= 0. ffmpeg's adelay filter rejects negative
      // delays with "Delay must be non negative number" and kills the
      // whole render. The clip's master-time start CAN end up slightly
      // negative through edit ops we haven't bulletproofed (agent
      // direct-writes, weird ripple math). Render-time defense: never
      // hand ffmpeg a negative number. The clip just snaps to t=0 on
      // export; user can fix the position separately.
      //
      // Audio adelay snaps to the SAME frame grid as the video so it
      // stays in lock-step with the concat output. Plain `start * 1000`
      // gave ms precision but anchored audio to timeline-time while
      // video was being snapped down to frame boundaries on every
      // segment — by clip 25 video had drifted ~½ second behind audio.
      const adelayMs = Math.max(0, frameToMs(toFrame(ac.start)));
      f += `,adelay=${adelayMs}|${adelayMs}[a${audioIdx}]`;
      filterChunks.push(f);
      audioIdx++;
    }
  }

  // Embedded audio: every V clip WITHOUT a linked A-lane clip contributes
  // its source video's audio track here, offset to its master start
  // time. This is how "embedded mode" (the new default) renders — the
  // per-segment encode strips audio with -an, then the final mix
  // pulls audio per-clip directly from the source mp4. Linked clips
  // are skipped (their audio already comes through the A-lane loop
  // above). Keeps the segment pipeline + concat untouched.
  // Pre-probe each unique source file once for audio presence — cheap
  // (one ffprobe per file), avoids the `[N:a?]` filter_complex bug
  // (the `?` optional-stream specifier is only valid for `-map`, not
  // inside the graph). Without this, a silent source would 234 the
  // whole render with "Stream specifier ':a?' invalid".
  const audioPresence = new Map<string, boolean>();
  for (const seg of sortedClips) {
    const scene = tl.scenes?.find((s) => s.id === seg.sceneId);
    const videoRel = scene?.kind === 'pika-gen'
      ? (scene as { videoSrc?: string }).videoSrc
      : (scene as { src?: string } | undefined)?.src;
    if (!videoRel) continue;
    if (audioPresence.has(videoRel)) continue;
    const videoAbs = path.join(paths.project, videoRel);
    audioPresence.set(videoRel, existsSync(videoAbs) ? await ffprobeHasAudio(videoAbs) : false);
  }

  for (const seg of sortedClips) {
    // Per-track mute: if the user toggled audioMuted on this segment's
    // source video track (V1/V2 lane header), skip its embedded audio
    // entirely. Mirrors what Preview.tsx does for the <video> element so
    // the export matches what they hear on the timeline.
    const sourceTrack = tl.tracks.find((t) => t.id === seg.trackId);
    if (sourceTrack?.audioMuted) continue;
    const hasLinkedAudio = !!seg.linkId
      && tl.audioTracks.some((t) => t.clips.some((ac) => ac.linkId === seg.linkId));
    if (hasLinkedAudio) continue;
    const scene = tl.scenes?.find((s) => s.id === seg.sceneId);
    if (!scene) continue;
    const videoRel = scene.kind === 'pika-gen'
      ? (scene as { videoSrc?: string }).videoSrc
      : (scene as { src?: string }).src;
    if (!videoRel) continue;
    if (!audioPresence.get(videoRel)) continue;   // source has no audio → skip
    const videoAbs = path.join(paths.project, videoRel);
    if (!existsSync(videoAbs)) continue;
    audioInputs.push('-i', videoAbs);
    // FlatSeg's `in`/`out` are SOURCE-TIME bounds for the V segment;
    // start/end are MASTER-TIME bounds. We trim the source audio to
    // the source-time range and delay it to the master start.
    const masterDur = seg.end - seg.start;
    let f = `[${fileIdx()}:a]atrim=${seg.in}:${seg.out},asetpts=PTS-STARTPTS`;
    if (seg.fadeIn > 0)  f += `,afade=t=in:st=0:d=${seg.fadeIn}`;
    if (seg.fadeOut > 0) f += `,afade=t=out:st=${masterDur - seg.fadeOut}:d=${seg.fadeOut}`;
    // Per-clip embedded-audio gain (V clip's `gain` dB field). Applied
    // only on this embedded-audio path; linked V clips skip this whole
    // block earlier and get their gain via the A-clip's own slider.
    if (seg.gainDb !== 0) f += `,volume=${seg.gainDb}dB`;
    // Clamp adelay to >= 0 (see paired comment above the audioTracks loop).
    // Frame-grid snap matches the video segment encoding so embedded
    // audio stays in sync with its V clip's first frame all the way to
    // the end of the render.
    const segAdelayMs = Math.max(0, frameToMs(toFrame(seg.start)));
    f += `,adelay=${segAdelayMs}|${segAdelayMs}[a${audioIdx}]`;
    filterChunks.push(f);
    audioIdx++;
  }

  const outAbs = path.join(jobsDir(), `${jobId}.mp4`);

  if (audioIdx === 0) {
    // No audio sources — just rename the video file.
    await fs.rename(videoForMux, outAbs);
  } else {
    const mixInputs = Array.from({ length: audioIdx }, (_, i) => `[a${i}]`).join('');
    // CRITICAL: `amix` normalizes by 1/N by default — i.e. with 10 audio
    // sources playing at 0 dB each, each one comes out at -20 dB. The
    // preview engine (Web Audio) does NOT normalize: clips sum at full
    // amplitude through their gain nodes. To match what the user hears on
    // the timeline, disable amix's normalization with `normalize=0`, then
    // let `alimiter` catch any true clipping at the master.
    const filter = filterChunks.join(';') + `;${mixInputs}amix=inputs=${audioIdx}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[mixed]`;
    const mixArgs = [
      '-hide_banner', '-y',
      '-i', videoForMux,
      ...audioInputs,
      '-filter_complex', filter,
      '-map', '0:v', '-map', '[mixed]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest', '-movflags', '+faststart',
      outAbs,
    ];
    await runFfmpeg(mixArgs);
  }

  // Cleanup intermediates
  try { unlinkSync(videoCat); } catch {}
  if (videoForMux !== videoCat) { try { unlinkSync(videoForMux); } catch {} }
  try { unlinkSync(concatList); } catch {}

  events.broadcast({ type: 'render-progress', jobId, pct: 100, etaSec: 0 });
  const outRel = path.relative(paths.project, outAbs);
  return { outAbs, outRel };
}

// ───── ASS subtitle generation ──────────────────────────────────────────
//
// ffmpeg's `subtitles=` filter accepts SRT/ASS/SSA. We emit ASS because
// it's the only format that carries per-row style overrides; SRT is one
// global style. Style values authored against 1080-pixel reference space
// are scaled to the render's actual height so a `size: 36` looks the same
// at 720p / 1080p / 4K.

function buildAssSubtitles(captions: Captions, width: number, height: number): string {
  const def = captions.defaultStyle;
  // Scale all px-based sizes from the 1080-reference space to the render.
  const scale = height / 1080;
  const defStyle = assStyleLine('Default', def, scale);

  const dialogues = captions.rows
    .filter((r) => r.text && r.end > r.start)
    .map((r) => assDialogueLine(r, def, scale, width, height))
    .join('\n');

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    // Standard ASS V4+ format header — order matters; ffmpeg's libass
    // parses positionally.
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    defStyle,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    dialogues,
  ].join('\n') + '\n';
}

function assStyleLine(name: string, st: CaptionStyle, scale: number): string {
  const fs = Math.round(st.size * scale);
  const primary = cssColorToAssColor(st.color);
  // ASS only has two color slots in addition to the text color: OutlineColour
  // and BackColour. With BorderStyle=3 BackColour fills the opaque box
  // behind the text (the bg pill). With BorderStyle=1 BackColour fills the
  // drop shadow. We pick a priority so the most-asked-for effect always
  // renders: bg > outline > shadow when conflicting. Per-row `\\pos(x,y)`
  // tags below handle xPct/yPct, so the Style's Alignment is just the
  // anchor (5 = center) — actual placement comes from the dialogue tags.
  const hasBg = st.bgEnabled && !!st.bg && !/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\)/i.test(st.bg);
  const hasOutline = st.outline.enabled && st.outline.width > 0;
  const hasShadow = st.shadow.enabled;

  let borderStyle: 1 | 3;
  let outlineColor: string;
  let bgColor: string;
  let outline: number;
  let shadow: number;
  if (hasBg) {
    // Opaque box mode — Outline becomes inner padding around the text, drawn
    // in OutlineColour so it visually blends into the box.
    borderStyle = 3;
    outlineColor = cssColorToAssColor(st.bg);
    bgColor = cssColorToAssColor(st.bg);
    outline = Math.max(1, Math.round(st.padX * scale * 0.18));
    shadow = 0;
  } else {
    borderStyle = 1;
    outlineColor = hasOutline ? cssColorToAssColor(st.outline.color) : cssColorToAssColor('#000000');
    bgColor = hasShadow ? cssColorToAssColor(st.shadow.color) : cssColorToAssColor('rgba(0,0,0,0)');
    outline = hasOutline ? Math.max(1, Math.round(st.outline.width * scale)) : 0;
    // libass `Shadow` is a single offset distance; approximate with the
    // diagonal of (dx,dy) + blur. Not a true gaussian blur but close.
    shadow = hasShadow
      ? Math.max(1, Math.round((Math.hypot(st.shadow.dx, st.shadow.dy) + st.shadow.blur * 0.5) * scale))
      : 0;
  }
  const bold = st.weight >= 600 ? -1 : 0;
  // Alignment 5 = center-anchor; actual position is set per-dialogue via \\pos.
  const align = 5;
  return [
    'Style: ' + name,
    st.font,
    fs,
    primary, primary,             // primary, secondary (same — we don't karaoke)
    outlineColor, bgColor,        // outline color, back color
    bold, 0, 0, 0,
    100, 100, 0, 0,
    borderStyle, outline, shadow,
    align, 10, 10, 10, 1,
  ].join(',');
}

function assDialogueLine(row: { start: number; end: number; text: string; style: Partial<CaptionStyle> | null }, defaults: CaptionStyle, scale: number, width: number, height: number): string {
  const merged = { ...defaults, ...(row.style ?? {}) };
  // Mirror the preview's per-line trim — Whisper-aligned rows often end up
  // with trailing whitespace which libass would render as a visible gap.
  const rawText = merged.textCase === 'caps' ? row.text.toUpperCase() : row.text;
  const text = rawText.split('\n').map((ln) => ln.trim()).join('\n');
  // Always emit \pos for the merged xPct/yPct so the row lands where the
  // user placed it. \an digit picks the box's anchor edge so xPct/yPct
  // matches the live preview's translate behaviour:
  //   center → 5 (middle-center), left → 4 (middle-left), right → 6 (middle-right)
  const x = Math.round((merged.xPct / 100) * width);
  const y = Math.round((merged.yPct / 100) * height);
  const an = merged.align === 'left' ? 4 : merged.align === 'right' ? 6 : 5;
  const overrides: string[] = [`\\an${an}`, `\\pos(${x},${y})`];
  // Per-row style overrides — only fields that actually differ from defaults.
  for (const k of Object.keys(row.style ?? {}) as (keyof CaptionStyle)[]) {
    const v = (merged as any)[k];
    switch (k) {
      case 'size':   overrides.push(`\\fs${Math.round(v * scale)}`); break;
      case 'color':  overrides.push(`\\c${cssColorToAssColor(v)}`); break;
      case 'font':   overrides.push(`\\fn${v}`); break;
      case 'weight': overrides.push(v >= 600 ? '\\b1' : '\\b0'); break;
      // Outline / shadow / bg per-row overrides aren't expressible inline
      // without re-emitting a fresh Style; fall back to Default at render
      // time. Preview still honors the override visually.
      default: break;
    }
  }
  const prefix = `{${overrides.join('')}}`;
  // ASS `Text` is the LAST field in [Events]'s Format line, so any commas
  // inside the text are part of the text — no escaping needed. Only
  // newlines are special, mapped to ASS's hard-break sequence `\N`.
  const escapedText = (prefix + text).replace(/\r?\n/g, '\\N');
  return `Dialogue: 0,${assTime(row.start)},${assTime(row.end)},Default,,0,0,0,,${escapedText}`;
}

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// CSS color → ASS color (`&Haabbggrr` — alpha, blue, green, red — yes really).
// Handles #rgb / #rrggbb / rgba(r,g,b,a) / rgb(r,g,b). Defaults to white opaque.
function cssColorToAssColor(input: string): string {
  if (!input) return '&H00FFFFFF';
  let r = 255, g = 255, b = 255, a = 0;
  const hex = input.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) { r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16); }
    else { r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); }
  } else {
    const rgba = input.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (rgba) {
      r = parseInt(rgba[1], 10); g = parseInt(rgba[2], 10); b = parseInt(rgba[3], 10);
      const alpha = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
      a = Math.max(0, Math.min(255, Math.round((1 - alpha) * 255)));
    }
  }
  const hh = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `&H${hh(a)}${hh(b)}${hh(g)}${hh(r)}`;
}
