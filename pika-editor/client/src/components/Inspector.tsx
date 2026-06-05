import { useState } from 'react';
import { useStore } from '../store';
import type { PikaGenScene } from '../types';
import * as api from '../api';
import { RenderResultModal } from './RenderResultModal';
import { effectiveDuration } from '../edit';

export function Inspector() {
  const timeline = useStore((s) => s.timeline);
  const selectedCaptionId = useStore((s) => s.selectedCaptionId);
  const inspectorTab = useStore((s) => s.inspectorTab);
  const setInspectorTab = useStore((s) => s.setInspectorTab);

  if (!timeline) return null;

  // When a caption row is selected, the inspector becomes a captions
  // editor — the user is in caption-edit mode and the generic clip
  // inspector would be a distraction.
  if (selectedCaptionId) {
    return (
      <div className="inspector">
        <CaptionInspector />
      </div>
    );
  }

  return (
    <div className="inspector">
      <div className="insp-tabs">
        <button className={inspectorTab === 'clip' ? 'on' : ''} onClick={() => setInspectorTab('clip')}>Clip</button>
        <button className={inspectorTab === 'project' ? 'on' : ''} onClick={() => setInspectorTab('project')}>Project</button>
        <button className={inspectorTab === 'render' ? 'on' : ''} onClick={() => setInspectorTab('render')}>Render</button>
      </div>

      {inspectorTab === 'clip' && <ClipInspector />}
      {inspectorTab === 'project' && <ProjectInspector />}
      {inspectorTab === 'render' && <RenderInspector />}
    </div>
  );
}

function ClipInspector() {
  const timeline = useStore((s) => s.timeline)!;
  const selectedClipIds = useStore((s) => s.selectedClipIds);
  const [refineDraft, setRefineDraft] = useState('');
  const [refining, setRefining] = useState(false);

  const clip = timeline.tracks.flatMap((t) => t.clips).find((c) => selectedClipIds.includes(c.id));
  if (!clip) {
    return (
      <div style={{ color: 'var(--ink-3)', fontSize: 12, padding: '12px 4px' }}>
        Select a clip on the timeline to edit its prompt, model, and variants.
      </div>
    );
  }
  const scene = timeline.scenes.find((s) => s.id === clip.sceneId);
  if (!scene) return <div>Scene missing for clip {clip.id}</div>;

  const isPikaGen = scene.kind === 'pika-gen';
  const pg = isPikaGen ? (scene as PikaGenScene) : null;
  const title = scene.labels?.[0] ?? scene.id;
  const statusLabel = pg ? pg.status : 'imported';
  const dotClass =
    pg?.status === 'ready' ? 'dot' :
    pg?.status === 'error' ? 'dot error-dot' :
    pg ? 'dot pending-dot' : 'dot';

  return (
    <>
      <div className="selected-title">{title}</div>
      <div className="selected-sub">
        <span className={dotClass} />
        {statusLabel} · {(clip.out - clip.in).toFixed(1)}s
      </div>

      {pg && (
        <>
          <div className="insp-h">Prompt</div>
          <div className="prompt-box">{pg.prompt || <span style={{ color: 'var(--ink-4)' }}>No prompt yet</span>}</div>

          <div className="insp-h">Model</div>
          <div className="field-row">
            <div className="field"><div className="lbl">Engine</div><div className="v">{pg.model}</div></div>
            <div className="field"><div className="lbl">Duration</div><div className="v">{scene.naturalDuration.toFixed(1)}s</div></div>
            <div className="field"><div className="lbl">Aspect</div><div className="v">{timeline.aspect}</div></div>
            <div className="field"><div className="lbl">Status</div><div className="v">{pg.status}</div></div>
          </div>

          <div className="insp-h">Variants</div>
          <div className="chip-row">
            <span className="chip on">Take 01</span>
            <span className="chip">+</span>
          </div>

          <div className="row-btns">
            <button
              className="btn secondary"
              onClick={async () => {
                if (!clip) return;
                await api.addComment({
                  clipId: clip.id,
                  at: 0,
                  note: 'Re-roll: regenerate this clip with a fresh seed, same prompt.',
                });
                // Flip the scene back to pending so the agent picks it up.
                await api.patchScene(scene.id, { status: 'pending' });
              }}
            >↺ Re-roll</button>
            <button
              className="btn primary"
              onClick={() => {
                const note = window.prompt('How should the agent refine this clip?', refineDraft);
                if (note?.trim() && clip) {
                  setRefining(true);
                  api.addComment({ clipId: clip.id, at: 0, note: note.trim() })
                    .finally(() => setRefining(false));
                  setRefineDraft('');
                }
              }}
              disabled={refining}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1l2.5 6.5L21 10l-6.5 2.5L12 19l-2.5-6.5L3 10l6.5-2.5z"/></svg>
              {refining ? 'Saving…' : 'Refine'}
            </button>
          </div>

          {(clip?.comments ?? []).filter((cm) => !cm.resolved).length > 0 && (
            <div className="agent-msg" style={{ background: 'var(--surf-3)' }}>
              <div className="who" style={{ color: 'var(--ink-3)' }}>Pending feedback</div>
              {(clip!.comments ?? []).filter((cm) => !cm.resolved).map((cm) => (
                <div key={cm.id} style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.4 }}>
                  · {cm.note}
                </div>
              ))}
            </div>
          )}

          {pg.status === 'generating' && (
            <div className="agent-msg">
              <div className="who">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1l2.5 6.5L21 10l-6.5 2.5L12 19l-2.5-6.5L3 10l6.5-2.5z"/></svg>
                Agent
              </div>
              Generating with {pg.model}…
            </div>
          )}
        </>
      )}
    </>
  );
}

