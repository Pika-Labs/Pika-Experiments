/**
 * Captions auto-generation route.
 *
 *   POST /captions/auto    { sceneId, script? }
 *
 * For the named scene's extracted VO audio (assets/sfx/<sceneId>.wav, or
 * the linked SFX clip if different):
 *   1. Upload the audio to Pika's CDN via `upload_asset`.
 *   2. Call Pika `transcribe_audio` (Whisper) requesting word-level timings.
 *   3. If `script` is provided, align it to the Whisper word timings so the
 *      caption rows read with the agent's intended words but at Whisper's
 *      precise moments. If `script` is omitted, the Whisper words are used
 *      verbatim — fine for general dialogue but loses fidelity for brand /
 *      character / jargon names.
 *   4. Group aligned words into rows (~6 words or 3s) and APPEND them to
 *      timeline.captions.rows. Existing rows are kept — the caller is in
 *      charge of clearing or replacing.
 *
 * Times in the emitted rows are MASTER timeline seconds (offset by the
 * linked SFX clip's `start` field), so the rows line up with the picture
 * when the user plays back.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { existsSync, statSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { paths, readTimeline, writeTimeline, mutateTimeline } from '../state.js';
import { TimelineSchema, type Timeline } from '../schema.js';
import { events } from '../events.js';
import { callPikaTool } from '../agent/pika-mcp.js';
import { isAuthenticated as isPikaAuthenticated } from '../agent/pika-auth.js';
import { tokenizeScript, parseWhisperWords, alignWords, groupIntoRows } from '../workers/caption-align.js';
import { findCaptionAudioForScene } from '../audio-track-utils.js';

/**
 * ffmpeg-trim a window out of a source audio file. Returns the absolute
 * path of the resulting WAV in a per-session temp dir. We cache by the
 * (src, in, out) tuple so re-running auto-caption doesn't re-encode.
 *
 * Why we trim: a VO clip can point at a slice of a larger source file
 * (e.g. sfx_sc_01 [0–8.38] and sfx_sc_01_b [8.38–15.07] both reference
 * sc_01.wav). Transcribing the full file once per clip duplicates rows
 * for every overlapping clip. Trimming first means each iteration only
 * captions its own segment.
 */
