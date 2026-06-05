/**
 * Skill index loader.
 *
 * Scans .claude/skills/*​/SKILL.md, parses the YAML frontmatter, and returns a
 * compact block we inject into the system prompt. The agent reads the full
 * SKILL.md on demand via the read_file tool — same progressive-disclosure
 * pattern Claude Code uses.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(HERE, '../../../.claude/skills');

interface SkillEntry {
  name: string;
  path: string;
  description: string;
}

let cache: { mtime: number; entries: SkillEntry[] } | null = null;

export function getSkillIndex(): SkillEntry[] {
  if (!existsSync(SKILL_ROOT)) return [];
  // Cache invalidates whenever the skills directory mtime moves
  const dirMtime = statSync(SKILL_ROOT).mtimeMs;
  if (cache && cache.mtime === dirMtime) return cache.entries;

  const entries: SkillEntry[] = [];
  for (const name of readdirSync(SKILL_ROOT)) {
    const skillDir = path.join(SKILL_ROOT, name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const text = readFileSync(skillFile, 'utf8');
    const fm = parseFrontmatter(text);
    entries.push({
      name: fm.name ?? name,
      path: skillFile,
      description: fm.description ?? '',
    });
  }
  cache = { mtime: dirMtime, entries };
  return entries;
}

function parseFrontmatter(src: string): { name?: string; description?: string } {
  if (!src.startsWith('---')) return {};
  const end = src.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = src.slice(3, end);
  const out: { name?: string; description?: string } = {};
  // Handles three YAML shapes we see in the wild:
  //   single-line:   `description: "..."` / `description: ...`
  //   folded scalar: `description: >` / `description: >-` followed by
  //                  indented continuation lines (one paragraph, joined
  //                  by spaces — strip-chomp `-` just suppresses the
  //                  trailing newline)
  //   literal block: `description: |` / `description: |-` followed by
  //                  indented continuation (joined by newlines)
  //
  // Without continuation support, ~75% of bundled SKILL.md files report
  // `description: >` (the literal indicator) as the entire description
  // and the agent's skill-index advertises an empty entry. That's the
  // bug found by the PR #4 review.
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1] as 'name' | 'description';
    let val = m[2].trim();
    // Folded (>) or literal (|) block scalar — gather indented
    // continuation lines until we hit a top-level key or the end.
    const blockIndicator = val.match(/^([>|])([-+]?)\s*$/);
    if (blockIndicator) {
      const fold = blockIndicator[1] === '>';
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        // Stop on next top-level key (un-indented `key:` line) or
        // blank line followed by un-indented content.
        if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(next)) break;
        // Strip the leading indent (2 spaces is the YAML convention
        // produced by most tooling, but be lenient — any leading
        // whitespace counts as part of the block).
        const stripped = next.replace(/^\s+/, '');
        parts.push(stripped);
      }
      val = fold
        ? parts.filter((p) => p.length > 0).join(' ').trim()
        : parts.join('\n').trim();
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function getSkillIndexBlock(): string {
  const entries = getSkillIndex();
  if (entries.length === 0) return '';
  const lines = entries.map((e) =>
    `- **${e.name}** (${path.relative(path.resolve(HERE, '../../..'), e.path)}): ${e.description}`,
  );
  return [
    'Available skills (read the full SKILL.md when relevant — they are the canonical contract for the named workflow):',
    ...lines,
  ].join('\n');
}

/**
 * Demo preload.
 *
 * This branch (`demo-mode`) is the demo build. The full body of selected
 * pika-plugin skills is inlined straight into the system prompt so the
 * agent can react to triggers instantly without a read_file roundtrip.
 *
 * Sources, in order:
 *   1. `git show origin/main:skills/<slug>/SKILL.md` against the installed
 *      pika-plugins marketplace clone — so published skills always reflect
 *      the latest from the real Pika plugin, not a baked-in copy.
 *   2. The locally-installed plugin cache (newest pika version on disk).
 *      Picks up custom skills the user dropped into the cache that haven't
 *      shipped to origin/main yet.
 *
 * Skill list defaults to "ugc-ads,app-sizzle,short-ads"; override with
 * PIKA_DEMO_SKILLS (comma-separated) if you want a different set.
 */
const PIKA_PLUGINS_REPO = path.join(os.homedir(), '.claude/plugins/marketplaces/pika-plugins');
const PIKA_PLUGINS_CACHE = path.join(os.homedir(), '.claude/plugins/cache/pika-plugins/pika');
let demoBlockCache: string | null = null;
let demoFetched = false;

