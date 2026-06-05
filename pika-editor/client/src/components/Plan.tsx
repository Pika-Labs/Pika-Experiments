/**
 * Plan tab — the project's production bible.
 *
 * Where Workspace is the agent's ephemeral working canvas (rewritten on every
 * turn), Plan is the durable, canonical state. It only changes when the
 * user has explicitly approved a workspace proposal and the agent graduates
 * those decisions via the `update_plan` tool.
 *
 * Backed by projects/<active>/plan.json. Read-only here — you steer the
 * plan by asking the agent. We auto-refresh on SSE asset-added events
 * targeting plan.json.
 */
import { useEffect, useState } from 'react';
import * as api from '../api';
import { subscribeServerEvents } from '../sse';

interface PreviewState { rel: string; kind: 'image' | 'video'; name: string }

export function Plan() {
  const [plan, setPlan] = useState<api.Plan | null | undefined>(undefined);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  async function load() {
    const p = await api.getPlan().catch(() => ({}));
    setPlan(p ?? {});
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => subscribeServerEvents((ev) => {
    if (ev.type === 'asset-added' && ev.relPath === 'plan.json') void load();
    if (ev.type === 'project-changed') void load();
  }), []);

  if (plan === undefined) {
    return <div className="plan-shell"><div className="plan-loading">Loading plan…</div></div>;
  }
  const isEmpty = !plan || Object.keys(plan).filter((k) => k !== 'updatedAt').length === 0;

  return (
    <div className="plan-shell">
      <div className="plan-scroll">
        <div className="plan-doc">
          <div className="plan-head">
            <div className="plan-eyebrow">Production bible</div>
            <h1 className="plan-title">Plan</h1>
            {plan?.updatedAt && (
              <div className="plan-sub">Updated {new Date(plan.updatedAt).toLocaleString()}</div>
            )}
          </div>

          {isEmpty && (
            <div className="plan-empty">
              <div className="plan-empty-h">No plan yet</div>
              <div className="plan-empty-p">
                The Plan tab shows the canonical project state — concept, cast, locations, shotlist, music, open decisions.
                Ask the agent to "lock the storyboard into the plan" once you've approved a workspace proposal.
              </div>
            </div>
          )}

          {plan?.concept && (
            <section className="plan-section">
              <h2 className="plan-h">Concept</h2>
              <p className="plan-prose">{plan.concept}</p>
            </section>
          )}

          {plan?.styleAnchor && (
            <section className="plan-section">
              <h2 className="plan-h">Style anchor</h2>
              <p className="plan-prose plan-style">{plan.styleAnchor}</p>
            </section>
          )}

          {plan?.cast && plan.cast.length > 0 && (
            <section className="plan-section">
              <h2 className="plan-h">Cast <span className="plan-count">{plan.cast.length}</span></h2>
              <div className="plan-card-grid">
                {plan.cast.map((c, i) => (
                  <CharacterCard key={c.id ?? i} cast={c} onPreview={setPreview} />
                ))}
              </div>
            </section>
          )}

          {plan?.locations && plan.locations.length > 0 && (
            <section className="plan-section">
              <h2 className="plan-h">Locations <span className="plan-count">{plan.locations.length}</span></h2>
              <div className="plan-card-grid">
                {plan.locations.map((l, i) => (
                  <LocationCard key={l.id ?? i} loc={l} onPreview={setPreview} />
                ))}
              </div>
            </section>
          )}

          {plan?.beats && plan.beats.length > 0 && (
            <section className="plan-section">
              <h2 className="plan-h">Shotlist <span className="plan-count">{plan.beats.length}</span></h2>
              <div className="plan-beats">
                {plan.beats.map((b, i) => (
                  <BeatRow key={b.id ?? i} beat={b} onPreview={setPreview} />
                ))}
              </div>
            </section>
          )}

          {plan?.music?.plan && (
            <section className="plan-section">
              <h2 className="plan-h">Music</h2>
              <p className="plan-prose">{plan.music.plan}</p>
            </section>
          )}

          {plan?.sfx?.plan && (
            <section className="plan-section">
              <h2 className="plan-h">SFX</h2>
              <p className="plan-prose">{plan.sfx.plan}</p>
            </section>
          )}

          {plan?.openDecisions && plan.openDecisions.length > 0 && (
            <section className="plan-section">
              <h2 className="plan-h">Open decisions <span className="plan-count">{plan.openDecisions.length}</span></h2>
              <div className="plan-decisions">
                {plan.openDecisions.map((d, i) => (
                  <div key={d.id ?? i} className="plan-decision">
                    <div className="plan-decision-q">{d.question}</div>
                    {d.options && d.options.length > 0 && (
                      <ul className="plan-decision-opts">
                        {d.options.map((o, j) => <li key={j}>{o}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {preview && <PlanLightbox preview={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function CharacterCard({ cast, onPreview }: { cast: api.PlanCast; onPreview: (p: PreviewState) => void }) {
  return (
    <div className="plan-card">
      {cast.refSrc ? (
        <button
          className="plan-card-img"
          onClick={() => onPreview({ rel: cast.refSrc!.replace(/^assets\//, ''), kind: 'image', name: cast.name ?? 'character' })}
        >
          <img src={`/asset/${cast.refSrc.replace(/^assets\//, '')}`} alt={cast.name ?? ''} loading="lazy" />
        </button>
      ) : <div className="plan-card-img plan-card-empty">no ref</div>}
      <div className="plan-card-body">
        {cast.name && <div className="plan-card-name">{cast.name}</div>}
        {cast.role && <div className="plan-card-role">{cast.role}</div>}
        {cast.notes && <div className="plan-card-notes">{cast.notes}</div>}
      </div>
    </div>
  );
}

function LocationCard({ loc, onPreview }: { loc: api.PlanLocation; onPreview: (p: PreviewState) => void }) {
  return (
    <div className="plan-card">
      {loc.refSrc ? (
        <button
          className="plan-card-img"
          onClick={() => onPreview({ rel: loc.refSrc!.replace(/^assets\//, ''), kind: 'image', name: loc.name ?? 'location' })}
        >
          <img src={`/asset/${loc.refSrc.replace(/^assets\//, '')}`} alt={loc.name ?? ''} loading="lazy" />
        </button>
      ) : <div className="plan-card-img plan-card-empty">no ref</div>}
      <div className="plan-card-body">
        {loc.name && <div className="plan-card-name">{loc.name}</div>}
        {loc.notes && <div className="plan-card-notes">{loc.notes}</div>}
      </div>
    </div>
  );
}

function BeatRow({ beat, onPreview }: { beat: api.PlanBeat; onPreview: (p: PreviewState) => void }) {
  const statusClass = beat.status === 'video-ready' ? 'ok' : beat.status === 'storyboard-approved' ? 'mid' : 'plan';
  return (
    <div className="plan-beat-row">
      {beat.storyboardSrc ? (
        <button
          className="plan-beat-frame"
          onClick={() => onPreview({ rel: beat.storyboardSrc!.replace(/^assets\//, ''), kind: 'image', name: beat.label ?? 'beat' })}
        >
          <img src={`/asset/${beat.storyboardSrc.replace(/^assets\//, '')}`} alt={beat.label ?? ''} loading="lazy" />
        </button>
      ) : <div className="plan-beat-frame plan-card-empty">no frame</div>}
      <div className="plan-beat-body">
        <div className="plan-beat-head">
          <span className={`plan-status plan-status-${statusClass}`}>{beat.status ?? 'planned'}</span>
          <span className="plan-beat-label">{beat.label ?? beat.id ?? '—'}</span>
          {beat.timecode && <span className="plan-beat-tc">{beat.timecode}</span>}
          {beat.model && <span className="plan-beat-model">{beat.model}</span>}
        </div>
        {beat.action && <div className="plan-beat-action">{beat.action}</div>}
        {beat.dialogue && beat.dialogue.length > 0 && (
          <div className="plan-beat-dlg">
            {beat.dialogue.map((d, i) => (
              <div key={i} className="plan-beat-dlg-line">
                {d.who && <span className="plan-beat-dlg-who">{d.who}</span>}
                <span className="plan-beat-dlg-text">{d.line}</span>
              </div>
            ))}
          </div>
        )}
        {beat.framingNote && <div className="plan-beat-note">{beat.framingNote}</div>}
      </div>
    </div>
  );
}

function PlanLightbox({ preview, onClose }: { preview: PreviewState; onClose: () => void }) {
  return (
    <div className="render-modal-backdrop" onClick={onClose}>
      <div className="workspace-lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="render-modal-head">
          <div>
            <div className="render-modal-title">{preview.name}</div>
            <div className="render-modal-sub">{preview.rel}</div>
          </div>
          <button className="render-modal-close" onClick={onClose}>×</button>
        </div>
        {preview.kind === 'image'
          ? <img src={`/asset/${preview.rel}`} alt={preview.name} style={{ maxWidth: '100%', maxHeight: '75vh', display: 'block', margin: '0 auto', borderRadius: 'var(--r-md)' }} />
          : <video src={`/asset/${preview.rel}`} controls autoPlay style={{ width: '100%', maxHeight: '75vh', borderRadius: 'var(--r-md)', background: '#000', display: 'block' }} />}
      </div>
    </div>
  );
}