function ProjectInspector() {
  const timeline = useStore((s) => s.timeline)!;
  const setProjectName = useStore((s) => s.setProjectName);
  const [nameDraft, setNameDraft] = useState(timeline.name);

  // Dynamic — rightmost edge of any clip across video + audio tracks.
  const totalDur = effectiveDuration(timeline);

  return (
    <>
      <div className="insp-h">Project name</div>
      <input
        className="proj-input"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={() => { if (nameDraft.trim() && nameDraft !== timeline.name) setProjectName(nameDraft.trim()); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />

      <div className="insp-h">Canvas (locked at creation)</div>
      <div className="field-row">
        <div className="field"><div className="lbl">Aspect</div><div className="v">{timeline.aspect}</div></div>
        <div className="field"><div className="lbl">Resolution</div><div className="v">{timeline.resolution}</div></div>
        <div className="field"><div className="lbl">FPS</div><div className="v">{timeline.fps}</div></div>
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-3)', padding: '0 4px', lineHeight: 1.4, marginTop: 4 }}>
        Start a new project to change these.
      </div>

      <div className="insp-h">Music</div>
      <div className="field-row">
        <div className="field"><div className="lbl">BPM</div><div className="v">{timeline.bpm ? timeline.bpm.toFixed(1) : '—'}</div></div>
        <div className="field"><div className="lbl">Beats</div><div className="v">{timeline.beats.length}</div></div>
      </div>
      <button
        className="btn secondary"
        style={{ width: '100%', marginTop: 4 }}
        disabled={!timeline.music?.src}
        onClick={async () => {
          const r = await api.detectBeats();
          if (r.error) alert(`${r.error}\n${r.hint ?? ''}`);
        }}
      >
        {timeline.music?.src ? 'Detect beats' : 'Detect beats (no music yet)'}
      </button>

      <div className="insp-h">Stats</div>
      <div className="field-row">
        <div className="field"><div className="lbl">Duration</div><div className="v">{totalDur.toFixed(2)}s</div></div>
        <div className="field"><div className="lbl">Scenes</div><div className="v">{timeline.scenes.length}</div></div>
        <div className="field"><div className="lbl">V1 clips</div><div className="v">{timeline.tracks.find((t) => t.kind === 'video')?.clips.length ?? 0}</div></div>
        <div className="field"><div className="lbl">SFX</div><div className="v">{timeline.sfx.clips.length}</div></div>
      </div>
    </>
  );
}

function RenderInspector() {
  const timeline = useStore((s) => s.timeline)!;
  const setRenderPreset = useStore((s) => s.setRenderPreset);
  const [watching, setWatching] = useState<string | null>(null);
  const preset = timeline.render?.preset ?? 'standard';
  const jobs = timeline.render?.lastJobs ?? [];

  async function startRender(p: 'draft' | 'standard' | 'high') {
    setRenderPreset(p);
    await api.postRender({ preset: p });
  }

  return (
    <>
      <div className="insp-h">Quality preset</div>
      <div className="chip-row">
        {(['draft', 'standard', 'high'] as const).map((p) => (
          <button key={p} className={`chip ${preset === p ? 'on' : ''}`} onClick={() => startRender(p)}>
            {p === 'draft' ? 'Draft · fast' : p === 'standard' ? 'Standard' : 'High · slow'}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 4, padding: '0 4px' }}>
        Clicking a preset starts the render at that quality.
      </div>

      <div className="insp-h">Recent renders</div>
      {jobs.length === 0 ? (
        <div style={{ color: 'var(--ink-3)', fontSize: 11, padding: '0 4px' }}>No renders yet.</div>
      ) : (
        jobs.map((j: any) => (
          <div key={j.id} style={{
            background: 'var(--surf-3)', borderRadius: 'var(--r-sm)',
            padding: '8px 10px', marginBottom: 6,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-1)' }}>
                {j.status === 'running' ? 'Rendering…' : j.status === 'error' ? 'Failed' : 'Done'}
                <span style={{ color: 'var(--ink-4)', fontWeight: 400, marginLeft: 6 }}>
                  · {j.preset} · {j.fps}fps
                </span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 2 }}>
                {j.id}
                {j.elapsedSec > 0 && ` · ${j.elapsedSec.toFixed(1)}s`}
              </div>
              {j.status === 'error' && j.errorMessage && (
                <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4, lineHeight: 1.3 }}>
                  {j.errorMessage.slice(0, 120)}
                </div>
              )}
            </div>
            {j.status === 'done' && j.out && (
              <button
                onClick={() => setWatching(j.out)}
                style={{ fontSize: 10, padding: '4px 10px', borderRadius: 'var(--r-full)', background: 'var(--acc-deep)', color: 'white' }}
              >Watch</button>
            )}
          </div>
        ))
      )}
      {watching && <RenderResultModal outRel={watching} onClose={() => setWatching(null)} />}
    </>
  );
}

