import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { Aspect } from '../types';
import { Wordmark } from './Wordmark';
import { RenderResultModal } from './RenderResultModal';
import { RenderModal } from './RenderModal';
import { ProjectsModal } from './ProjectsModal';
import { subscribeServerEvents } from '../sse';
import { useEscapeKey } from '../useEscapeKey';
import * as api from '../api';

function slugify(s: string): string {
  return (s || 'render').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'render';
}

/** Topbar pill showing the current Pika wallet balance. Hydrates from
 *  /pika/credits on mount AND listens to `pika-credits` SSE so it
 *  ticks live as the server's poller / post-gen refresh fires. Hidden
 *  when Pika isn't connected (balance null + error 'pika not
 *  connected'). */
function PikaCreditsPill() {
  const [credits, setCredits] = useState<{ balanceCredits: number | null; balanceUsd: number | null; error?: string; fetchedAt: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      try {
        const r = await fetch('/pika/credits');
        if (!r.ok) return;
        const body = await r.json() as { credits: typeof credits };
        if (!cancelled) setCredits(body.credits);
      } catch { /* offline */ }
    }
    void hydrate();
    const off = subscribeServerEvents((ev) => {
      if ((ev as { type?: string }).type === 'pika-credits') {
        setCredits((ev as unknown as { credits: typeof credits }).credits);
      }
    });
    return () => { cancelled = true; off(); };
  }, []);
  if (!credits || (credits.balanceCredits === null && credits.error)) return null;
  if (credits.balanceCredits === null) return null;
  const formatted = credits.balanceCredits.toLocaleString();
  const usd = credits.balanceUsd != null ? ` · $${credits.balanceUsd.toFixed(2)}` : '';
  const ageMs = credits.fetchedAt > 0 ? Date.now() - credits.fetchedAt : 0;
  const ageNote = ageMs > 5 * 60_000 ? ` (stale, ${Math.round(ageMs / 60_000)}m old)` : '';
  return (
    <span className="pill" title={`Pika credits${usd}${ageNote}`}>
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
      >
        <path d="M13 2 L4 14 L11 14 L10 22 L20 9 L13 9 Z" />
      </svg>
      {formatted}
    </span>
  );
}

/** Aspect-ratio pill that opens an inline dropdown when clicked. The
 *  five supported aspects come from `AspectSchema` in server schema
 *  (16:9, 9:16, 1:1, 4:5, 4:3). Selecting one calls `setAspect` on
 *  the store, which writes through to timeline.json via the standard
 *  autosave loop — Preview / Workspace / render path all read
 *  `timeline.aspect` so the change propagates everywhere without
 *  any further wiring. Closes on outside click or Escape. */
