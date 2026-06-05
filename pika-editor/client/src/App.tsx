import { useEffect, useRef } from 'react';
import { useStore, flushPendingSave, hasPendingSave } from './store';
import { subscribeServerEvents } from './sse';
import { useGlobalHotkeys } from './hotkeys';
import { Topbar } from './components/Topbar';
import { Library } from './components/Library';
import { Stage } from './components/Stage';
import { ChatPanel } from './components/ChatPanel';
import { Launcher } from './components/Launcher';
import type { AgentAction } from './types';

export default function App() {
  const { timeline, loading, error, load, applyServerTimeline } = useStore();
  const chatStarted = useStore((s) => s.chatStarted);

  useGlobalHotkeys();
  useEffect(() => { void load(); }, [load]);

  // Tool-driven body class so cursors change per active tool. Premiere does
  // the same — selecting the Razor flips the cursor to a razor blade
  // everywhere over the timeline so you always know which tool is live.
  const tool = useStore((s) => s.tool);
  useEffect(() => {
    const cls = `tool-${tool}`;
    document.body.classList.add(cls);
    return () => document.body.classList.remove(cls);
  }, [tool]);

  // Window-level dragover + drop fallback. Without these, dropping a file
  // OUTSIDE the timeline drop zone makes the browser navigate to the file
  // (opening a new tab). Calling preventDefault on dragover lets the drop
  // event fire elsewhere; preventDefault on drop blocks the default nav.
  useEffect(() => {
    function preventNav(e: DragEvent) {
      // Only intercept file drags — leave other dnd (text/etc) alone
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    }
    window.addEventListener('dragover', preventNav);
    window.addEventListener('drop', preventNav);
    return () => {
      window.removeEventListener('dragover', preventNav);
      window.removeEventListener('drop', preventNav);
    };
  }, []);

  // Reload coalescer. Multiple SSE timeline-changed events fired in quick
  // succession (e.g. burst of agent edits) collapse to a single fetch:
  // we mark "reload needed" and let the in-flight fetch settle before
  // launching another. Replaces the old polling-loop deferred-reload,
  // which had a race where the save could clear between the poll's
  // scheduling and its first tick — the deferred reload never fired and
  // the user had to hard-refresh.
  const reloadPendingRef = useRef(false);
  const reloadInFlightRef = useRef(false);

  // Hydrate the live-gen store on mount AND poll every 5s so a tab
  // opened/refreshed mid-gen sees the in-flight state immediately,
  // not just the next SSE tick. Cheap GET; matches the pattern the
  // workspace card used to do locally.
  useEffect(() => {
    let cancelled = false;
    async function hydrate(): Promise<void> {
      try {
        const { getActivePikaGens } = await import('./api');
        const gens = await getActivePikaGens();
        if (!cancelled) useStore.getState().setPikaLiveGens(gens);
      } catch { /* offline */ }
      // Also fetch the reconciler-health snapshot so the topbar
      // indicator renders within the first frame instead of waiting
      // for the next 10s SSE tick.
      try {
        const res = await fetch('/agent/reconciler-health');
        if (res.ok) {
          const { summary } = await res.json() as { summary: unknown };
          if (!cancelled && summary) useStore.getState().setReconcilerHealth(summary);
        }
      } catch { /* offline */ }
    }
    void hydrate();
    const id = window.setInterval(hydrate, 5_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    async function reloadTimeline(): Promise<void> {
      if (reloadInFlightRef.current) {
        // Another SSE while we're fetching — flag, the in-flight call
        // will re-enter when it finishes.
        reloadPendingRef.current = true;
        return;
      }
      reloadInFlightRef.current = true;
      try {
        // If a local save is queued, let it land first so the server
        // doesn't serve us state from before our own edit.
        await flushPendingSave();
        const { getTimeline } = await import('./api');
        const { timeline: t } = await getTimeline();
        // The user can type INTO an input between flushPendingSave()
        // resolving and getTimeline() returning. If they do, the local
        // store is now newer than the fetched server state, and applying
        // `t` would clobber the in-progress keystroke — the "I type a
        // letter and it gets deleted" race in the caption text editor
        // (and every other controlled input). Skip the apply; the
        // pending autosave will eventually fire and trigger its own
        // `timeline-changed` SSE that re-enters here with fresh state.
        if (hasPendingSave()) return;
        applyServerTimeline(t);
      } finally {
        reloadInFlightRef.current = false;
        if (reloadPendingRef.current) {
          reloadPendingRef.current = false;
          // Tail-call: re-enter to pick up changes that arrived during
          // the fetch. Async loop terminates as soon as no new SSE
          // events arrived during the previous fetch window.
          void reloadTimeline();
        }
      }
    }
    return subscribeServerEvents(async (ev) => {
      if (ev.type === 'timeline-changed' || ev.type === 'project-changed') {
        void reloadTimeline();
      } else if (ev.type === 'agent-action' && ev.action) {
        applyAgentAction(ev.action as AgentAction);
      } else if (ev.type === 'asset-added' && ev.relPath) {
        // Bump the per-asset version counter so the next <img src> render
        // includes ?v=N and the browser re-fetches the new bytes instead
        // of serving the cached version of the same path (the "agent
        // regenerated but I still see the old image" bug). We skip the
        // metadata files (workspace.json / plan.json) — they're consumed
        // as JSON by other surfaces, not as cached assets.
        if (!ev.relPath.endsWith('.json')) {
          useStore.getState().bumpAssetVersion(ev.relPath);
        }
      } else if (ev.type === 'pika-live-gen' && ev.gen) {
        // Mirror Pika MCP live-gens into the store so BOTH the workspace
        // tile placeholder AND the timeline V1 clip can render progress
        // from a single subscription, instead of each component spinning
        // up its own.
        useStore.getState().upsertPikaLiveGen(ev.gen as unknown as Parameters<ReturnType<typeof useStore.getState>['upsertPikaLiveGen']>[0]);
      } else if ((ev as { type?: string }).type === 'gen-job') {
        // Canonical lifecycle stream (Phase 1). Stored separately from
        // LiveGen so production surfaces can prefer this, with LiveGen
        // staying for backwards-compatible paths.
        const job = (ev as unknown as { job: unknown }).job;
        if (job) useStore.getState().upsertGenJob(job as Parameters<ReturnType<typeof useStore.getState>['upsertGenJob']>[0]);
      } else if ((ev as { type?: string }).type === 'reconciler-health') {
        // Top-bar health indicator (Phase 3). Summary carries activeJobs,
        // fixed-drift counters, warnings list.
        const summary = (ev as unknown as { summary: unknown }).summary;
        if (summary) useStore.getState().setReconcilerHealth(summary as Parameters<ReturnType<typeof useStore.getState>['setReconcilerHealth']>[0]);
      }
    });
  }, [applyServerTimeline]);

  if (loading && !timeline) return <div className="loading-shell">Loading project…</div>;
  if (error && !timeline) return <div className="loading-shell" style={{ color: '#ff4c62' }}>{error}</div>;
  if (!timeline) return <div className="loading-shell">No timeline yet</div>;

  // Fresh-project gate: when the project has zero scenes AND the user
  // hasn't interacted with chat yet, render the Launcher landing
  // screen instead of the editor. As soon as either condition flips
  // (first scene created OR first chat message sent), the editor
  // mounts and the launcher unmounts. The Topbar + ChatPanel stay
  // mounted in both states so the project switcher, credits pill,
  // and chat input never disappear.
  const isFreshProject = timeline.scenes.length === 0 && !chatStarted;

  return (
    <div className={`app ${isFreshProject ? 'app-launcher-mode' : ''}`}>
      <Topbar />
      {isFreshProject ? (
        <Launcher />
      ) : (
        <>
          <Library />
          <Stage />
          <ChatPanel />
        </>
      )}
    </div>
  );
}

/** Apply an agent-action SSE event to the Zustand store. Unknown kinds are
 *  silently ignored — additive surface stays forward-compatible. */
function applyAgentAction(action: AgentAction): void {
  const s = useStore.getState();
  switch (action.kind) {
    case 'set_view':       s.setView(action.view); break;
    case 'select_clip':
      s.clearSelection();
      // selectClip with additive=true builds up multi-selection; default
      // selectClip replaces the set with [id]. Loop with additive after the
      // first to support multi-select.
      action.ids.forEach((id, i) => s.selectClip(id, i > 0));
      break;
    case 'set_playhead':   s.setPlayhead(action.t); break;
    case 'play_pause':
      if (action.play === undefined) s.togglePlay();
      else s.setPlaying(action.play);
      break;
    case 'set_zoom':       s.setZoom(action.px); break;
    case 'set_tool':       s.setTool(action.tool); break;
    case 'open_modal':
      // Diagnostic — when the modal "won't open" the usual cause is a
      // later agent-action arriving with modal:null and clobbering this.
      // Console will show both events and the order makes it obvious.
      console.log('[agent-action] open_modal →', action.modal);
      s.setOpenModal(action.modal);
      break;
  }
}
