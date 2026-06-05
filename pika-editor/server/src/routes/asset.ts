import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../state.js';

// Per-request asset streaming with HTTP range support (required for <video>
// seeking + WaveSurfer progressive decode). Resolves under the live
// `paths.assets`, so a runtime project switch picks up new files
// immediately — fastify-static captures the path at boot time and would
// 404 after switch.

const MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function streamFile(reply: FastifyReply, abs: string, rangeHeader: string | undefined): void {
  if (!existsSync(abs)) { reply.code(404).send({ error: `not found: ${path.basename(abs)}` }); return; }
  const stat = statSync(abs);
  if (!stat.isFile()) { reply.code(404).send({ error: 'not a file' }); return; }
  const size = stat.size;
  const ext = path.extname(abs).toLowerCase();
  const ct = MIME[ext] ?? 'application/octet-stream';

  // Write directly to reply.raw so Fastify's serializer doesn't strip or
  // override content-length (which it was doing for partial reads — the
  // computed length came back 0 and the browser got an empty body).
  const raw = reply.raw;
  raw.setHeader('access-control-allow-origin', '*');
  raw.setHeader('accept-ranges', 'bytes');
  raw.setHeader('content-type', ct);
  // hijack the reply so Fastify doesn't try to append its own headers
  // / content-length around the stream we're about to pipe.
  reply.hijack();

  // Range support — required for <video> seeking + WaveSurfer's progressive
  // decode. Without it the browser slurps the whole file before decoding.
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end   = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start > end || start < 0 || end >= size) {
        raw.statusCode = 416;
        raw.setHeader('content-range', `bytes */${size}`);
        raw.end();
        return;
      }
      const len = end - start + 1;
      raw.statusCode = 206;
      raw.setHeader('content-range', `bytes ${start}-${end}/${size}`);
      raw.setHeader('content-length', String(len));
      const stream = createReadStream(abs, { start, end });
      stream.on('error', () => { try { raw.end(); } catch {} });
      stream.pipe(raw);
      return;
    }
  }

  raw.statusCode = 200;
  raw.setHeader('content-length', String(size));
  const stream = createReadStream(abs);
  stream.on('error', () => { try { raw.end(); } catch {} });
  stream.pipe(raw);
}

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  // Project assets — resolves under the live `paths.assets` so a runtime
  // project switch picks up new files immediately.
  app.get<{ Params: { '*': string } }>('/asset/*', async (req, reply) => {
    const rel = (req.params as any)['*'] ?? '';
    const abs = path.join(paths.assets, rel);
    const root = path.resolve(paths.assets);
    if (!path.resolve(abs).startsWith(root + path.sep) && path.resolve(abs) !== root) {
      reply.code(403).send({ error: 'forbidden' }); return;
    }
    streamFile(reply, abs, req.headers.range);
  });

}