/**
 * Caption editor — shown in the inspector slot when a CaptionBox on the CC
 * lane is selected. Two stacked sections: the row's own text + style
 * overrides at the top, then the project-wide default style below (so the
 * user can author one look and reuse it). Style edits apply live to the
 * preview overlay; burn-in at render time reads the same values.
 */
function CaptionInspector() {
  const timeline = useStore((s) => s.timeline)!;
  const selectedCaptionId = useStore((s) => s.selectedCaptionId);
  const selectCaption = useStore((s) => s.selectCaption);
  const patchCaptionRow = useStore((s) => s.patchCaptionRow);
  const deleteCaptionRow = useStore((s) => s.deleteCaptionRow);
  const setCaptionsDefaultStyle = useStore((s) => s.setCaptionsDefaultStyle);
  const setCaptionsEnabled = useStore((s) => s.setCaptionsEnabled);

  const row = timeline.captions.rows.find((r) => r.id === selectedCaptionId);
  const defaults = timeline.captions.defaultStyle;
  if (!row) return <div style={{ color: 'var(--ink-3)', fontSize: 12, padding: 12 }}>Caption no longer exists.</div>;

  // Effective style = defaults merged with the row's overrides. We display
  // this so the user sees what's actually rendered; edits write only to
  // the row's override map so "back to default" stays meaningful.
  const eff = { ...defaults, ...(row.style ?? {}) };
  const overrideKeys = new Set(Object.keys(row.style ?? {}));

  function setRowStyle(patch: Partial<typeof eff>) {
    if (!row) return;
    patchCaptionRow(row.id, { style: { ...(row.style ?? {}), ...patch } });
  }
  function clearOverride(key: keyof typeof eff) {
    if (!row?.style) return;
    const next = { ...row.style };
    delete (next as any)[key];
    patchCaptionRow(row.id, { style: Object.keys(next).length === 0 ? null : next });
  }
  function applyRowAsDefault() {
    if (!row) return;
    setCaptionsDefaultStyle(eff);
    // Clear all per-row overrides on THIS row since they now match defaults.
    patchCaptionRow(row.id, { style: null });
  }

  return (
    <div className="cap-insp">
      <div className="cap-insp-head">
        <div className="cap-insp-title">Caption</div>
        <button className="cap-insp-close" onClick={() => selectCaption(null)} title="Close">×</button>
      </div>

      <label className="cap-field">
        <span className="cap-field-label">Text</span>
        <textarea
          className="cap-textarea"
          value={row.text}
          onChange={(e) => patchCaptionRow(row.id, { text: e.target.value })}
          rows={3}
        />
      </label>

      <div className="cap-row-times">
        <span>{row.start.toFixed(2)}s → {row.end.toFixed(2)}s</span>
        <span>· {(row.end - row.start).toFixed(2)}s</span>
        <button className="cap-delete" onClick={() => { deleteCaptionRow(row.id); }} title="Delete this row">Delete</button>
      </div>

      <div className="cap-section-h">Style</div>

      {/* Position (X%/Y%) is global to the caption track — edited via the
          live preview drag or the Default style controls, not per-row. */}
      <CapNumberField
        label="Size"
        value={eff.size}
        min={12} max={120} step={2}
        overridden={overrideKeys.has('size')}
        onChange={(v) => setRowStyle({ size: v })}
        onReset={() => clearOverride('size')}
      />
      <CapEnumField
        label="Weight"
        value={String(eff.weight)}
        options={['400', '600', '700', '800', '900']}
        overridden={overrideKeys.has('weight')}
        onChange={(v) => setRowStyle({ weight: parseInt(v, 10) as any })}
        onReset={() => clearOverride('weight')}
      />
      <CapColorField
        label="Color"
        value={eff.color}
        overridden={overrideKeys.has('color')}
        onChange={(v) => setRowStyle({ color: v })}
        onReset={() => clearOverride('color')}
      />
      <CapTextField
        label="Background"
        value={eff.bg}
        overridden={overrideKeys.has('bg')}
        placeholder="rgba(13,13,13,0.65)"
        onChange={(v) => setRowStyle({ bg: v })}
        onReset={() => clearOverride('bg')}
      />
      <CapEnumField
        label="Case"
        value={eff.textCase}
        options={['none', 'caps']}
        overridden={overrideKeys.has('textCase')}
        onChange={(v) => setRowStyle({ textCase: v as any })}
        onReset={() => clearOverride('textCase')}
      />

      <div className="cap-actions">
        <button className="btn secondary" onClick={applyRowAsDefault} title="Make this caption's look the project default">
          Use as default
        </button>
        <button className="btn secondary" onClick={() => patchCaptionRow(row.id, { style: null })} title="Reset this caption to project defaults">
          Reset to defaults
        </button>
      </div>

      <div className="cap-section-h" style={{ marginTop: 18 }}>Track</div>
      <label className="cap-toggle">
        <input
          type="checkbox"
          checked={timeline.captions.enabled}
          onChange={(e) => setCaptionsEnabled(e.target.checked)}
        />
        <span>Show captions in preview &amp; render</span>
      </label>
    </div>
  );
}

