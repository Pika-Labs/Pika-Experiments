/**
 * Audio extraction — when the agent finishes a gen, if the resulting video
 * has an audio track, we pull it out to a sibling WAV and attach it to the
 * SFX lane with a linkId that binds it to the source clip. Edit ops in the
 * client honor linkId so move/trim/slip/delete on the video ripples through
 * the audio (and vice-versa).
 *
 * Why: most native-audio video models emit a single MP4 with mixed ambient
 * sound + dialogue. If we play that back as-is, you can't independently
 * mute the dialogue, swap the music, or move the clip without the audio
 * drifting. Pulling audio onto its own lane gives the user real control.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../state.js';

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    proc.on('error', () => resolve({ code: -1, stderr: 'spawn error' }));
  });
}

/**
 * Detect whether the video has any audio stream. Returns true if at least one
 * audio stream is present (regardless of channel count or sample rate).
 */
export async function videoHasAudio(absPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      absPath,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', () => resolve(out.trim().includes('audio')));
    p.on('error', () => resolve(false));
  });
}

export interface ExtractResult {
  /** absolute path of the extracted WAV (or null if no audio) */
  audioAbs: string | null;
  /** path relative to the project dir (for storing in SfxClip.src) */
  audioRel: string | null;
  /** measured duration in seconds */
  durationSec: number;
}

/**
 * Extract audio from a video into `<project>/assets/sfx/<sceneId>.wav`. Returns
 * paths + duration on success, all-null when the source has no audio.
 *
 * Stereo PCM 48k by default — small enough not to bloat the project, lossless
 * enough that downstream mixing in the render pipeline doesn't double-encode.
 */
export async function extractAudio(videoAbs: string, sceneId: string): Promise<ExtractResult> {
  if (!existsSync(videoAbs)) throw new Error(`source missing: ${videoAbs}`);
  const hasAudio = await videoHasAudio(videoAbs);
  if (!hasAudio) return { audioAbs: null, audioRel: null, durationSec: 0 };
  const sfxDir = path.join(paths.assets, 'sfx');
  if (!existsSync(sfxDir)) mkdirSync(sfxDir, { recursive: true });
  const audioAbs = path.join(sfxDir, `${sceneId}.wav`);
  const { code, stderr } = await run('ffmpeg', [
    '-hide_banner', '-y',
    '-i', videoAbs,
    '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le',
    audioAbs,
  ]);
  if (code !== 0) throw new Error(`ffmpeg audio extract failed: ${stderr.slice(-800)}`);
  const stat = statSync(audioAbs);
  // ffprobe duration
  const dur = await new Promise<number>((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioAbs]);
    let out = ''; p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', () => resolve(parseFloat(out.trim()) || 0));
    p.on('error', () => resolve(0));
  });
  return {
    audioAbs,
    audioRel: path.relative(paths.project, audioAbs),
    durationSec: dur,
  };
}
