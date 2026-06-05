/**
 * Pika credit-balance polling.
 *
 * The MCP server exposes `identity_balance` — a cheap nova3 hop returning
 * the current credit wallet. We call it on a slow background interval AND
 * opportunistically after every gen so the UI always shows fresh numbers
 * without burdening the user (or the agent) with running the query.
 *
 * Server-owned by design: the agent does NOT decide when to refresh. If
 * the user reaches for the topbar credit pill, the value is already there
 * (cached). Reconciler-style invariant: the displayed balance is never
 * older than `MAX_AGE_MS`.
 */
import { events } from '../events.js';
import { callPikaTool } from './pika-mcp.js';
import { isAuthenticated as isPikaAuthenticated } from './pika-auth.js';

export interface PikaCredits {
  balanceCredits: number | null;
  balanceUsd: number | null;
  walletKind: string | null;
  walletId: string | null;
  fetchedAt: number;          // wall clock at last successful fetch
  staleAt?: number;           // when fetchedAt + MAX_AGE_MS expires
  error?: string;             // last fetch error (if any)
}

const POLL_INTERVAL_MS = 60_000;     // foreground refresh cadence
const POST_GEN_DELAY_MS = 3_000;     // wait a beat after a gen before re-fetching
const MAX_AGE_MS = 5 * 60_000;       // anything older is flagged stale to UI

let cache: PikaCredits = {
  balanceCredits: null,
  balanceUsd: null,
  walletKind: null,
  walletId: null,
  fetchedAt: 0,
};
let pollTimer: ReturnType<typeof setInterval> | null = null;
let postGenTimer: ReturnType<typeof setTimeout> | null = null;
let inflight = false;

/** Returns the current cached balance. Always returns immediately —
 *  the freshness signal is the `fetchedAt` timestamp + the optional
 *  `error` field. */
export function getCachedCredits(): PikaCredits {
  return { ...cache, staleAt: cache.fetchedAt > 0 ? cache.fetchedAt + MAX_AGE_MS : undefined };
}

/** Pull a fresh balance from Pika. Best-effort: failures update the
 *  `error` field but never throw, so callers (poller, post-gen hook)
 *  can fire-and-forget. */
export async function refreshCredits(): Promise<PikaCredits> {
  if (!isPikaAuthenticated()) {
    cache = { ...cache, error: 'pika not connected' };
    return cache;
  }
  if (inflight) return cache;
  inflight = true;
  try {
    const result = await callPikaTool('pika_identity_balance', {});
    inflight = false;
    if (result.error) {
      cache = { ...cache, error: result.content.slice(0, 200), fetchedAt: cache.fetchedAt };
      events.broadcast({ type: 'pika-credits', credits: getCachedCredits() } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      return cache;
    }
    // Pika's response is text inside the tool result. Parse the JSON
    // payload — we expect a JSON object somewhere in the text.
    const text = result.content;
    let parsed: { balance_credits?: number; balance_usd?: number; wallet_kind?: string; wallet_id?: string } | null = null;
    try {
      // The MCP result is typically a single JSON object preceded by a
      // status line. Match the FIRST top-level `{ … }` we can parse.
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {
      // Fall through with parse-error captured in `error`
    }
    if (!parsed) {
      cache = { ...cache, error: `unparseable identity_balance response: ${text.slice(0, 200)}`, fetchedAt: cache.fetchedAt };
    } else {
      cache = {
        balanceCredits: typeof parsed.balance_credits === 'number' ? parsed.balance_credits : null,
        balanceUsd:     typeof parsed.balance_usd === 'number'     ? parsed.balance_usd     : null,
        walletKind:     parsed.wallet_kind ?? null,
        walletId:       parsed.wallet_id ?? null,
        fetchedAt:      Date.now(),
        error:          undefined,
      };
    }
    events.broadcast({ type: 'pika-credits', credits: getCachedCredits() } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    return cache;
  } catch (err) {
    inflight = false;
    cache = { ...cache, error: String((err as Error)?.message ?? err).slice(0, 200) };
    events.broadcast({ type: 'pika-credits', credits: getCachedCredits() } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    return cache;
  }
}

/** Kick off background polling. Idempotent — calling again is a no-op.
 *  Called on server boot AND on pika-auth-changed → connected. */
export function startCreditsPolling(): void {
  if (pollTimer) return;
  // Fire once immediately so the UI shows a value within the first
  // ~second instead of waiting POLL_INTERVAL_MS for the first tick.
  void refreshCredits().catch(() => { /* logged in error field */ });
  pollTimer = setInterval(() => {
    void refreshCredits().catch(() => { /* logged in error field */ });
  }, POLL_INTERVAL_MS);
}

export function stopCreditsPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Schedule a credit refresh shortly after a gen finishes, so the
 *  topbar pill ticks down right when the user expects it to. Debounced
 *  via `postGenTimer` so a batch of N parallel gens triggers ONE
 *  refetch, not N. */
export function scheduleCreditsRefreshAfterGen(): void {
  if (postGenTimer) clearTimeout(postGenTimer);
  postGenTimer = setTimeout(() => {
    postGenTimer = null;
    void refreshCredits().catch(() => { /* swallowed; field already captured */ });
  }, POST_GEN_DELAY_MS);
}
