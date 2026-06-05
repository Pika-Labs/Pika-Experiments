/**
 * Beat / downbeat detection for the music lane. Uses librosa's onset +
 * beat-tracker via a one-shot Python child process. Writes the result to
 * `<project>/beats.json` and the timeline reads it back via the watcher.
 *
 * The Python is inline (no external script file) so the project dir stays
 * clean. Requires librosa installed on PATH — the install check returns
 * a 503 with a hint instead of crashing.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { paths, readTimeline, writeTimeline } from '../state.js';
import { TimelineSchema, type Timeline } from '../schema.js';
import { events } from '../events.js';

const Body = z.object({
  // Path under the project dir, e.g. "assets/music/whatever.mp3". When
  // omitted, defaults to the project's music.src.
  src: z.string().optional(),
});

const PY = `
import sys, json
import librosa
src = sys.argv[1]
y, sr = librosa.load(src, sr=None, mono=True)
tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units='time')
onsets = librosa.onset.onset_detect(y=y, sr=sr, units='time').tolist()
# Downbeats = every 4th beat as a default 4/4 assumption. Sufficient for
# the music lane's beat grid; the user can refine downbeats manually later.
beats = [float(b) for b in beat_frames.tolist()]
downbeats = beats[::4]
print(json.dumps({"bpm": float(tempo) if hasattr(tempo, 'tolist') else tempo, "beats": beats, "downbeats": downbeats, "onsets": onsets}))
`;

function runPython(scriptArg: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('python3', ['-c', PY, scriptArg], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.on('error', () => resolve({ code: -1, stdout: '', stderr: 'spawn error' }));
  });
}

export async function beatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/beats', async (_req, reply) => {
    if (!existsSync(paths.beats)) { reply.code(404); return { error: 'no beats.json' }; }
    return JSON.parse(readFileSync(paths.beats, 'utf8'));
  });

  app.post('/beats', async (req, reply) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    const { timeline } = readTimeline();
    // Find a music-kind audio clip if the caller didn't supply a src.
    const musicSrc = timeline.audioTracks
      .flatMap((t) => t.clips)
      .find((c) => c.kind === 'music' && c.src && c.status === 'ready')?.src;
    const srcRel = parsed.data.src ?? musicSrc;
    if (!srcRel) { reply.code(400); return { error: 'no music src on the timeline; supply { src } or generate music first' }; }
    const abs = path.join(paths.project, srcRel);
    if (!existsSync(abs)) { reply.code(404); return { error: `music file missing: ${srcRel}` }; }
    const { code, stdout, stderr } = await runPython(abs);
    if (code !== 0) {
      reply.code(503);
      return {
        error: 'beat detection failed',
        hint: 'librosa must be installed (pip3 install librosa). Or ask the agent to run beat detection.',
        stderr: stderr.slice(-800),
      };
    }
    let result: any;
    try { result = JSON.parse(stdout); }
    catch { reply.code(500); return { error: 'failed to parse librosa output', stdout: stdout.slice(0, 400) }; }
    writeFileSync(paths.beats, JSON.stringify(result, null, 2));
    // Also stamp the timeline's beats + downbeats so the grid renders.
    const next: Timeline = {
      ...timeline,
      bpm: result.bpm ?? null,
      beats: result.beats ?? [],
      downbeats: result.downbeats ?? [],
    };
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'beats-changed' });
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true, bpm: result.bpm, beatsCount: (result.beats ?? []).length };
  });
}
