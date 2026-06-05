/**
 * Named saves wrapping git. Each project gets a hidden `.git/` initialized
 * on first save. A version = one commit, with the user-supplied name in the
 * commit message body. List / restore by commit sha. Lightweight; no remote.
 *
 * Why git and not a custom snapshot store: git already solves content-
 * addressable storage + diffing + restore + pack-on-disk. Wrapping it gives
 * the user real version history with zero new code, and the project dir is
 * `cd && git log` inspectable on the CLI without leaving the editor world.
 */
import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../state.js';

function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.on('error', () => resolve({ code: -1, stdout: '', stderr: 'spawn error' }));
  });
}

async function ensureRepo(): Promise<void> {
  const gitDir = path.join(paths.project, '.git');
  if (existsSync(gitDir)) return;
  await runGit(paths.project, ['init', '-q', '-b', 'main']);
  await runGit(paths.project, ['config', 'user.email', 'editor@pika.local']);
  await runGit(paths.project, ['config', 'user.name', 'PikaAgentEditor']);
  // Ignore the renders directory by default — generated MP4s shouldn't
  // bloat the repo.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(paths.project, '.gitignore'),
    'renders/\nrenders/jobs/\nrenders/segments/\n.DS_Store\n');
  await runGit(paths.project, ['add', '-A']);
  await runGit(paths.project, ['commit', '-q', '-m', 'init', '--allow-empty']);
}

interface VersionEntry { sha: string; message: string; date: string; current: boolean }

async function listVersions(): Promise<VersionEntry[]> {
  if (!existsSync(path.join(paths.project, '.git'))) return [];
  const { stdout } = await runGit(paths.project, [
    'log', '--all', '--pretty=format:%H|%s|%aI',
  ]);
  const head = (await runGit(paths.project, ['rev-parse', 'HEAD'])).stdout.trim();
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, message, date] = line.split('|');
    return { sha, message, date, current: sha === head };
  });
}

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/versions', async () => {
    return { versions: await listVersions() };
  });

  app.post<{ Body: { name: string } }>('/versions', async (req, reply) => {
    const name = (req.body?.name ?? '').toString().trim() || `Save ${new Date().toLocaleString()}`;
    await ensureRepo();
    await runGit(paths.project, ['add', '-A']);
    // `git diff --cached --quiet` exits 1 if there's staged changes, 0 if nothing.
    const diff = await runGit(paths.project, ['diff', '--cached', '--quiet']);
    if (diff.code === 0) {
      // Nothing staged — still create an empty commit so the named save shows up.
      await runGit(paths.project, ['commit', '-q', '-m', name, '--allow-empty']);
    } else {
      const r = await runGit(paths.project, ['commit', '-q', '-m', name]);
      if (r.code !== 0) { reply.code(500); return { error: 'commit failed', stderr: r.stderr }; }
    }
    const versions = await listVersions();
    return { ok: true, versions };
  });

  app.post<{ Params: { sha: string } }>('/versions/:sha/restore', async (req, reply) => {
    if (!existsSync(path.join(paths.project, '.git'))) { reply.code(400); return { error: 'no git history' }; }
    const sha = req.params.sha;
    // checkout to a detached HEAD at that sha, then create a new commit on
    // main that restores those file contents. Keeps history linear + leaves
    // the user on `main` so subsequent saves work.
    const r1 = await runGit(paths.project, ['checkout', '--detach', sha]);
    if (r1.code !== 0) { reply.code(404); return { error: 'restore failed', stderr: r1.stderr }; }
    await runGit(paths.project, ['checkout', '-B', 'main']);
    await runGit(paths.project, ['commit', '-q', '-m', `restore ${sha.slice(0, 7)}`, '--allow-empty']);
    return { ok: true };
  });
}
