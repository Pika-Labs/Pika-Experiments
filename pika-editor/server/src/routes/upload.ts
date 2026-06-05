/**
 * Asset upload — accepts raw binary bodies for video files dragged from the
 * Finder. Writes to `assets/imports/<safe-name>`, runs ffprobe for the
 * natural duration, optionally extracts audio onto SFX, and returns enough
 * metadata for the client to slot it onto V1 as a video-import scene.
 *
 * Why raw binary instead of multipart: client uses fetch with the file's
 * blob directly (one HTTP request, no FormData ceremony). Fastify is set
 * up in index.ts with an audio/video/image content-type parser that hands
 * us a Buffer.
 */
import type { FastifyInstance } from 'fastify';
import { writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { paths } from '../state.js';
import { extractAudio } from '../workers/audio-extract.js';

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', () => resolve(parseFloat(out.trim()) || 0));
    p.on('error', () => resolve(0));
  });
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // POST /upload/import?filename=foo.mp4&extractAudio=true
  // Body = raw bytes (Buffer via the content-type parser in index.ts).
  app.post<{ Querystring: { filename?: string; extractAudio?: string } }>('/upload/import', async (req, reply) => {
    const body = req.body as Buffer | undefined;
    if (!body || !(body instanceof Buffer)) { reply.code(400); return { error: 'missing binary body' }; }
    const rawName = (req.query.filename ?? `import_${Date.now()}.mp4`).toString();
    const fname = safeFilename(rawName);
    const dir = path.join(paths.assets, 'imports');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, fname);
    writeFileSync(abs, body);
    const rel = path.relative(paths.project, abs);

    // Detect image-overlay imports (PNG / WebP / JPG) — skip ffprobe
    // (it's a still, not a video) and signal back to the client so it
    // creates an image-overlay scene rather than a video-import scene.
    // Image overlays composite WITH alpha on top of underlying video at
    // render time; the client adds them to a track with no carve below.
    const ext = (path.extname(fname).slice(1) || '').toLowerCase();
    const isImage = ['png', 'webp', 'jpg', 'jpeg'].includes(ext);
    if (isImage) {
      return {
        ok: true,
        rel,
        filename: fname,
        size: statSync(abs).size,
        kind: 'image' as const,
        // No source duration — caller picks. 3s default lines up with
        // the schema's ImageOverlaySceneSchema default.
        duration: 3,
        sfxRel: null,
        linkId: null,
      };
    }

    const duration = await ffprobeDuration(abs);

    // If the caller asked for audio extraction (off by default for user
    // imports — they often bring already-edited videos with intentional
    // audio), pull the audio onto SFX with a fresh linkId.
    let sfxRel: string | null = null;
    let linkId: string | null = null;
    if (req.query.extractAudio === 'true') {
      try {
        const sceneId = `vi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const result = await extractAudio(abs, sceneId);
        if (result.audioRel) {
          sfxRel = result.audioRel;
          linkId = `lk_${sceneId}`;
        }
      } catch (err: any) {
        app.log.warn({ err: String(err?.message ?? err) }, 'audio extract on upload failed (non-fatal)');
      }
    }

    return {
      ok: true,
      rel,
      filename: fname,
      size: statSync(abs).size,
      kind: 'video' as const,
      duration,
      sfxRel,
      linkId,
    };
  });

  /**
   * POST /upload/ref?filename=foo.png
   * Body = raw bytes. Writes to `assets/refs/uploads/<safe-name>`, infers
   * the kind from the extension, and returns enough metadata for the
   * client to surface the file in the Reference Library. Unlike
   * `/upload/import` this doesn't probe duration or extract audio — refs
   * are pictures + clips the user wants to feed the AGENT, not place on
   * the timeline directly.
   */
  app.post<{ Querystring: { filename?: string } }>('/upload/ref', async (req, reply) => {
    const body = req.body as Buffer | undefined;
    if (!body || !(body instanceof Buffer)) { reply.code(400); return { error: 'missing binary body' }; }
    const rawName = (req.query.filename ?? `ref_${Date.now()}.bin`).toString();
    const fname = safeFilename(rawName);
    const dir = path.join(paths.assets, 'refs', 'uploads');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, fname);
    writeFileSync(abs, body);
    const rel = path.relative(paths.project, abs);
    const ext = (path.extname(fname).slice(1) || '').toLowerCase();
    const kind: 'image' | 'video' | 'audio' | 'other' =
      ['png','jpg','jpeg','gif','webp','heic'].includes(ext) ? 'image' :
      ['mp4','mov','webm','m4v','avi'].includes(ext) ? 'video' :
      ['mp3','wav','m4a','ogg','flac','aac'].includes(ext) ? 'audio' :
      'other';
    return { ok: true, rel, filename: fname, kind, size: statSync(abs).size };
  });
}
