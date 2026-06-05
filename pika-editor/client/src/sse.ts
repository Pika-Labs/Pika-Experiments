/**
 * Singleton EventSource for /events.
 *
 * Why: each component opening its own `new EventSource('/events')` quickly
 * blows past the browser's per-origin HTTP/1.1 connection limit (6 in
 * Chromium). Once that's saturated, NEW requests — including video <src>
 * fetches — queue forever waiting for a free socket, producing an infinite
 * "loading" state on the preview pane. Vite HMR makes this worse because
 * each module reload mounts fresh subscriptions while the old ones can leak
 * (cleanup doesn't always run before the new mount opens its connection).
 *
 * Solution: one shared EventSource lives for the lifetime of the page. All
 * components register a callback via `subscribe()` and get a `dispose()`
 * back. The connection itself never opens more than once.
 */

import type { ServerEvent } from './types';

type Listener = (ev: ServerEvent) => void;

const listeners = new Set<Listener>();
let es: EventSource | null = null;

function ensureOpen(): void {
  if (es) return;
  es = new EventSource('/events');
  es.addEventListener('message', (msg) => {
    let parsed: ServerEvent;
    try { parsed = JSON.parse(msg.data); } catch { return; }
    for (const fn of listeners) {
      try { fn(parsed); } catch { /* listeners shouldn't throw */ }
    }
  });
  es.onerror = () => {
    // EventSource auto-reconnects; nothing to do here. We don't tear down on
    // error or transient network blips would drop subscribers.
  };
}

/**
 * Subscribe to all SSE messages. Returns a dispose function that removes
 * the listener (and is safe to call multiple times).
 */
export function subscribeServerEvents(fn: Listener): () => void {
  ensureOpen();
  listeners.add(fn);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    listeners.delete(fn);
    // We deliberately do NOT close the EventSource when the last listener
    // unsubscribes — components mount/unmount frequently in dev (HMR), and
    // tearing down + reopening creates the same socket churn we're fixing.
    // The single EventSource is fine to keep alive for the whole session.
  };
}
