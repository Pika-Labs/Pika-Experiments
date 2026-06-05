import type { FastifyInstance } from 'fastify';
import { paths, projectExists } from '../state.js';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/project', async () => {
    return {
      projectDir: paths.project,
      exists: projectExists(),
      fpsOptions: [24, 30, 60],
      paths: {
        assets: paths.assets,
        comments: paths.comments,
        beats: paths.beats,
        renders: paths.renders,
      },
    };
  });

  app.get('/library', async () => {
    const list = (dir: string, prefix: string) => {
      try {
        return readdirSync(dir).filter(f => !f.startsWith('.')).map(name => {
          const abs = path.join(dir, name);
          const s = statSync(abs);
          return { name, rel: path.join(prefix, name), size: s.size, mtime: s.mtimeMs, isDir: s.isDirectory() };
        });
      } catch { return []; }
    };
    return {
      pika:    list(path.join(paths.assets, 'pika'),    'assets/pika'),
      imports: list(path.join(paths.assets, 'imports'), 'assets/imports'),
      music:   list(path.join(paths.assets, 'music'),   'assets/music'),
      sfx:     list(path.join(paths.assets, 'sfx'),     'assets/sfx'),
    };
  });
}
