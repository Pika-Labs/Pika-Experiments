/**
 * Agent runtime config — currently the Anthropic API key + the active
 * Claude model. The key lives in `server/.env` (already loaded into
 * `process.env` by dotenv at server boot) and never leaves the server.
 * The model lives in `server/agent-config.json` next to the .env so it
 * survives restarts; we load it once at module import and expose a
 * thin getter the chat route reads on every turn.
 *
 * Security model:
 *   - The client never receives the API key. /agent/config returns
 *     `{ hasKey: boolean }` so the UI can show a BYOK pill or the
 *     model selector accordingly.
 *   - The /agent/config POST route accepts a new key in the request
 *     body, writes it to `server/.env` atomically, AND mirrors it into
 *     `process.env.ANTHROPIC_API_KEY` so the change takes effect
 *     without a server restart.
 *   - Model changes are pure JSON file writes — no secrets involved.
 *
 * The .env writer is conservative: it preserves all OTHER lines in
 * the file (other env vars, comments) and only replaces or appends
 * the single `ANTHROPIC_API_KEY=...` line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, '../..');
const ENV_PATH = path.join(SERVER_ROOT, '.env');
const CONFIG_PATH = path.join(SERVER_ROOT, 'agent-config.json');

export const DEFAULT_MODEL = 'claude-opus-4-7';

/** The list of Claude models the UI lets the user pick. Mirrors the
 *  claude-api skill's "Current Models" table. Display name → API id. */
export const AVAILABLE_MODELS: { id: string; label: string; tier: 'opus' | 'sonnet' | 'haiku' }[] = [
  { id: 'claude-opus-4-7',   label: 'Opus 4.7',   tier: 'opus' },
  { id: 'claude-opus-4-6',   label: 'Opus 4.6',   tier: 'opus' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet' },
  { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  tier: 'haiku' },
];

interface PersistedConfig {
  model?: string;
}

function loadPersisted(): PersistedConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const j = JSON.parse(raw) as PersistedConfig;
    if (j && typeof j === 'object') return j;
  } catch {/* no file yet — fine */}
  return {};
}

let currentModel: string = (() => {
  const p = loadPersisted();
  if (p.model && AVAILABLE_MODELS.some((m) => m.id === p.model)) return p.model;
  return DEFAULT_MODEL;
})();

export function getModel(): string {
  return currentModel;
}

export function hasApiKey(): boolean {
  return hasEnvKey('ANTHROPIC_API_KEY');
}
export function hasOpenAIKey(): boolean {
  return hasEnvKey('OPENAI_API_KEY');
}
function hasEnvKey(name: string): boolean {
  const k = process.env[name];
  return typeof k === 'string' && k.trim().length > 0;
}

/** Atomic write — staged tempfile + rename so a crash mid-write
 *  doesn't corrupt the .env. */
function atomicWrite(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Generic .env writer — replace or append a single KEY=value line,
 *  preserving every other line. Mirrors the change into process.env so
 *  the running server picks it up without a restart. */
function setEnvKey(name: string, rawValue: string): { ok: boolean; error?: string } {
  const value = rawValue.trim();
  if (!value) return { ok: false, error: 'empty value' };
  if (value.includes(' ') || value.includes('\n')) return { ok: false, error: 'value contains whitespace' };

  let existing = '';
  try { existing = fs.readFileSync(ENV_PATH, 'utf8'); } catch {/* new file — fine */}

  const re = new RegExp(`^\\s*${name}\\s*=`);
  const lines = existing.split('\n');
  let replaced = false;
  const out = lines.map((line) => {
    if (re.test(line)) {
      replaced = true;
      return `${name}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(`${name}=${value}`);
  }
  let next = out.join('\n');
  if (!next.endsWith('\n')) next += '\n';

  try { atomicWrite(ENV_PATH, next); }
  catch (e: any) { return { ok: false, error: e?.message ?? 'write failed' }; }
  process.env[name] = value;
  return { ok: true };
}

function clearEnvKey(name: string): { ok: boolean; error?: string } {
  let existing = '';
  try { existing = fs.readFileSync(ENV_PATH, 'utf8'); } catch { return { ok: true }; }
  const re = new RegExp(`^\\s*${name}\\s*=`);
  const out = existing.split('\n').filter((line) => !re.test(line)).join('\n');
  try { atomicWrite(ENV_PATH, out.endsWith('\n') ? out : out + '\n'); }
  catch (e: any) { return { ok: false, error: e?.message ?? 'write failed' }; }
  delete process.env[name];
  return { ok: true };
}

/** Anthropic key — used by /chat/stream. */
export function setApiKey(rawKey: string): { ok: boolean; error?: string } {
  return setEnvKey('ANTHROPIC_API_KEY', rawKey);
}
export function clearApiKey(): { ok: boolean; error?: string } {
  return clearEnvKey('ANTHROPIC_API_KEY');
}

/** OpenAI key — used by /voice/session (realtime-API ephemeral key mint).
 *  Kept independent of the Anthropic key so the user can run text-chat
 *  without ever providing an OpenAI key. */
export function setOpenAIKey(rawKey: string): { ok: boolean; error?: string } {
  return setEnvKey('OPENAI_API_KEY', rawKey);
}
export function clearOpenAIKey(): { ok: boolean; error?: string } {
  return clearEnvKey('OPENAI_API_KEY');
}

export function setModel(id: string): { ok: boolean; error?: string } {
  if (!AVAILABLE_MODELS.some((m) => m.id === id)) {
    return { ok: false, error: `unknown model: ${id}` };
  }
  currentModel = id;
  try {
    const j: PersistedConfig = { ...loadPersisted(), model: id };
    atomicWrite(CONFIG_PATH, JSON.stringify(j, null, 2));
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'write failed' };
  }
  return { ok: true };
}