const ASPECT_OPTIONS: Array<{ value: Aspect; label: string; hint: string }> = [
  { value: '16:9', label: '16:9', hint: 'Landscape' },
  { value: '9:16', label: '9:16', hint: 'Vertical' },
  { value: '1:1',  label: '1:1',  hint: 'Square' },
  { value: '4:5',  label: '4:5',  hint: 'Portrait' },
  { value: '4:3',  label: '4:3',  hint: 'Classic' },
];
function AspectBadgeMenu({ current, onPick }: { current: Aspect; onPick: (a: Aspect) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (ev: MouseEvent) => {
      if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="proj-badge-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`proj-badge proj-badge-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Change project aspect ratio"
      >
        {current}
        <span className="proj-badge-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="proj-badge-menu" role="menu">
          {ASPECT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={opt.value === current}
              className={`proj-badge-menu-item${opt.value === current ? ' on' : ''}`}
              onClick={() => { onPick(opt.value); setOpen(false); }}
            >
              <span className="proj-badge-menu-val">{opt.label}</span>
              <span className="proj-badge-menu-hint">{opt.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tiny reconciler-health indicator next to the undo/redo cluster.
 *  Green dot when nothing's drifting; amber when the last 10s tick
 *  self-healed at least one orphan; red when there's an active
 *  warning the reconciler couldn't resolve. Click expands a popover
 *  with the raw summary (helpful when debugging stuck gens). */
function ReconcilerHealthPill() {
  const health = useStore((s) => s.reconcilerHealth) as null | {
    at: number;
    activeJobs: number;
    fixed: { orphanJobs: number; orphanScenes: number; orphanTiles: number; staleCdnRewrites: number };
    warnings: string[];
  };
  if (!health) return null;
  const totalFixed = health.fixed.orphanJobs + health.fixed.orphanScenes + health.fixed.orphanTiles + health.fixed.staleCdnRewrites;
  const tier: 'ok' | 'warn' | 'err' =
    health.warnings.length > 0 ? 'err' :
    totalFixed > 0 ? 'warn' :
    'ok';
  const dotColor = tier === 'ok' ? '#99ef84' : tier === 'warn' ? '#f9b34c' : '#ff4c62';
  const title = [
    `Reconciler — ${tier === 'ok' ? 'healthy' : tier === 'warn' ? 'self-healing' : 'warning'}`,
    `Active gens: ${health.activeJobs}`,
    totalFixed > 0 ? `Last tick fixed: ${totalFixed} drift${totalFixed === 1 ? '' : 's'}` : 'No drift detected',
    health.warnings.length > 0 ? `Warnings:\n  • ${health.warnings.join('\n  • ')}` : '',
  ].filter(Boolean).join('\n');
  return (
    <span
      className="pill icon-only"
      title={title}
      style={{ cursor: 'help' }}
      aria-label={`Reconciler ${tier}`}
    >
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: dotColor, boxShadow: tier !== 'ok' ? `0 0 4px ${dotColor}` : 'none',
      }} />
    </span>
  );
}

export function Topbar() {
  const timeline = useStore((s) => s.timeline);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const openModal = useStore((s) => s.openModal);
  const setOpenModal = useStore((s) => s.setOpenModal);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const showProjects = openModal === 'projects';
  const setShowProjects = (v: boolean) => setOpenModal(v ? 'projects' : null);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<api.Version[]>([]);
  const [renderState, setRenderState] = useState<{ status: 'idle' | 'rendering' | 'done' | 'error'; pct: number; outRel?: string; message?: string }>({ status: 'idle', pct: 0 });
  const [showResult, setShowResult] = useState<{ outRel: string; savedTo: string | null } | null>(null);
  const [showRenderSettings, setShowRenderSettings] = useState(false);

  useEscapeKey(showVersions, () => setShowVersions(false));
  useEscapeKey(showProjects, () => setShowProjects(false));

  // Project list is now lazy-loaded by the ProjectsModal itself, so no need
  // to pre-fetch here.

  useEffect(() => {
    return subscribeServerEvents((ev) => {
      if (ev.type === 'render-progress') setRenderState({ status: 'rendering', pct: ev.pct });
      else if (ev.type === 'render-done') {
        setRenderState({ status: 'done', pct: 100, outRel: ev.outRel });
        setShowResult({ outRel: ev.outRel, savedTo: ev.savedTo ?? null });
      }
      else if (ev.type === 'render-error') setRenderState({ status: 'error', pct: 0, message: ev.message });
    });
  }, []);

  function openRenderSettings() { setShowRenderSettings(true); }
  async function startRender(opts: { filename: string; saveDir: string; preset: 'draft' | 'standard' | 'high' }) {
    setShowRenderSettings(false);
    setRenderState({ status: 'rendering', pct: 0 });
    try { await api.postRender(opts); }
    catch (e: any) { setRenderState({ status: 'error', pct: 0, message: e.message }); }
  }

  async function openVersions() {
    const r = await api.listVersions();
    setVersions(r.versions);
    setShowVersions(true);
  }
  async function doSaveVersion() {
    const name = window.prompt('Save name', `Save ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
    if (!name?.trim()) return;
    const r = await api.saveVersion(name.trim());
    setVersions(r.versions);
  }
  async function doRestoreVersion(sha: string) {
    if (!window.confirm('Restore this version? Current state will be archived as a new commit.')) return;
    await api.restoreVersion(sha);
    const r = await api.listVersions();
    setVersions(r.versions);
    // Force reload of timeline so the UI reflects the restored state.
    const { getTimeline } = await import('../api');
    const { timeline: t } = await getTimeline();
    useStore.getState().applyServerTimeline(t);
  }

  // Count unresolved comments across the timeline (clip + floating) so the
  // topbar can show a "N feedback items waiting for the agent" badge.
  const unresolvedCount = !timeline ? 0 : (
    timeline.tracks.flatMap((tr) => tr.clips).flatMap((c) => c.comments ?? []).filter((cm) => !cm.resolved).length +
    (timeline.floatingComments ?? []).filter((cm) => !cm.resolved).length
  );

  if (!timeline) return null;

  return (
    <div className="topbar">
      <div className="topbar-left">
        <Wordmark />
        <button
          className="crumbs"
          onClick={() => setShowProjects(true)}
          title="All projects · ⌘P"
        >
          <span>Projects</span>
          <span className="chevron">›</span>
          <span className="name">{timeline.name}</span>
        </button>
        {/* Project format badges — aspect / resolution / fps. Aspect
            is editable inline (Preview + render path read timeline.aspect
            reactively, so the change takes effect everywhere as soon as
            the store autosaves). Resolution + fps stay static for now. */}
        <AspectBadgeMenu current={timeline.aspect} onPick={(a) => useStore.getState().setAspect(a)} />
        <span className="proj-badge" title="Locked at project creation">{timeline.resolution}</span>
        <span className="proj-badge" title="Locked at project creation">{timeline.fps}fps</span>
      </div>
      <div className="topbar-center">
        {/* Two-tab segment. History was folded into the left-rail Library —
            every asset (uploads, refs, agent output, music, SFX) lives in
            one panel now, sectioned + filterable, so there's no separate
            view to switch into. */}
        <div className="seg">
          <button
            className={view === 'timeline' ? 'on' : ''}
            onClick={() => setView('timeline')}
            title="Timeline editor — clips, playhead, scrubbing"
          >Timeline</button>
          <button
            className={view === 'workspace' ? 'on' : ''}
            onClick={() => setView('workspace')}
            title="Workspace — what the agent is showing or working on right now"
          >Workspace</button>
        </div>
      </div>
      <div className="topbar-right">
        <PikaCreditsPill />
        <ReconcilerHealthPill />
        {unresolvedCount > 0 && (
          <span className="pill lavender" title={`${unresolvedCount} unresolved comment${unresolvedCount === 1 ? '' : 's'} — ask the agent to "process comments"`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          {unresolvedCount}
        </span>
        )}
        <button
          className="pill icon-only"
          onClick={undo}
          disabled={!canUndo}
          data-tip-below=""
          data-tip="Undo · ⌘Z"
          aria-label="Undo"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>
        </button>
        <button
          className="pill icon-only"
          onClick={redo}
          disabled={!canRedo}
          data-tip-below=""
          data-tip="Redo · ⇧⌘Z"
          aria-label="Redo"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/></svg>
        </button>
        <button className="pill" onClick={openVersions} title="Saved versions">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>
          Versions
        </button>
        <button
          className={`pill dark ${renderState.status === 'rendering' ? 'pill-rendering' : ''}`}
          onClick={openRenderSettings}
          disabled={renderState.status === 'rendering'}
          title={renderState.status === 'error' ? renderState.message : undefined}
          style={renderState.status === 'rendering'
            ? ({ '--render-pct': `${Math.max(0, Math.min(100, renderState.pct))}%` } as React.CSSProperties)
            : undefined}
        >
          <span className="pill-label">
            {renderState.status === 'rendering' ? `Rendering ${renderState.pct}%`
              : renderState.status === 'done' ? 'Render again'
              : renderState.status === 'error' ? 'Render failed'
              : 'Render'}
          </span>
        </button>
      </div>

      {showResult && (
        <RenderResultModal
          outRel={showResult.outRel}
          savedTo={showResult.savedTo}
          onClose={() => setShowResult(null)}
        />
      )}
      {showRenderSettings && (
        <RenderModal
          defaultFilename={`${slugify(timeline.name)}.mp4`}
          defaultPreset={timeline.render?.preset ?? 'standard'}
          onCancel={() => setShowRenderSettings(false)}
          onConfirm={startRender}
        />
      )}
      {showProjects && (
        <ProjectsModal onClose={() => setShowProjects(false)} />
      )}

      {showVersions && (
        <div
          style={{
            position: 'absolute', top: 50, right: 20, zIndex: 100,
            background: 'var(--surf-1)', border: '1px solid var(--ink-5)',
            borderRadius: 'var(--r-md)', padding: 8, minWidth: 320, maxWidth: 360,
            maxHeight: 420, overflowY: 'auto',
            boxShadow: '0 8px 24px -12px #0d0d0d33',
          }}
          onMouseLeave={() => setShowVersions(false)}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px 10px' }}>
            <span style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-1)' }}>Versions</span>
            <button className="btn primary" style={{ flex: '0 0 auto', padding: '6px 12px', fontSize: 11 }} onClick={doSaveVersion}>+ Save now</button>
          </div>
          {versions.length === 0 ? (
            <div style={{ color: 'var(--ink-3)', fontSize: 11, padding: 12 }}>No saves yet. Click "Save now" to capture this state.</div>
          ) : (
            versions.map((v) => (
              <div key={v.sha} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px', borderRadius: 'var(--r-sm)',
                background: v.current ? 'var(--acc-4)' : 'transparent',
                marginBottom: 2,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {v.message}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 2 }}>
                    {new Date(v.date).toLocaleString()} · {v.sha.slice(0, 7)}
                    {v.current && <span style={{ color: 'var(--acc-dark)', marginLeft: 6, fontWeight: 700 }}>· current</span>}
                  </div>
                </div>
                {!v.current && (
                  <button
                    onClick={() => doRestoreVersion(v.sha)}
                    style={{ fontSize: 10, padding: '4px 10px', borderRadius: 'var(--r-full)', background: 'var(--surf-3)', color: 'var(--ink-1)' }}
                  >Restore</button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
