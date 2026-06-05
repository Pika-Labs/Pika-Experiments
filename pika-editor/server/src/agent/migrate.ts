/**
 * One-time migration of ~/.claude/projects/-Users-...-PikaAgent/memory/
 * into the per-project memory store.
 *
 * **Filtered.** The global Claude Code memory accumulates 5 categories
 * of notes over time:
 *   - `user_*` — durable identity (who the user is, role, email). KEEP.
 *   - `reference_*` — durable architecture / API contracts. KEEP.
 *   - `persona_*` — character / voice persona definitions. KEEP.
 *   - `feedback_*` — session-specific corrections from other contexts. SKIP.
 *   - `project_*` — other-project state. SKIP.
 *
 * Without this filter, every new PikaAgentEditor project inherits ~1100
 * lines of rules from unrelated past sessions ("NBA cutaway → Kling
 * default", "HF Studio workflow", "Telka kerning", etc.) — the agent then
 * over-applies those rules to the new project (e.g. picking Kling instead
 * of Seedance for a Pixar rats scene because of a stored NBA-cutaway
 * rule). Filtering to identity + architecture + persona keeps the useful
 * baseline ("you are matan's agent, Pika MCP works like this") without
 * the rule firehose.
 *
 * Idempotent — we drop a sentinel file (.agent/migrated) once we've
 * filtered the Claude Code auto-memory into the new home.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

// Claude Code keys auto-memory by working directory. The user's been running
// Claude Code from /Users/<u>/PikaAgent/, which maps to this path. We inherit
// the curated subset on first chat boot per project.
const CLAUDE_MEM_DIR = path.join(homedir(), '.claude', 'projects', '-Users-matancohengrumi-PikaAgent', 'memory');

/** Filename prefixes we copy over. Anything not on this list is dropped. */
const KEEP_PREFIXES = ['user_', 'reference_', 'persona_'];

function shouldKeep(filename: string): boolean {
  return KEEP_PREFIXES.some((p) => filename.startsWith(p));
}

export function maybeMigrateClaudeMemory(projectDir: string): { migrated: boolean; summary: string } {
  const sentinelPath = path.join(projectDir, '.agent', 'migrated');
  if (existsSync(sentinelPath)) return { migrated: false, summary: '' };
  if (!existsSync(CLAUDE_MEM_DIR)) return { migrated: false, summary: '' };

  const linkedFiles: { name: string; content: string }[] = [];
  try {
    for (const entry of readdirSync(CLAUDE_MEM_DIR)) {
      if (entry === 'MEMORY.md') continue;
      if (!entry.endsWith('.md')) continue;
      if (!shouldKeep(entry)) continue;
      const full = path.join(CLAUDE_MEM_DIR, entry);
      if (!statSync(full).isFile()) continue;
      linkedFiles.push({ name: entry, content: readFileSync(full, 'utf8') });
    }
  } catch { /* ignore */ }

  // Nothing to carry — drop the sentinel so we don't retry every boot,
  // but skip the carry file.
  if (linkedFiles.length === 0) {
    mkdirSync(path.dirname(sentinelPath), { recursive: true });
    writeFileSync(sentinelPath, new Date().toISOString());
    return { migrated: false, summary: '' };
  }

  mkdirSync(path.dirname(sentinelPath), { recursive: true });

  // Mirror the curated subset into a single carry-over file the agent
  // can read on demand. Keep it human-readable so the user can review
  // exactly what was inherited.
  const carryPath = path.join(projectDir, '.agent', 'inherited-memory.md');
  const out = [
    '# Inherited memory',
    `> Curated carry-over from ${CLAUDE_MEM_DIR} on ${new Date().toISOString()}.`,
    `> Includes only ${KEEP_PREFIXES.join(', ')} entries — feedback_* and project_* notes from other contexts are intentionally excluded so they don't bias project-specific decisions.`,
    '',
    ...linkedFiles.flatMap((f) => [`## ${f.name}`, '', f.content.trim(), '']),
  ].join('\n');
  writeFileSync(carryPath, out);
  writeFileSync(sentinelPath, new Date().toISOString());

  const summary = `Inherited ${linkedFiles.length} memory file(s) from Claude Code (user/reference/persona only — feedback + project entries skipped). Full content at .agent/inherited-memory.md.`;
  return { migrated: true, summary };
}