function CapNumberField({ label, value, min, max, step, overridden, onChange, onReset }: {
  label: string; value: number; min: number; max: number; step: number;
  overridden: boolean; onChange: (v: number) => void; onReset: () => void;
}) {
  return (
    <div className={`cap-field cap-row ${overridden ? 'overridden' : ''}`}>
      <span className="cap-field-label">{label}</span>
      <input
        className="cap-input"
        type="number" min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {overridden && <button className="cap-reset" onClick={onReset} title="Use project default">↺</button>}
    </div>
  );
}
function CapEnumField({ label, value, options, overridden, onChange, onReset }: {
  label: string; value: string; options: string[];
  overridden: boolean; onChange: (v: string) => void; onReset: () => void;
}) {
  return (
    <div className={`cap-field cap-row ${overridden ? 'overridden' : ''}`}>
      <span className="cap-field-label">{label}</span>
      <select className="cap-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {overridden && <button className="cap-reset" onClick={onReset} title="Use project default">↺</button>}
    </div>
  );
}
function CapColorField({ label, value, overridden, onChange, onReset }: {
  label: string; value: string; overridden: boolean; onChange: (v: string) => void; onReset: () => void;
}) {
  return (
    <div className={`cap-field cap-row ${overridden ? 'overridden' : ''}`}>
      <span className="cap-field-label">{label}</span>
      <input
        className="cap-input cap-color"
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        className="cap-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {overridden && <button className="cap-reset" onClick={onReset} title="Use project default">↺</button>}
    </div>
  );
}
function CapTextField({ label, value, overridden, placeholder, onChange, onReset }: {
  label: string; value: string; overridden: boolean; placeholder?: string;
  onChange: (v: string) => void; onReset: () => void;
}) {
  return (
    <div className={`cap-field cap-row ${overridden ? 'overridden' : ''}`}>
      <span className="cap-field-label">{label}</span>
      <input
        className="cap-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {overridden && <button className="cap-reset" onClick={onReset} title="Use project default">↺</button>}
    </div>
  );
}
