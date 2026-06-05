import { useEffect, useState } from 'react';
import * as api from '../api';
import type { Aspect, Resolution } from '../types';

interface Props { onClose: () => void; }

function formatRelative(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

const ASPECTS: Aspect[] = ['16:9', '9:16', '1:1', '4:5', '4:3'];
const RESOLUTIONS: Resolution[] = ['720p', '1080p', '4K'];
const FPS_OPTIONS = [24, 30, 60] as const;

export function ProjectsModal({ onClose }: Props) {
  const [projects, setProjects] = useState<api.ProjectEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAspect, setNewAspect] = useState<Aspect>('16:9');
  const [newRes, setNewRes] = useState<Resolution>('1080p');
  const [newFps, setNewFps] = useState<24 | 30 | 60>(24);
  const [busy, setBusy] = useState(false);
  // Two-step delete: first click sets the row into "confirm" state with
  // an inline red "Delete forever?" panel. Second click on that panel
  // commits. Anywhere else cancels. We track the row name (not index)
  // so list refresh doesn't accidentally target a different project.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function refresh() {
    const r = await api.getProjects();
    setProjects(r.projects);
  }

  useEffect(() => {
    api.getProjects().then((r) => { setProjects(r.projects); setLoading(false); });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function open(p: api.ProjectEntry) {
    if (p.active) { onClose(); return; }
    setBusy(true);
    await api.selectProject(p.name);
    onClose();
  }

  async function commitDelete(name: string): Promise<void> {
    setBusy(true);
    setDeleteError(null);
    try {
      const r = await api.deleteProject(name);
      if (!r.ok) {
        setDeleteError(r.error ?? 'delete failed');
        return;
      }
      setPendingDelete(null);
      // If we deleted the ACTIVE project, the server already switched
      // to the next-most-recent (or none). Close the modal so the editor
      // can pick up the new active project from the project-changed SSE.
      if (r.wasActive) {
        onClose();
        return;
      }
      // Otherwise just refresh the list in place.
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createNew() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await api.createProject({
        name: newName.trim(),
        aspect: newAspect,
        resolution: newRes,
        fps: newFps,
      });
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <div className="render-modal-backdrop" onClick={onClose}>
      <div className="projects-modal" onClick={(e) => e.stopPropagation()}>
        <div className="render-modal-head">
          <div>
            <div className="render-modal-title">Projects</div>
            <div className="render-modal-sub">{projects.length} project{projects.length === 1 ? '' : 's'}</div>
          </div>
          <button className="render-modal-close" onClick={onClose}>×</button>
        </div>

        {creating ? (
          <div className="proj-new-card">
            <div className="insp-h" style={{ marginTop: 0 }}>New project name</div>
            <input
              autoFocus
              className="proj-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createNew(); }}
              placeholder="e.g. Cami launch reel"
            />
            <div className="insp-h">Aspect</div>
            <div className="chip-row">
              {ASPECTS.map((a) => (
                <button key={a} className={`chip ${newAspect === a ? 'on' : ''}`} onClick={() => setNewAspect(a)}>{a}</button>
              ))}
            </div>
            <div className="insp-h">Resolution</div>
            <div className="chip-row">
              {RESOLUTIONS.map((r) => (
                <button key={r} className={`chip ${newRes === r ? 'on' : ''}`} onClick={() => setNewRes(r)}>{r}</button>
              ))}
            </div>
            <div className="insp-h">FPS</div>
            <div className="chip-row">
              {FPS_OPTIONS.map((f) => (
                <button key={f} className={`chip ${newFps === f ? 'on' : ''}`} onClick={() => setNewFps(f)}>{f}</button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: 'var(--ink-3)', margin: '8px 0 12px', lineHeight: 1.4 }}>
              Aspect, resolution, and FPS are fixed once the project is created.
              They shape the canvas + render output — to change them, start a new project.
            </div>
            <div className="row-btns">
              <button className="btn secondary" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
              <button className="btn primary" disabled={busy || !newName.trim()} onClick={createNew}>
                {busy ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button className="proj-new-tile" onClick={() => setCreating(true)}>
              <span className="proj-new-plus">+</span>
              <span>New project</span>
            </button>

            {loading ? (
              <div style={{ color: 'var(--ink-3)', fontSize: 12, padding: 12 }}>Loading…</div>
            ) : (
              <div className="proj-list">
                {projects.map((p) => {
                  const isPending = pendingDelete === p.name;
                  return (
                    <div key={p.dir} className={`proj-row-wrap ${isPending ? 'is-pending-delete' : ''}`}>
                      <div
                        className={`proj-row ${p.active ? 'active' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => { if (!isPending && !busy) void open(p); }}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !isPending && !busy) void open(p); }}
                      >
                        <div className="proj-row-main">
                          <div className="proj-row-title">{p.displayName}</div>
                          <div className="proj-row-sub">
                            {p.aspect} · {p.resolution} · {p.fps}fps · {p.clipCount} clip{p.clipCount === 1 ? '' : 's'}
                          </div>
                        </div>
                        <div className="proj-row-meta">
                          {p.active ? <span className="proj-row-pill">Open</span> : formatRelative(p.openedAt)}
                          <button
                            className="proj-row-delete"
                            title={`Delete project "${p.displayName}"`}
                            aria-label="Delete project"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteError(null);
                              setPendingDelete(p.name);
                            }}
                            disabled={busy}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <polyline points="3 6 5 6 21 6"/>
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                              <path d="M10 11v6M14 11v6"/>
                              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
                            </svg>
                          </button>
                        </div>
                      </div>
                      {isPending && (
                        <div className="proj-row-confirm">
                          <div className="proj-row-confirm-text">
                            <strong>Delete "{p.displayName}" forever?</strong>
                            <span>This wipes the project directory, every asset, every render, every saved version. There is no undo.</span>
                          </div>
                          <div className="proj-row-confirm-actions">
                            <button
                              className="btn secondary"
                              onClick={() => { setPendingDelete(null); setDeleteError(null); }}
                              disabled={busy}
                            >Cancel</button>
                            <button
                              className="btn danger"
                              onClick={() => void commitDelete(p.name)}
                              disabled={busy}
                            >{busy ? 'Deleting…' : 'Delete forever'}</button>
                          </div>
                          {deleteError && <div className="proj-row-confirm-err">{deleteError}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