function trimAudio(srcAbs: string, inSec: number, outSec: number): Promise<string> {
  // Cache key includes the source file's size + mtime so a regenerated
  // take (audio rewritten at the same path) invalidates the cached trim.
  // Without this, captioning re-runs after a regen returned the OLD
  // trimmed bytes, Pika's upload_asset idempotency keyed on filename +
  // size matched the prior upload, and Whisper transcribed the OLD take
  // — the "captions don't match the audio I just generated" bug.
  const srcStat = statSync(srcAbs);
  const sig = createHash('sha256')
    .update(`${srcAbs}|${srcStat.size}|${srcStat.mtimeMs}|${inSec}|${outSec}`)
    .digest('hex')
    .slice(0, 12);
  const cacheDir = path.join(os.tmpdir(), 'pae-cap-trim');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const outAbs = path.join(cacheDir, `${path.basename(srcAbs, path.extname(srcAbs))}-${sig}.wav`);
  if (existsSync(outAbs)) return Promise.resolve(outAbs);
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-y',
      '-ss', String(inSec),
      '-to', String(outSec),
      '-i', srcAbs,
      '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1',   // 16k mono — perfect for Whisper
      outAbs,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(outAbs);
      else reject(new Error(`ffmpeg trim exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Look up the intended VO line for a scene from plan.json. Match strategies,
 * in order: (1) beat.id === sceneId, (2) beat.label === sceneId. If a beat
 * has a `dialogue: [{who, line}]` array, we join the lines into a single
 * string and return it for the alignment script. Empty string when nothing
 * usable is found (the route then falls back to Whisper-verbatim).
 *
 * NOTE: we DELIBERATELY do not fall back to `scene.prompt` — that field is
 * Seedance's visual directive, not dialogue. Stuffing it as the alignment
 * script produced captions like "ACT I — The Pitch (Void). Walk-in →…"
 * which is exactly what was happening before this fix.
 */
function dialogueScriptFromPlan(sceneId: string): string {
  const planPath = path.join(paths.project, 'plan.json');
  if (!existsSync(planPath)) return '';
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const beats = Array.isArray(plan?.beats) ? plan.beats : [];
    const beat = beats.find((b: any) => b?.id === sceneId)
      ?? beats.find((b: any) => b?.label === sceneId);
    if (!beat) return '';
    const dialogue = Array.isArray(beat.dialogue) ? beat.dialogue : [];
    return dialogue
      .map((d: any) => (typeof d?.line === 'string' ? d.line : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
  } catch { return ''; }
}

function mimeForAudio(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4';
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  return 'application/octet-stream';
}

/**
 * Two-step upload to Pika's CDN. The Pika `upload_asset` MCP tool returns a
 * presigned PUT URL plus the eventual public CDN URL given file metadata —
 * it does NOT accept the bytes directly. The actual upload is a plain PUT
 * against R2 (Cloudflare's S3-compatible storage) with the file body.
 */
async function uploadToPikaCdn(absPath: string): Promise<{ publicUrl: string }> {
  const filename = path.basename(absPath);
  const size = statSync(absPath).size;
  const mime = mimeForAudio(absPath);
  const upload = await callPikaTool('upload_asset', {
    filename,
    mime_type: mime,
    size_bytes: size,
  });
  if (upload.error) throw new Error(`pika upload_asset failed: ${upload.content}`);
  let parsed: { presigned_url?: string; public_url?: string } = {};
  try { parsed = JSON.parse(upload.content); }
  catch { throw new Error(`upload_asset returned non-JSON: ${upload.content.slice(0, 200)}`); }
  if (!parsed.presigned_url || !parsed.public_url) {
    throw new Error(`upload_asset missing urls: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  const body = readFileSync(absPath);
  const put = await fetch(parsed.presigned_url, {
    method: 'PUT',
    headers: { 'content-type': mime },
    body,
  });
  if (!put.ok) {
    const txt = await put.text().catch(() => '');
    throw new Error(`presigned PUT ${put.status}: ${txt.slice(0, 200)}`);
  }
  return { publicUrl: parsed.public_url };
}

const Body = z.object({
  sceneId: z.string(),
  script: z.string().optional(),
  // Replace mode: clear existing rows that fall inside the scene's window
  // before appending the new ones. Default false — additive.
  replace: z.boolean().default(false),
});

/**
 * Per-scene auto-caption core. Loads the scene's VO clip, uploads to Pika,
 * transcribes, aligns, and returns the new rows together with the start /
 * end of the scene's window (so the caller can decide replace semantics
 * over multiple scenes). Does NOT mutate the timeline — the caller commits.
 */
async function autoCaptionScene(
  timeline: Timeline,
  sceneId: string,
  scriptText: string | undefined,
): Promise<
  | { ok: true; sceneStart: number; sceneEnd: number; rows: Array<{ id: string; start: number; end: number; text: string; style: null; linkSceneId: string }>; usedWhisperTimings: boolean }
  | { ok: false; error: string; detail?: string }
> {
  // Find the audio that's ACTUALLY audible at the scene's master-time
  // window. Walks every audio track, scores by kind priority (vo/voice >
  // imported/generated > sfx; music ignored) × overlap length. Returns
  // the source-time window of the OVERLAP — so a long VO file that
  // straddles two scenes only gets the relevant slice transcribed.
  //
  // Old behavior was: find the canonically-named (`sfx_<sceneId>`) or
  // linkId-paired audio clip. This missed unlinked VO files dropped on
  // the timeline manually, and captioned the wrong audio whenever the
  // user separated VO from picture without linking it. New behavior is
  // "caption what's audible there", which matches user intent.
  const located = findCaptionAudioForScene(timeline, sceneId);
  const sfxClip = located?.clip;
  if (!sfxClip || !located) return { ok: false, error: 'no-vo-clip-for-scene' };
  const audioAbs = path.join(paths.project, sfxClip.src);
  if (!existsSync(audioAbs)) return { ok: false, error: 'audio-file-missing', detail: sfxClip.src };

  // ALWAYS trim to the overlap window before sending to Whisper.
  //
  // The old gate skipped trimming when the overlap "looked like" the
  // whole clip (`overlapInSec === 0 && overlapOutSec === naturalDuration`).
  // But `naturalDuration` is metadata — it can be wrong, stale, or
  // missing. The actual audio file on disk can be longer than the clip
  // claims (common after a trim that didn't re-write the source). When
  // that happened, we uploaded the FULL file and Whisper transcribed
  // everything, producing captions for audio outside the V-clip's
  // window and ignoring the trim entirely.
  //
  // Trimming is idempotent and cached by (src, in, out) hash in tmp, so
  // running it unconditionally costs nothing on the second pass.
  let uploadAbs = audioAbs;
  try {
    uploadAbs = await trimAudio(audioAbs, located.overlapInSec, located.overlapOutSec);
  } catch (err: any) {
    return { ok: false, error: 'audio-trim-failed', detail: String(err?.message ?? err) };
  }

  let cdnUrl: string;
  try { cdnUrl = (await uploadToPikaCdn(uploadAbs)).publicUrl; }
  catch (err: any) { return { ok: false, error: 'pika-upload-failed', detail: String(err?.message ?? err) }; }

  const tr = await callPikaTool('transcribe_audio', {
    audio: cdnUrl,
    word_timestamps: true,
    words: true,
    granularity: 'word',
  });
  if (tr.error) return { ok: false, error: 'pika-transcribe-failed', detail: tr.content };

  let whisperWords: ReturnType<typeof parseWhisperWords> = [];
  let plainText = '';
  try {
    const parsedRes = JSON.parse(tr.content);
    whisperWords = parseWhisperWords(parsedRes);
    // Whisper wrappers vary — some return { text: "…", words: [...] } and
    // others return just { text: "…" } when word-level wasn't enabled.
    // Capture the full text so the "no-script + no-word-level" case still
    // yields readable rows (timed by even distribution) instead of empty.
    if (typeof parsedRes?.text === 'string') plainText = parsedRes.text;
    else if (Array.isArray(parsedRes?.segments)) {
      plainText = parsedRes.segments.map((s: any) => s?.text ?? '').filter(Boolean).join(' ').trim();
    }
  } catch {
    // Response was plain text (not JSON) — that's the transcription.
    plainText = tr.content.trim();
  }
  // Master-time offset where this overlap begins — caption rows we emit
  // will be at `offsetSec + word.start` on the master timeline. With the
  // new overlap-aware lookup, the offset is the source-clip's start PLUS
  // the lead-in we trimmed off (overlapInSec - clip.in). With the legacy
  // fallback path, overlapInSec === clip.in, so the +0 path still works.
  const trimLead = located.overlapInSec - sfxClip.in;
  const offsetSec = sfxClip.start + trimLead;
  const audioDur = Math.max(0.1, located.overlapOutSec - located.overlapInSec);

  // If we have plain text but no word-level timings, synthesize uniformly
  // spread "whisper words" across the audio duration so the rest of the
  // pipeline works the same way.
  if (whisperWords.length === 0 && plainText) {
    const words = plainText.split(/\s+/).filter(Boolean);
    const per = audioDur / Math.max(1, words.length);
    whisperWords = words.map((w, i) => ({ text: w, start: i * per, end: (i + 1) * per }));
  }

  let rows: ReturnType<typeof groupIntoRows>;
  if (scriptText && scriptText.trim().length > 0) {
    const scriptTok = tokenizeScript(scriptText);
    if (whisperWords.length === 0) {
      // No Whisper output at all — distribute script words evenly so we
      // still emit captions. User can fix timing manually after.
      const per = audioDur / Math.max(1, scriptTok.length);
      whisperWords = scriptTok.map((sw, i) => ({ text: sw.display, start: i * per, end: (i + 1) * per }));
    }
    const aligned = alignWords(scriptTok, whisperWords);
    rows = groupIntoRows(aligned, offsetSec);
  } else {
    const aligned = whisperWords.map((w) => ({ text: w.text, start: w.start, end: w.end, matched: true }));
    rows = groupIntoRows(aligned, offsetSec);
  }

  const stamp = Date.now().toString(36);
  const newRows = rows.map((r, i) => ({
    id: `cap_${sceneId}_${i}_${stamp}`,
    start: Math.round(r.start * 1000) / 1000,
    end: Math.round(r.end * 1000) / 1000,
    text: r.text,
    style: null,
    linkSceneId: sceneId,
  }));

  return {
    ok: true,
    sceneStart: offsetSec,
    sceneEnd: offsetSec + audioDur,
    rows: newRows,
    usedWhisperTimings: whisperWords.length > 0,
  };
}

const AllBody = z.object({
  /** Optional fall-back script when a scene has no plan dialogue. */
  defaultScript: z.string().optional(),
  /**
   * Wipe ALL caption rows before re-running. Default true — the natural
   * UX for "auto-caption everything" is "start from scratch." Set false
   * only if the caller knows what they're doing and wants per-scene
   * additive behavior.
   */
  clearAll: z.boolean().default(true),
});

export async function captionsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/captions/auto', async (req, reply) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    if (!isPikaAuthenticated()) { reply.code(401); return { error: 'pika-not-authenticated' }; }
    const { sceneId, script, replace } = parsed.data;

    // PHASE 1 (outside actor lock): the long-running work — ffmpeg trim,
    // Pika upload, Whisper transcribe. Multiple seconds. We do this with
    // a snapshot of the timeline that's good enough to LOCATE the VO clip
    // and trim the right window. The final commit reads fresh state.
    const { timeline: snapshot } = readTimeline();
    const effectiveScript = (script && script.trim()) || dialogueScriptFromPlan(sceneId) || undefined;
    const result = await autoCaptionScene(snapshot, sceneId, effectiveScript);
    if (!result.ok) {
      reply.code(result.error === 'no-vo-clip-for-scene' || result.error === 'audio-file-missing' ? 404 : 502);
      return { error: result.error, detail: result.detail };
    }

    // PHASE 2 (inside actor lock): append the rows atomically. The previous
    // bug was: 4 parallel /captions/auto calls all read the same snapshot,
    // all appended their rows to that snapshot, all wrote — last writer
    // won and 3 batches vanished. Now we re-read inside the lock, so
    // parallel calls see each other's appends.
    await mutateTimeline((tl) => {
      const existing = replace
        ? tl.captions.rows.filter((r) => r.end <= result.sceneStart || r.start >= result.sceneEnd)
        : tl.captions.rows;
      const next: Timeline = {
        ...tl,
        captions: { ...tl.captions, rows: [...existing, ...result.rows] },
      };
      return { next: TimelineSchema.parse(next), result: undefined };
    });
    return { ok: true, added: result.rows.length, replaced: replace, usedWhisperTimings: result.usedWhisperTimings };
  });

  /**
   * POST /captions/auto-all — caption every scene with a VO clip in one
   * pass. For each scene we use its `prompt` as the script (the agent's
   * intended VO line) so brand / character names render correctly.
   * Returns a per-scene report so the UI can surface partial successes.
   */
  app.post('/captions/auto-all', async (req, reply) => {
    const parsed = AllBody.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    if (!isPikaAuthenticated()) { reply.code(401); return { error: 'pika-not-authenticated' }; }
    const { defaultScript, clearAll } = parsed.data;

    // PHASE 1 — clear (if requested) atomically. Done up front via actor
    // so concurrent edits don't smuggle rows back in mid-pass.
    if (clearAll) {
      await mutateTimeline((tl) => {
        const next = TimelineSchema.parse({ ...tl, captions: { ...tl.captions, rows: [] } });
        return { next, result: undefined };
      });
    }

    // PHASE 2 — enumerate scenes from a snapshot. The list itself is
    // stable (the agent doesn't generally remove audio clips concurrently
    // with caption-all), so a snapshot here is fine.
    const snapshot = readTimeline().timeline;
    const sceneIds = Array.from(new Set(
      snapshot.audioTracks
        .flatMap((t) => t.clips)
        .map((c) => {
          if (c.id.startsWith('sfx_')) return c.id.slice(4);
          if (c.linkId) {
            const v = snapshot.tracks.flatMap((tr) => tr.clips).find((vc) => vc.linkId === c.linkId);
            if (v) return v.sceneId;
          }
          return null;
        })
        .filter((s): s is string => !!s)
    ));
    if (sceneIds.length === 0) {
      reply.code(400);
      return { error: 'no-vo-clips', detail: 'no scene has an extracted VO clip yet — generate audio first' };
    }

    // PHASE 3 — slow per-scene work happens OUTSIDE the actor. Each
    // autoCaptionScene call does ffmpeg trim + Pika upload + Whisper
    // transcribe. We compute the rows first, commit them after.
    type Per = { sceneId: string; rows?: any[]; sceneStart?: number; sceneEnd?: number; usedWhisperTimings?: boolean; error?: string };
    const computed: Per[] = [];
    for (const sceneId of sceneIds) {
      const planScript = dialogueScriptFromPlan(sceneId);
      const script = planScript || defaultScript || undefined;
      const r = await autoCaptionScene(snapshot, sceneId, script);
      if (!r.ok) { computed.push({ sceneId, error: r.error }); continue; }
      computed.push({ sceneId, rows: r.rows, sceneStart: r.sceneStart, sceneEnd: r.sceneEnd, usedWhisperTimings: r.usedWhisperTimings });
    }

    // PHASE 4 — commit everything atomically. One actor mutation merges
    // all the rows + repairs overlaps in one fresh-read pass. No window
    // for concurrent edits to lose data.
    await mutateTimeline((tl) => {
      let rows = tl.captions.rows.slice();
      for (const p of computed) {
        if (!p.rows) continue;
        const existing = clearAll
          ? rows
          : rows.filter((row) => row.end <= p.sceneStart! || row.start >= p.sceneEnd!);
        rows = [...existing, ...p.rows];
      }
      rows = enforceNoOverlap(rows);
      const next = TimelineSchema.parse({ ...tl, captions: { ...tl.captions, rows } });
      return { next, result: undefined };
    });

    const report = computed.map((p) => ({
      sceneId: p.sceneId,
      ...(p.error ? { error: p.error } : { added: p.rows?.length ?? 0, usedWhisperTimings: p.usedWhisperTimings }),
    }));
    const total = report.reduce((a, b: any) => a + (b.added ?? 0), 0);
    return { ok: true, total, scenes: report };
  });

  /**
   * DELETE /captions — wipe every caption row from the timeline. The track
   * default style + enabled flag are preserved; only the rows go.
   */
  app.delete('/captions', async () => {
    const { timeline } = readTimeline();
    const next = TimelineSchema.parse({
      ...timeline,
      captions: { ...timeline.captions, rows: [] },
    });
    const { sha } = await writeTimeline(next);
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true, removed: timeline.captions.rows.length };
  });

  /**
   * POST /captions/repair — one-shot cleanup for existing rows: sort by
   * start, clamp each row's start to the previous row's end so libass and
   * the preview overlay don't stack them at different heights. Idempotent.
   */
  app.post('/captions/repair', async () => {
    const { timeline } = readTimeline();
    const before = timeline.captions.rows.length;
    const next = TimelineSchema.parse({
      ...timeline,
      captions: { ...timeline.captions, rows: enforceNoOverlap(timeline.captions.rows) },
    });
    const { sha } = await writeTimeline(next);
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true, rows: before };
  });
}

/**
 * Sort rows by start and clamp each one's start to the previous row's end
 * so adjacent rows just touch but never overlap. End is also nudged forward
 * if the clamped start would have made the row zero-duration (or worse).
 */
function enforceNoOverlap(rows: { id: string; start: number; end: number; text: string; style: any; linkSceneId: any }[]): typeof rows {
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  let lastEnd = 0;
  return sorted.map((r) => {
    const start = Math.max(r.start, lastEnd);
    const end = Math.max(start + 0.05, r.end);
    lastEnd = end;
    return { ...r, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
  });
}
