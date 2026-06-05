/**
 * Path scoping for the in-app agent.
 *
 * The agent is allowed to touch:
 *   • The active project directory (read + write)
 *   • The repo's .claude/skills/ tree (read only)
 *   • brand-kit/ (read only — fonts, design tokens, strategy.md)
 *   • PikaAgent/tmp/ (read + write — scratch space)
 *
 * Anything else is rejected. Absolute paths must start with one of these
 * roots; relative paths resolve against the active project. The check is
 * realpath-aware to defeat symlink escapes.
 */
import path from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { paths } from '../state.js';

// Locate the editor root (PikaAgentEditor/) and the parent PikaAgent root.
// state.ts already knows the project, but we resolve skills + brand-kit from
// the editor directory layout that does not move.
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = path.resolve(HERE, '../../..');  // PikaAgentEditor/
const PIKA_ROOT = path.resolve(EDITOR_ROOT, '..');    // PikaAgent/

const SKILL_ROOT = path.join(EDITOR_ROOT, '.claude', 'skills');
const BRAND_ROOT = path.join(PIKA_ROOT, 'brand-kit');
const TMP_ROOT = path.join(PIKA_ROOT, 'tmp');

export interface ResolvedPath {
  abs: string;
  writable: boolean;
  root: 'project' | 'skills' | 'brand-kit' | 'tmp';
}

export function resolveSafe(input: string): ResolvedPath {
  if (!input || typeof input !== 'string') throw new Error('path required');
  // Strip leading ./
  const trimmed = input.replace(/^\.\//, '');
  // Resolve relative paths against the active project
  const abs = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(paths.project, trimmed);
  // realpath if it exists, to defeat symlink escapes; otherwise use the resolved string
  const probe = existsSync(abs) ? realpathSync(abs) : abs;

  if (isUnder(probe, paths.project)) return { abs, writable: true, root: 'project' };
  if (isUnder(probe, TMP_ROOT))      return { abs, writable: true, root: 'tmp' };
  if (isUnder(probe, SKILL_ROOT))    return { abs, writable: false, root: 'skills' };
  if (isUnder(probe, BRAND_ROOT))    return { abs, writable: false, root: 'brand-kit' };

  throw new Error(
    `path is outside the agent sandbox: ${input}\n` +
    `allowed roots:\n  ${paths.project}\n  ${SKILL_ROOT}\n  ${BRAND_ROOT}\n  ${TMP_ROOT}`
  );
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function relForDisplay(abs: string): string {
  const r = path.relative(paths.project, abs);
  if (!r.startsWith('..')) return r || '.';
  // Outside the project — show editor-root-relative
  const e = path.relative(EDITOR_ROOT, abs);
  if (!e.startsWith('..')) return e;
  return abs;
}

const DENY_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-r[a-z]*\s+(\/|~|\$HOME)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.+of=\/dev\//i,
  /:\(\)\s*{\s*:\|:&\s*}\s*;/,  // fork bomb
  /\bcurl\s+[^|]*\|\s*(sh|bash|zsh)/i,
  /\bwget\s+[^|]*\|\s*(sh|bash|zsh)/i,
  /\bchmod\s+[+-]?[0-7]*7[0-7]*\s+\//i,  // mass chmod on /
];

export function checkBashCommand(command: string): { ok: true } | { ok: false; reason: string } {
  for (const re of DENY_BASH_PATTERNS) {
    if (re.test(command)) return { ok: false, reason: `blocked pattern: ${re.source}` };
  }
  return { ok: true };
}
