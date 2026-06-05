/**
 * Library — the left rail. This is the single home for every asset in
 * the project: uploaded refs, agent-generated pika output, imports,
 * music, SFX, cast, locations. (The standalone "History" view was
 * folded into this panel — chronology + sectioning live here now.
 * Uploads also moved out — they live inline with the chat composer now
 * so you upload + immediately talk about a ref in one motion.)
 *
 * Surfaces, stacked top → bottom:
 *
 *   1. Filter chips — All / Image / Video / Audio.
 *
 *   2. Sectioned asset list — when filter = All, items are grouped by
 *      source (cast, locations, pika, sfx, music, …) with a header per
 *      section, items newest-first within each. When filter ≠ All, a
 *      flat newest-first grid of just that media type.
 *
 * Every tile is:
 *   - clickable      → opens AssetLightbox
 *   - draggable      → video/audio onto Timeline lanes
 *   - + talk         → attaches as a chat-composer chip
 *
 * Video tiles hover-scrub via the shared HoverScrubVideo component.
 * Audio tiles render a flat waveform svg — no gradient, no play overlay.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';
import { useStore } from '../store';
import { subscribeServerEvents } from '../sse';
import { AssetLightbox, type AssetPreview } from './AssetLightbox';
import { HoverScrubVideo } from './HoverScrubVideo';

type Kind = 'all' | 'image' | 'video' | 'audio';
type Density = 'compact' | 'comfy';

type LibItem = api.WorkspaceAssetItem & { groupLabel: string };

const DENSITY_KEY = 'pae:library:density';
const WIDTH_KEY = 'pae:library:width';
const COLLAPSED_KEY = 'pae:library:collapsed';
const MIN_WIDTH = 220;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 244;
const COLLAPSED_WIDTH = 44;

export function Library() {
  const toggleChatAttachment = useStore((s) => s.toggleChatAttachment);
  const chatAttachments = useStore((s) => s.chatAttachments);
  const focusChatInput = useStore((s) => s.focusChatInput);
  const attachedRels = useMemo(() => new Set(chatAttachments.map((a) => a.rel)), [chatAttachments]);

  const [groups, setGroups] = useState<api.WorkspaceAssetGroup[]>([]);
  const [filter, setFilter] = useState<Kind>('all');
  const [preview, setPreview] = useState<AssetPreview | null>(null);
  // Compact = 2 cols, Comfy = 1 col. Persisted so it sticks between sessions.
  const [density, setDensityState] = useState<Density>(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(DENSITY_KEY) : null;
    return v === 'comfy' ? 'comfy' : 'compact';
  });
  function setDensity(d: Density): void {
    setDensityState(d);
    try { window.localStorage.setItem(DENSITY_KEY, d); } catch {/* no-op */}
  }

  // Resizable column width. The `--lib-width` CSS variable on
  // documentElement feeds the .app grid-template-columns; we sync it
  // here on mount and on every drag tick. `widthRef` mirrors state so
  // the onPointerUp handler can persist the final value without a
  // stale-closure bug.
  const [libWidth, setLibWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH;
    const v = window.localStorage.getItem(WIDTH_KEY);
    const n = v ? parseInt(v, 10) : DEFAULT_WIDTH;
    return Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH ? n : DEFAULT_WIDTH;
  });
  // Collapsed state: when true, the Library shrinks to a thin rail with
  // just an expand button — gives the canvas the full middle column for
  // wide-aspect work or when the user wants the timeline to breathe.
  // Persisted across sessions.
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  function setCollapsed(c: boolean): void {
    setCollapsedState(c);
    try { window.localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0'); } catch { /* no-op */ }
  }
  const widthRef = useRef(libWidth);
  widthRef.current = libWidth;
  useEffect(() => {
    const v = collapsed ? COLLAPSED_WIDTH : libWidth;
    document.documentElement.style.setProperty('--lib-width', v + 'px');
  }, [libWidth, collapsed]);
  function onResizerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    function onMove(ev: PointerEvent): void {
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + (ev.clientX - startX)));
      setLibWidth(next);
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { window.localStorage.setItem(WIDTH_KEY, String(widthRef.current)); } catch {/* no-op */}
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  async function load(): Promise<void> {
    try {
      const r = await api.getWorkspaceAssets();
      setGroups(r.groups);
    } catch {/* refs panel is best-effort */}
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => subscribeServerEvents((ev) => {
    if (ev.type === 'asset-added' || ev.type === 'project-changed') void load();
  }), []);

  // Filter-aware totals + view.
  // "All" → sectioned (one block per group, newest first within).
  // Else  → one flat grid of just that media type, newest first.
  const sections = useMemo(() => {
    return groups
      .map((g) => ({
        group: g.group,
        label: g.label,
        items: g.items
          .filter((it) => filter === 'all' || it.kind === filter)
          .map((it): LibItem => ({ ...it, groupLabel: g.label }))
          .sort((a, b) => b.mtime - a.mtime),
      }))
      .filter((s) => s.items.length > 0);
  }, [groups, filter]);

  const flatCount = useMemo(() => sections.reduce((n, s) => n + s.items.length, 0), [sections]);

  function toggleOne(it: LibItem): void {
    const id = `att_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000).toString(36)}`;
    const rel = it.rel.startsWith('assets/') ? it.rel : `assets/${it.rel}`;
    const added = toggleChatAttachment({ id, rel, kind: it.kind, name: it.name });
    if (added) focusChatInput();
  }

  // Drop-anywhere-in-panel upload. Files go straight to refs (no chat
  // chip) — the spatial metaphor: dropping in the library means "save
  // this for later", dropping in the composer means "I want to talk
  // about this now". SSE `asset-added` refreshes the grid.
  const [panelDropHover, setPanelDropHover] = useState(false);
  async function uploadOnly(files: FileList | File[]): Promise<void> {
    for (const f of Array.from(files)) {
      try { await api.uploadRef(f); } catch {/* per-file failure ignored */}
    }
    void load();
  }
  function onPanelDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    setPanelDropHover(true);
  }
  function onPanelDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    setPanelDropHover(false);
    void uploadOnly(e.dataTransfer.files);
  }

  if (collapsed) {
    return (
      <div className="library lib-refs lib-collapsed">
        <button
          className="lib-collapse-btn"
          onClick={() => setCollapsed(false)}
          title="Expand Library"
          aria-label="Expand Library"
        >
          {/* Chevron right — points to the expand direction */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div className="lib-collapsed-label">Library</div>
      </div>
    );
  }

  return (
    <>
    <div
      className={`library lib-refs ${panelDropHover ? 'lib-dropover' : ''}`}
      onDragOver={onPanelDragOver}
      onDragLeave={() => setPanelDropHover(false)}
      onDrop={onPanelDrop}
    >
      {/* Sticky header — title + filter chips + density toggle stay
          pinned at the top while the section list scrolls underneath.
          `position: sticky` works because `.library` is the scroll
          container (overflow-y: auto). */}
      <div className="lib-sticky">
        <div className="lib-refs-head">
          <span className="lib-refs-title">Library</span>
          {flatCount > 0 && <span className="lib-refs-count">{flatCount}</span>}
          <button
            className="lib-collapse-btn-inline"
            onClick={() => setCollapsed(true)}
            title="Collapse Library"
            aria-label="Collapse Library"
          >
            {/* Chevron left — collapse direction */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>

        <div className="lib-filter-row">
        <div className="lib-filter-chips">
          {(['all', 'image', 'video', 'audio'] as Kind[]).map((k) => (
            <button
              key={k}
              className={`lib-filter-chip ${filter === k ? 'on' : ''}`}
              onClick={() => setFilter(k)}
            >
              {k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <div className="lib-density" role="group" aria-label="Tile density">
          <button
            className={`lib-density-btn ${density === 'compact' ? 'on' : ''}`}
            onClick={() => setDensity('compact')}
            title="Compact · two columns"
            aria-label="Compact density"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="3" y="3" width="8" height="8" rx="1.5" />
              <rect x="13" y="3" width="8" height="8" rx="1.5" />
              <rect x="3" y="13" width="8" height="8" rx="1.5" />
              <rect x="13" y="13" width="8" height="8" rx="1.5" />
            </svg>
          </button>
          <button
            className={`lib-density-btn ${density === 'comfy' ? 'on' : ''}`}
            onClick={() => setDensity('comfy')}
            title="Comfy · one column"
            aria-label="Comfy density"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="3" y="3" width="18" height="8" rx="1.5" />
              <rect x="3" y="13" width="18" height="8" rx="1.5" />
            </svg>
          </button>
        </div>
        </div>
      </div>

      <div className="lib-body" data-density={density}>
        {sections.length === 0 ? (
          <div className="lib-empty">
            <div className="lib-empty-h">{filter === 'all' ? 'No assets yet' : `No ${filter} yet`}</div>
            <div className="lib-empty-p">Drop a file above or generate one through the agent. Everything ever produced lives here — nothing is ever removed.</div>
          </div>
        ) : (
          sections.map((s) => (
            <LibrarySection
              key={s.group}
              label={s.label}
              items={s.items}
              attachedRels={attachedRels}
              onPreview={(it) => setPreview({ rel: it.rel, kind: it.kind, name: it.name })}
              onToggleAttach={toggleOne}
            />
          ))
        )}
      </div>

      {preview && <AssetLightbox preview={preview} onClose={() => setPreview(null)} />}
    </div>
    {/* Drag handle to resize the column. Sits at the right edge of the
        library cell (position: fixed at left: var(--lib-width)). The
        bar itself is invisible until hover, but the hit area is 6px
        wide so it's easy to grab. */}
    <div className="lib-resizer" onPointerDown={onResizerDown} aria-hidden />
    </>
  );
}

function LibrarySection({ label, items, attachedRels, onPreview, onToggleAttach }: {
  label: string;
  items: LibItem[];
  attachedRels: Set<string>;
  onPreview: (it: LibItem) => void;
  onToggleAttach: (it: LibItem) => void;
}) {
  return (
    <div className="lib-section">
      <div className="lib-section-h">
        <span className="lib-section-name">{label}</span>
        <span className="lib-section-count">{items.length}</span>
      </div>
      <div className="lib-section-grid">
        {items.map((it) => {
          const rel = it.rel.startsWith('assets/') ? it.rel : `assets/${it.rel}`;
          return (
            <LibTile
              key={it.rel}
              item={it}
              isAttached={attachedRels.has(rel)}
              onPreview={() => onPreview(it)}
              onToggleAttach={() => onToggleAttach(it)}
            />
          );
        })}
      </div>
    </div>
  );
}

function LibTile({ item, isAttached, onPreview, onToggleAttach }: {
  item: LibItem;
  isAttached: boolean;
  onPreview: () => void;
  onToggleAttach: () => void;
}) {
  const ext = (item.name.split('.').pop() ?? '').toUpperCase();
  const when = formatWhen(item.mtime);
  // Aspect-aware thumb: starts as a 1:1 skeleton, then adopts the media's
  // natural aspect once metadata loads. Audio is the only fixed shape
  // (5:2 waveform card — there's no natural aspect to honour).
  const [aspect, setAspect] = useState<number | null>(null);

  // Drag video/audio onto the Timeline. Images stay attach-only — they
  // feed the agent as chat refs, not as timeline clips.
  function onDragStart(e: React.DragEvent<HTMLDivElement>): void {
    if (item.kind !== 'video' && item.kind !== 'audio') {
      e.preventDefault();
      return;
    }
    const payload = JSON.stringify({
      rel: item.rel.startsWith('assets/') ? item.rel : `assets/${item.rel}`,
      kind: item.kind,
      name: item.name,
    });
    e.dataTransfer.setData('application/x-pae-ref', payload);
    e.dataTransfer.effectAllowed = 'copy';
    // Small custom drag image so the OS-default preview (a full
    // screenshot of the tile, often 200+ px square) doesn't obscure the
    // timeline underneath while the user is figuring out where to drop.
    // We build a tiny labeled chip off-screen, set it as the drag image,
    // then drop the DOM node on the next tick — the browser has already
    // rasterized it by then.
    const chip = document.createElement('div');
    chip.textContent = item.name.length > 22 ? item.name.slice(0, 20) + '…' : item.name;
    chip.style.cssText = [
      'position: fixed', 'top: -1000px', 'left: -1000px',
      'padding: 4px 8px',
      'background: rgba(31,29,47,0.92)',
      'color: #fff',
      'font: 600 11px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif',
      'border-radius: 4px',
      'border: 1px solid rgba(131,108,224,0.65)',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.35)',
      'white-space: nowrap',
      'pointer-events: none',
    ].join(';');
    document.body.appendChild(chip);
    e.dataTransfer.setDragImage(chip, 12, 12);
    // The chip needs to stay alive until the browser snapshots it
    // (synchronously, but Safari sometimes lags one frame). Remove on
    // the next tick to avoid leaking offscreen DOM nodes.
    requestAnimationFrame(() => { try { chip.remove(); } catch {} });
  }

  // Audio gets the fixed waveform card. Everything else uses the probed
  // intrinsic aspect (falling back to 1:1 until metadata arrives).
  const thumbStyle: React.CSSProperties = item.kind === 'audio'
    ? { aspectRatio: '5 / 2' }
    : aspect
      ? { aspectRatio: aspect }
      : { aspectRatio: '1 / 1' };

  return (
    <div
      className={`lib-tile lib-tile-${item.kind}`}
      draggable={item.kind === 'video' || item.kind === 'audio'}
      onDragStart={onDragStart}
      onClick={onPreview}
      role="button"
      aria-label={item.name}
    >
      <div className="lib-tile-thumb" style={thumbStyle}>
        {item.kind === 'image' && (
          <img
            src={`/asset/${item.rel}`}
            alt=""
            loading="lazy"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight);
            }}
          />
        )}
        {item.kind === 'video' && (
          <HoverScrubVideo
            src={`/asset/${item.rel}`}
            onMeta={(w, h) => setAspect(w / h)}
          />
        )}
        {item.kind === 'audio' && <AudioThumb />}
        {item.kind === 'other' && <div className="lib-tile-other">{ext || '?'}</div>}
        <button
          className={`lib-tile-attach ${isAttached ? 'is-on' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleAttach(); }}
          title={isAttached ? 'Remove from chat message' : 'Talk about it'}
          aria-label={isAttached ? 'Remove from chat' : 'Talk about it'}
          aria-pressed={isAttached}
        >{isAttached ? '✓ attached' : 'Talk about it'}</button>
      </div>
      <div className="lib-tile-meta">
        <div className="lib-tile-name">{item.name}</div>
        <div className="lib-tile-sub">{when}</div>
      </div>
    </div>
  );
}

/** Audio thumb — flat brand surface + lavender waveform bars. Same
 *  visual treatment as the old History audio card so nothing reads
 *  as a broken video preview. */
function AudioThumb() {
  const bars = [
    14, 22, 9, 26, 17, 30, 12, 19, 24, 8,
    21, 15, 28, 11, 23, 18, 14, 25, 10, 20,
    16, 27, 13, 22, 9, 24, 18, 11, 29, 15,
    20, 12, 26, 17, 23, 8, 19, 25, 14, 21,
  ];
  return (
    <div className="lib-audio-thumb">
      <svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden>
        {bars.map((h, i) => (
          <rect key={i} x={i * 2.5 + 0.4} y={(36 - h) / 2} width={1.6} height={h} rx={0.8} fill="currentColor" />
        ))}
      </svg>
    </div>
  );
}

function formatWhen(mtime: number): string {
  const diff = Date.now() - mtime;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(mtime).toLocaleDateString();
}
