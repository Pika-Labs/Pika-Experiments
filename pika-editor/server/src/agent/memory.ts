/**
 * Per-project conversation memory.
 *
 * Each project gets a `.agent/memory.jsonl` file under its directory. Every
 * message (user, assistant, tool-result user-turn) is one JSON line. We load
 * on first chat request per project, append on each completed turn, and reset
 * on /chat/reset.
 *
 * No automatic compaction yet — if the file exceeds MAX_BYTES we drop the
 * oldest turns. The Claude API's built-in compaction beta is the longer-term
 * fix; for the launch we just cap the disk footprint.
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';

const MAX_BYTES = 5 * 1024 * 1024;   // 5MB before we rotate
const KEEP_TAIL_FRACTION = 0.5;       // when rotating, keep the most-recent half

function memPath(projectDir: string): string {
  return path.join(projectDir, '.agent', 'memory.jsonl');
}

function ensureDir(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
}

export function loadConv(projectDir: string): Anthropic.MessageParam[] {
  const file = memPath(projectDir);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  const out: Anthropic.MessageParam[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  // Trim any trailing unstable boundary (e.g. assistant turn with tool_use
  // but no matching tool_result, or a stray user-tool_result without a
  // preceding tool_use). The API 400s on these — better to lose a half-turn
  // than to make every future request fail.
  while (out.length > 0 && !isStableTail(out)) out.pop();
  // Rewrite the file if we had to trim, so subsequent boots see clean state
  if (out.length !== raw.split('\n').filter((l) => l.trim()).length) {
    writeFileSync(file, out.map((m) => JSON.stringify(m)).join('\n') + (out.length ? '\n' : ''));
  }
  return out;
}

function isStableTail(conv: Anthropic.MessageParam[]): boolean {
  if (conv.length === 0) return true;
  const last = conv[conv.length - 1];
  if (last.role === 'assistant') {
    const blocks = Array.isArray(last.content) ? last.content : [];
    // Assistant turn is a stable boundary only if it has no pending tool_use
    return !blocks.some((b) => (b as { type?: string }).type === 'tool_use');
  }
  // last.role === 'user'
  // If it's a plain user message, that's stable (a request waiting for a response)
  if (typeof last.content === 'string') return true;
  const blocks = last.content;
  // If it's a tool_result-bearing user message, the previous turn must be an
  // assistant with matching tool_use ids
  const resultIds = new Set(
    blocks.filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result').map((b) => b.tool_use_id),
  );
  if (resultIds.size === 0) return true;
  if (conv.length < 2) return false;
  const prev = conv[conv.length - 2];
  if (prev.role !== 'assistant' || !Array.isArray(prev.content)) return false;
  const useIds = new Set(
    prev.content.filter((b): b is Anthropic.ToolUseBlock => (b as { type?: string }).type === 'tool_use').map((b) => b.id),
  );
  // Every tool_use must have a corresponding tool_result
  for (const id of useIds) if (!resultIds.has(id)) return false;
  return true;
}

export function appendMessages(projectDir: string, msgs: Anthropic.MessageParam[]): void {
  if (msgs.length === 0) return;
  const file = memPath(projectDir);
  ensureDir(file);
  const payload = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
  appendFileSync(file, payload);
  maybeRotate(file);
}

export function resetConv(projectDir: string): void {
  const file = memPath(projectDir);
  if (!existsSync(file)) return;
  writeFileSync(file, '');
}

/**
 * Per-request overhead the API counts against the 1M cap but which
 * lives OUTSIDE the conv buffer:
 *   - System prompt with skill index: ~20-40K tokens
 *   - Tool definitions (every local tool + every Pika MCP tool's
 *     full JSON schema): ~250-400K tokens when Pika is connected
 * 350K is a conservative average — slightly over-reports when Pika
 * isn't connected, but the meter's job is to keep the user safe, so
 * leaning conservative is correct.
 */
const FIXED_REQUEST_OVERHEAD_TOKENS = 350_000;

/** Rough char-to-token estimate for the conversation buffer. JSON.stringify
 *  the entire block so we catch every field (text, tool_use.input,
 *  tool_result.content including nested image blocks with base64
 *  source.data, thinking.thinking, redacted_thinking.data, etc.) —
 *  earlier versions enumerated specific fields and silently missed
 *  base64 image data, leading to "estimate says 300K but API sees
 *  1M+" surprises. The JSON field-name overhead is slight and the
 *  3.8 char/token divisor leans conservative. The fixed-overhead
 *  add captures system + tools cost so the meter reflects what the
 *  API will actually count, not just what's in the messages array. */
export function estimateConvTokens(conv: Anthropic.MessageParam[]): number {
  let chars = 0;
  for (const m of conv) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const block of m.content) {
      chars += JSON.stringify(block).length;
    }
  }
  return Math.ceil(chars / 3.8) + FIXED_REQUEST_OVERHEAD_TOKENS;
}

/** Truncate the conversation from the front, dropping whole "turns" at
 *  a time, until the remaining buffer is under `targetTokens`. A turn
 *  starts at a plain-text user message (no tool_result blocks), so
 *  the trimmed conv always begins on a clean boundary — no orphaned
 *  tool_use → tool_result pairings to 400 the next API call.
 *
 *  Used when the conversation has grown past the 1M context window
 *  (the API itself can't compact past that point — the request can't
 *  be sent). Loses earliest context; recent turns stay verbatim, so
 *  the agent retains in-progress work. Persists to disk + returns
 *  before/after stats so the UI can confirm.
 *
 *  No-op if the conv is already under target. */
export function compactConv(projectDir: string, conv: Anthropic.MessageParam[], targetTokens: number): {
  trimmed: Anthropic.MessageParam[];
  beforeTokens: number;
  afterTokens: number;
  droppedMessages: number;
} {
  const beforeTokens = estimateConvTokens(conv);
  if (beforeTokens <= targetTokens) {
    return { trimmed: conv, beforeTokens, afterTokens: beforeTokens, droppedMessages: 0 };
  }
  // Find turn-start indices — plain-text user messages.
  const turnStarts: number[] = [];
  for (let i = 0; i < conv.length; i++) {
    if (conv[i].role !== 'user') continue;
    const c = conv[i].content;
    const isPlain = typeof c === 'string'
      || (Array.isArray(c) && !c.some((b) => (b as { type?: string }).type === 'tool_result'));
    if (isPlain) turnStarts.push(i);
  }
  // Walk turn-by-turn from the start, dropping until under target. Always
  // keep at least the last turn-start so the conv isn't empty.
  let dropTo = 0;
  for (let i = 1; i < turnStarts.length; i++) {
    const remaining = conv.slice(turnStarts[i]);
    if (estimateConvTokens(remaining) <= targetTokens) {
      dropTo = turnStarts[i];
      break;
    }
    dropTo = turnStarts[i];
  }
  const trimmed = conv.slice(dropTo);
  // Rewrite the on-disk log so subsequent boots see the trimmed state.
  const file = memPath(projectDir);
  ensureDir(file);
  writeFileSync(file, trimmed.map((m) => JSON.stringify(m)).join('\n') + (trimmed.length ? '\n' : ''));
  return {
    trimmed,
    beforeTokens,
    afterTokens: estimateConvTokens(trimmed),
    droppedMessages: dropTo,
  };
}

function maybeRotate(file: string): void {
  try {
    const s = statSync(file);
    if (s.size <= MAX_BYTES) return;
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const keep = lines.slice(Math.floor(lines.length * (1 - KEEP_TAIL_FRACTION)));
    writeFileSync(file, keep.join('\n') + '\n');
  } catch { /* ignore */ }
}