function latestCachedPluginDir(): string | null {
  if (!existsSync(PIKA_PLUGINS_CACHE)) return null;
  const versions = readdirSync(PIKA_PLUGINS_CACHE).filter((n) =>
    existsSync(path.join(PIKA_PLUGINS_CACHE, n, 'skills')),
  );
  if (versions.length === 0) return null;
  // Semver-aware sort so "1.10.0" ranks above "1.9.0" (a lexical sort would
  // pick 1.9.0 as newest once the minor/patch reaches double digits).
  versions.sort((a, b) => {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    return (pa[0] - pb[0]) || (pa[1] - pb[1]) || ((pa[2] ?? 0) - (pb[2] ?? 0));
  });
  return path.join(PIKA_PLUGINS_CACHE, versions[versions.length - 1]);
}

// Skill slugs become path components (git pathspec + filesystem path), so
// constrain them to a safe charset before use — blocks `../` traversal that
// could otherwise read an arbitrary file into the system prompt.
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/i;

function loadSkillBody(slug: string): string | null {
  if (!SAFE_SLUG.test(slug)) {
    console.warn(`[demo] skipping invalid skill slug: ${JSON.stringify(slug)}`);
    return null;
  }
  if (existsSync(PIKA_PLUGINS_REPO)) {
    if (!demoFetched) {
      try {
        execFileSync('git', ['-C', PIKA_PLUGINS_REPO, 'fetch', 'origin', '--quiet'], {
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 15_000,
        });
      } catch (err) {
        console.warn('[demo] git fetch origin failed (offline?) — using cached pika-plugins refs', err);
      }
      demoFetched = true;
    }
    try {
      return execFileSync(
        'git',
        ['-C', PIKA_PLUGINS_REPO, 'show', `origin/main:skills/${slug}/SKILL.md`],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      // Fall through to local cache — skill isn't in origin/main (custom / unreleased).
    }
  }
  const cacheDir = latestCachedPluginDir();
  if (cacheDir) {
    const file = path.join(cacheDir, 'skills', slug, 'SKILL.md');
    if (existsSync(file)) {
      console.log(`[demo] pika:${slug} loaded from local plugin cache (${cacheDir})`);
      return readFileSync(file, 'utf8');
    }
  }
  return null;
}

export function getDemoPreloadBlock(): string {
  if (demoBlockCache !== null) return demoBlockCache;

  // Demo preload is OPT-IN. Default `npm run dev` behaves exactly like
  // pre-demo-mode main: no preloaded skill bodies, and no "one gen per turn"
  // hard rule that would otherwise contradict the base system prompt's
  // parallel-generation policy (chat.ts). The `dev:demo*` scripts set
  // PIKA_DEMO_MODE=1 to enable it; setting PIKA_DEMO_SKILLS explicitly also
  // enables it. This keeps demo behavior available without regressing the
  // default editor experience.
  const enabled = !!process.env.PIKA_DEMO_MODE || process.env.PIKA_DEMO_SKILLS !== undefined;
  if (!enabled) {
    demoBlockCache = '';
    return demoBlockCache;
  }

  const list = (process.env.PIKA_DEMO_SKILLS ?? 'ugc-ads,app-sizzle,short-ads')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const sections: string[] = [];
  for (const slug of list) {
    const body = loadSkillBody(slug);
    if (body) {
      sections.push(`### Preloaded skill: pika:${slug}\n\n${body.trim()}`);
    } else {
      console.warn(`[demo] could not load pika:${slug} from origin/main or local cache`);
    }
  }

  if (sections.length === 0) {
    demoBlockCache = '';
    return demoBlockCache;
  }

  demoBlockCache = [
    '═══════════════════════════════════════════════════════════════',
    'DEMO MODE — PRELOADED PIKA SKILLS',
    '═══════════════════════════════════════════════════════════════',
    '',
    'The full SKILL.md text for the skills below is already in this prompt. When the user triggers one (matching its description), execute it immediately — do NOT call read_file on its SKILL.md, you already have it.',
    '',
    'TURN HANDOVER (hard rule — overrides anything in the skill bodies below):',
    'You have the full skill roadmap upfront, but you MUST still run skills as a sequence of short turns, not one giant turn. After each pika_generate_* tool call returns `[QUEUED]`, end your turn with a one-liner ("kicked off act 1 — watch the workspace") so the server can run it in the background and the user can interject. Resume the next step on the next turn (the user typing "go", a comment landing, or an SSE gen-done event). Never chain multiple pika_generate_* calls in one turn. Multi-step skills (HOOK + 3 JUMP CUTs + OUTRO etc.) span multiple chat turns, not one.',
    '',
    sections.join('\n\n---\n\n'),
    '',
    '═══════════════════════════════════════════════════════════════',
  ].join('\n');
  return demoBlockCache;
}
