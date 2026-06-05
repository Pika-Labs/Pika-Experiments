/**
 * In-memory buffer of recent gen completions / failures.
 *
 * The agent doesn't own gen state — the server does. But when the agent
 * gets its NEXT user turn, it should know "in the meantime, these gens
 * landed and these failed" without having to call a tool to discover it.
 * That's what this buffer is for.
 *
 * Flow:
 *   - `finishLiveGen` (pika-mcp.ts) calls `recordGenEvent(...)` on every
 *     terminal status (done / error).
 *   - `/chat/stream` (routes/chat.ts) calls `drainGenEvents()` at the start
 *     of every user turn, prepends a tiny structured block to the user's
 *     message text, and the agent reads it as "FYI" context.
 *
 * Bounded: at most MAX_BUFFERED events stick around. If the server runs
 * for hours with no chat turns, old events drop off — the buffer is a
 * "since last turn" delta, not a permanent log. Gen state on disk
 * (timeline.json + workspace.json) remains the authoritative record.
 *
 * No persistence: a server restart clears the buffer. That's intentional —
 * resumePendingGens picks up in-flight task_ids and re-broadcasts terminal
 * status when they finish; the buffer just won't have the brief window
 * between "gen finished while server was down" and the user's next turn,
 * which is rare and not load-bearing.
 */

export interface GenEvent {
  /** Our internal gen id (e.g. gen_4_mpfo0kmv) */
  genId: string;
  /** When set, the scene this gen was bound to */
  sceneId: string | null;
  /** When set, the workspace tile this gen was bound to (image gens) */
  tileId: string | null;
  /** Friendly name pulled from scene.labels[0] or tile.label when available.
   *  Fallback to sceneId/tileId. Used for human-readable summaries. */
  label: string | null;
  /** Which generate_* tool produced this event */
  tool: string;
  /** Terminal status — only 'done' or 'error' ever land here. */
  status: 'done' | 'error';
  /** Short error string when status==='error'. Truncated to ~200 chars. */
  errorMessage?: string;
  /** Timestamp (ms since epoch) when the event was recorded. */
  at: number;
}

const MAX_BUFFERED = 20;

const buffer: GenEvent[] = [];

export function recordGenEvent(ev: Omit<GenEvent, 'at'>): void {
  buffer.push({ ...ev, at: Date.now() });
  // Trim oldest if we overflow. Chat turns happen often enough that this
  // is rarely the limit; the cap exists so a very long-running server
  // without chat doesn't grow the buffer unbounded.
  while (buffer.length > MAX_BUFFERED) buffer.shift();
}

/** Empty the buffer, returning everything in chronological order. */
export function drainGenEvents(): GenEvent[] {
  const out = buffer.slice();
  buffer.length = 0;
  return out;
}

/** Read without draining — for debugging endpoints. */
export function peekGenEvents(): GenEvent[] {
  return buffer.slice();
}

/**
 * Format the drained event list into a short structured block to prepend
 * to the user's chat message. Designed to be skim-friendly and agent-
 * actionable: one event per line, status icon, scene id, optional error.
 *
 * Returns an empty string when there's nothing to report — caller should
 * treat that as "no prepend".
 */
export function formatGenEventsForAgent(events: GenEvent[]): string {
  if (events.length === 0) return '';
  const lines = events.map((ev) => {
    const target = ev.label ?? ev.sceneId ?? ev.tileId ?? ev.genId;
    if (ev.status === 'done') return `- ✓ ${target} · ready`;
    const err = ev.errorMessage ? ` · ${ev.errorMessage.slice(0, 160)}` : '';
    return `- ✗ ${target} · failed${err}`;
  }).join('\n');
  return [
    `[Pika gen updates since your last turn — FYI, only mention if relevant to what the user is asking]`,
    lines,
    ``,
  ].join('\n');
}
