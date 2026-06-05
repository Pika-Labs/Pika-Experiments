/**
 * Side-docked captions editor. Opens when the user clicks the CC lane label
 * (track-level controls) or clicks a caption row on the timeline (per-row
 * controls inline below the track section).
 *
 * Two sections in one panel:
 *   • TRACK — defaults that apply to every row that doesn't have its own
 *     override. Plus "Auto-caption whole timeline" + the enable toggle.
 *   • ROW   — only shown when a row is selected. Text + per-row style
 *     overrides + delete. Overridden style fields show a lavender label
 *     and a ↺ reset button so the user can fall back to track defaults.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import * as api from '../api';
import type { CaptionStyle } from '../types';

export function CaptionPanel() {
  const timeline = useStore((s) => s.timeline);
  const selectedCaptionId = useStore((s) => s.selectedCaptionId);
  const selectCaption = useStore((s) => s.selectCaption);
  const setCaptionsPanelOpen = useStore((s) => s.setCaptionsPanelOpen);
  const patchCaptionRow = useStore((s) => s.patchCaptionRow);
  const deleteCaptionRow = useStore((s) => s.deleteCaptionRow);
  const setCaptionsDefaultStyle = useStore((s) => s.setCaptionsDefaultStyle);
  const setCaptionsEnabled = useStore((s) => s.setCaptionsEnabled);

  const [scopedBusy, setScopedBusy] = useState(false);     // per-row auto-caption busy
  const [allBusy, setAllBusy] = useState(false);            // whole-timeline auto-caption busy
  const [msg, setMsg] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Per-row style overrides default to collapsed so the panel doesn't feel
  // doubled with the Default style section above. User opts in to overrides
  // for a specific row when they need to break from project defaults.
  const [rowOverridesOpen, setRowOverridesOpen] = useState(false);

  // Esc closes the panel — same affordance as every other floating panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement;
      // Don't swallow Esc when typing in an unrelated control.
      if ((t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.closest('.cap-panel')) return;
      selectCaption(null);
      setCaptionsPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectCaption, setCaptionsPanelOpen]);

  if (!timeline) return null;

  const row = selectedCaptionId
    ? timeline.captions.rows.find((r) => r.id === selectedCaptionId) ?? null
    : null;

  const defaults = timeline.captions.defaultStyle;
  const rowEff: CaptionStyle | null = row ? { ...defaults, ...(row.style ?? {}) } : null;
  const overrideKeys = new Set(Object.keys(row?.style ?? {}));

  // Scenes available for auto-caption — only the ones with an extracted VO
  // clip on the timeline. Without VO audio there's nothing to transcribe.
  // Source of truth is `audioTracks[*].clips` (the dynamic-lanes model);
  // the legacy `timeline.sfx.clips` shape isn't populated anymore. A VO
  // clip is marked by `kind === 'vo'` (set by scene-audio-reconciler when
  // it extracts audio off a generated video). Scene resolution: first try
  // the canonical `sfx_<sceneId>` id, then fall back to the linkId chain
  // (audio.linkId → V1 clip with same linkId → that V1 clip's sceneId).
  const sceneOptions = timeline.audioTracks
    .flatMap((tr) => tr.clips)
    .filter((c) => c.kind === 'vo')
    .map((c) => {
      let sceneId: string | null = null;
      if (c.id.startsWith('sfx_')) sceneId = c.id.slice(4);
      if (!sceneId && c.linkId) {
        const v1 = timeline.tracks.flatMap((tr) => tr.clips).find((vc) => vc.linkId === c.linkId);
        sceneId = v1?.sceneId ?? null;
      }
      if (!sceneId) return null;
      const scene = timeline.scenes.find((s) => s.id === sceneId);
      return scene ? { id: scene.id, label: scene.labels?.[0] ?? scene.id, prompt: (scene as { prompt?: string }).prompt ?? '' } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i);
  const allowedFromCount = sceneOptions.length;

  function close(): void {
    selectCaption(null);
    setCaptionsPanelOpen(false);
  }

  function setDefault(patch: Partial<CaptionStyle>): void {
    setCaptionsDefaultStyle(patch);
  }
  function setRowStyle(patch: Partial<CaptionStyle>): void {
    if (!row) return;
    patchCaptionRow(row.id, { style: { ...(row.style ?? {}), ...patch } });
  }
  function clearRowOverride(key: keyof CaptionStyle): void {
    if (!row?.style) return;
    const next = { ...row.style };
    delete (next as any)[key];
    patchCaptionRow(row.id, { style: Object.keys(next).length === 0 ? null : next });
  }
  function applyRowAsDefault(): void {
    if (!rowEff || !row) return;
    setCaptionsDefaultStyle(rowEff);
    patchCaptionRow(row.id, { style: null });
  }

  async function runAutoCaption(sceneId: string): Promise<void> {
    setScopedBusy(true);
    setMsg(null);
    try {
      // NO script — server transcribes with Whisper and uses those exact
      // words. Passing the scene's Seedance VISUAL prompt as a "script"
      // (previous behavior) was nonsense — visual directives aren't
      // dialogue. If a plan.json beat with real dialogue exists, the
      // server merges that in as the alignment script via plan-lookup.
      const res = await api.autoCaption({ sceneId, replace: true });
      if (res.ok) setMsg(`+${res.added} rows for ${sceneId}`);
      else setMsg(`${res.error}${res.detail ? ` — ${res.detail.slice(0, 120)}` : ''}`);
    } finally {
      setScopedBusy(false);
      setPickerOpen(false);
    }
  }
  async function runAutoCaptionAll(): Promise<void> {
    setAllBusy(true);
    setMsg('Captioning every scene with VO… this can take a minute');
    try {
      // clearAll: true is the default server-side, but pass explicitly so
      // intent is obvious at the call site.
      const res = await api.autoCaptionAll({ clearAll: true });
      if (res.ok) {
        const fails = (res.scenes ?? []).filter((s) => s.error).length;
        setMsg(`+${res.total} rows across ${(res.scenes ?? []).length} scenes${fails ? ` · ${fails} failed` : ''}`);
      } else {
        setMsg(`${res.error}${res.detail ? ` — ${res.detail.slice(0, 120)}` : ''}`);
      }
    } finally {
      setAllBusy(false);
    }
  }

  async function runDeleteAll(): Promise<void> {
    const count = timeline!.captions.rows.length;
    if (count === 0) { setMsg('No captions to delete'); return; }
    if (!window.confirm(`Delete all ${count} caption rows? This can't be undone.`)) return;
    setAllBusy(true);
    try {
      const res = await api.deleteAllCaptions();
      setMsg(res.ok ? `Cleared ${res.removed} rows` : (res.error ?? 'failed'));
    } finally { setAllBusy(false); }
  }

  return (
    <div className="cap-panel">
      <div className="cap-panel-head">
        <div className="cap-panel-title">Captions</div>
        {row && <div className="cap-panel-head-meta">row · {row.start.toFixed(2)}s → {row.end.toFixed(2)}s</div>}
        <button className="cap-panel-close" onClick={close} title="Close (Esc)">×</button>
      </div>

      <div className="cap-panel-body">
        {/* ── TRACK section — always visible ─────────────────────────── */}
        <section className="cap-section">
          <div className="cap-section-h">Whole timeline</div>
          <div className="cap-panel-row">
            <button
              className="btn primary"
              onClick={() => void runAutoCaptionAll()}
              disabled={allBusy || allowedFromCount === 0}
              title={allowedFromCount === 0
                ? 'No scene has extracted VO audio — generate scenes first'
                : `Wipe existing rows and auto-caption ${allowedFromCount} scene${allowedFromCount === 1 ? '' : 's'} with VO from scratch`}
            >{allBusy ? 'Captioning…' : 'Auto-caption all scenes'}</button>
            <button
              className="cap-delete"
              onClick={() => void runDeleteAll()}
              disabled={allBusy || timeline.captions.rows.length === 0}
              title="Wipe every caption row on the timeline"
            >Delete all ({timeline.captions.rows.length})</button>
          </div>
          <div className="cap-panel-row">
            <label className="cap-toggle">
              <input type="checkbox" checked={timeline.captions.enabled} onChange={(e) => setCaptionsEnabled(e.target.checked)} />
              <span>Show captions</span>
            </label>
          </div>
          {msg && <div className="cap-panel-msg">{msg}</div>}
        </section>

        <section className="cap-section">
          <div className="cap-section-h">Default style</div>
          <div className="cap-section-sub">Applied to every row except where you override below.</div>
          <DefaultStyleEditor style={defaults} onChange={setDefault} />
        </section>

        {/* ── ROW section — only when a caption row is selected ───── */}
        {row && rowEff ? (
          <section className="cap-section cap-section-row">
            <div className="cap-section-h">Selected row</div>
            <textarea
              className="cap-textarea"
              value={row.text}
              onChange={(e) => patchCaptionRow(row.id, { text: e.target.value })}
              rows={3}
              placeholder="Type the caption…"
              autoFocus
            />
            <div className="cap-panel-row">
              <button
                className="btn secondary"
                onClick={() => {
                  if (row.linkSceneId) void runAutoCaption(row.linkSceneId);
                  else if (sceneOptions.length === 1) void runAutoCaption(sceneOptions[0].id);
                  else setPickerOpen((v) => !v);
                }}
                disabled={scopedBusy || sceneOptions.length === 0}
                title={sceneOptions.length === 0 ? 'No scene has extracted VO audio yet' : 'Auto-caption from this scene\'s VO'}
              >{scopedBusy ? 'Captioning…' : 'Re-caption this scene'}</button>
              <button className="cap-delete" onClick={() => deleteCaptionRow(row.id)} title="Delete this row">Delete row</button>
            </div>
            {pickerOpen && sceneOptions.length > 1 && (
              <div className="cap-scene-picker">
                <div className="cap-scene-picker-h">Pick a scene</div>
                {sceneOptions.map((s) => (
                  <button key={s.id} className="cap-scene-pick" onClick={() => runAutoCaption(s.id)}>
                    <span className="cap-scene-pick-id">{s.label}</span>
                    {s.prompt && <span className="cap-scene-pick-prompt">{s.prompt.slice(0, 60)}…</span>}
                  </button>
                ))}
              </div>
            )}
            {/* Per-row style overrides are collapsed by default so the row
                section is mostly text + actions. Track-level Default style
                already handles the typical case (one look for the whole
                video); openers only matter when a single row deviates. */}
            <button
              className="cap-disclosure"
              onClick={() => setRowOverridesOpen((v) => !v)}
              title="Override style for just this caption row"
            >
              <span className={`cap-disclosure-caret ${rowOverridesOpen ? 'open' : ''}`}>▸</span>
              <span>Override style for this row</span>
              {overrideKeys.size > 0 && <span className="cap-disclosure-count">{overrideKeys.size}</span>}
            </button>
            {rowOverridesOpen && (
              <div className="cap-row-overrides">
                {/* Position (X%/Y%) is intentionally NOT a per-row override —
                    the whole caption band moves together. Edit X%/Y% in the
                    Default style above to reposition every row. */}
                <CapNum   label="Size"    value={rowEff.size}    min={12} max={120} step={2}            overridden={overrideKeys.has('size')}     onChange={(v) => setRowStyle({ size: v })}            onReset={() => clearRowOverride('size')} />
                <CapEnum  label="Weight"  value={String(rowEff.weight)} options={['400','600','700','800','900']} overridden={overrideKeys.has('weight')} onChange={(v) => setRowStyle({ weight: parseInt(v, 10) as any })} onReset={() => clearRowOverride('weight')} />
                <CapColor label="Color"   value={rowEff.color}    overridden={overrideKeys.has('color')} onChange={(v) => setRowStyle({ color: v })}    onReset={() => clearRowOverride('color')} />
                <CapEnum  label="Case"    value={rowEff.textCase} options={['none','caps']}              overridden={overrideKeys.has('textCase')} onChange={(v) => setRowStyle({ textCase: v as any })} onReset={() => clearRowOverride('textCase')} />
                <CapToggleSection
                  label="Background"
                  enabled={rowEff.bgEnabled}
                  onToggle={(v) => setRowStyle({ bgEnabled: v })}
                >
                  <CapText label="Color" value={rowEff.bg} placeholder="rgba(13,13,13,0.65)" overridden={overrideKeys.has('bg')} onChange={(v) => setRowStyle({ bg: v })} onReset={() => clearRowOverride('bg')} />
                </CapToggleSection>
                <CapToggleSection
                  label="Outline"
                  enabled={rowEff.outline.enabled}
                  onToggle={(v) => setRowStyle({ outline: { ...rowEff.outline, enabled: v } })}
                >
                  <CapColor label="Color" value={rowEff.outline.color} overridden={false} onChange={(v) => setRowStyle({ outline: { ...rowEff.outline, color: v } })} onReset={() => {}} />
                  <CapNum   label="Width" value={rowEff.outline.width} min={0} max={20} step={0.5} overridden={false} onChange={(v) => setRowStyle({ outline: { ...rowEff.outline, width: v } })} onReset={() => {}} />
                </CapToggleSection>
                <CapToggleSection
                  label="Shadow"
                  enabled={rowEff.shadow.enabled}
                  onToggle={(v) => setRowStyle({ shadow: { ...rowEff.shadow, enabled: v } })}
                >
                  <CapText label="Color"  value={rowEff.shadow.color} placeholder="rgba(0,0,0,0.8)" overridden={false} onChange={(v) => setRowStyle({ shadow: { ...rowEff.shadow, color: v } })} onReset={() => {}} />
                  <CapNum  label="Blur"   value={rowEff.shadow.blur} min={0} max={40} step={1} overridden={false} onChange={(v) => setRowStyle({ shadow: { ...rowEff.shadow, blur: v } })} onReset={() => {}} />
                  <CapNum  label="X off"  value={rowEff.shadow.dx} min={-30} max={30} step={1} overridden={false} onChange={(v) => setRowStyle({ shadow: { ...rowEff.shadow, dx: v } })} onReset={() => {}} />
                  <CapNum  label="Y off"  value={rowEff.shadow.dy} min={-30} max={30} step={1} overridden={false} onChange={(v) => setRowStyle({ shadow: { ...rowEff.shadow, dy: v } })} onReset={() => {}} />
                </CapToggleSection>
                <div className="cap-panel-row" style={{ marginTop: 6 }}>
                  <button className="btn secondary" onClick={applyRowAsDefault} title="Promote these overrides to project defaults + clear this row's overrides">Use as default</button>
                  <button className="btn secondary" onClick={() => patchCaptionRow(row.id, { style: null })} title="Reset this row to project defaults">Reset</button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <div className="cap-empty">Click a caption row on the CC lane to edit its text + per-row style overrides.</div>
        )}
      </div>
    </div>
  );
}

/** Track-level defaults editor. Same fields as the row editor but writes
 *  straight to `captions.defaultStyle` — no overrides system here. */
function DefaultStyleEditor({ style, onChange }: { style: CaptionStyle; onChange: (patch: Partial<CaptionStyle>) => void }) {
  return (
    <>
      <CapNum   label="X %"      value={style.xPct}     min={0} max={100} step={1}                         overridden={false} onChange={(v) => onChange({ xPct: v })}                  onReset={() => {}} />
      <CapNum   label="Y %"      value={style.yPct}     min={0} max={100} step={1}                         overridden={false} onChange={(v) => onChange({ yPct: v })}                  onReset={() => {}} />
      <CapNum   label="Size"     value={style.size}     min={12} max={120} step={2}                          overridden={false} onChange={(v) => onChange({ size: v })}                  onReset={() => {}} />
      <CapEnum  label="Weight"   value={String(style.weight)} options={['400','600','700','800','900']}     overridden={false} onChange={(v) => onChange({ weight: parseInt(v, 10) as any })} onReset={() => {}} />
      <CapColor label="Color"    value={style.color}                                                          overridden={false} onChange={(v) => onChange({ color: v })}                  onReset={() => {}} />
      <CapEnum  label="Align"    value={style.align}    options={['left','center','right']}                  overridden={false} onChange={(v) => onChange({ align: v as any })}          onReset={() => {}} />
      <CapEnum  label="Case"     value={style.textCase} options={['none','caps']}                            overridden={false} onChange={(v) => onChange({ textCase: v as any })}        onReset={() => {}} />
      <CapToggleSection
        label="Background"
        enabled={style.bgEnabled}
        onToggle={(v) => onChange({ bgEnabled: v })}
      >
        <CapText  label="Color"  value={style.bg} placeholder="rgba(13,13,13,0.65)" overridden={false} onChange={(v) => onChange({ bg: v })} onReset={() => {}} />
      </CapToggleSection>
      <CapToggleSection
        label="Outline"
        enabled={style.outline.enabled}
        onToggle={(v) => onChange({ outline: { ...style.outline, enabled: v } })}
      >
        <CapColor label="Color"  value={style.outline.color} overridden={false} onChange={(v) => onChange({ outline: { ...style.outline, color: v } })} onReset={() => {}} />
        <CapNum   label="Width"  value={style.outline.width} min={0} max={20} step={0.5} overridden={false} onChange={(v) => onChange({ outline: { ...style.outline, width: v } })} onReset={() => {}} />
      </CapToggleSection>
      <CapToggleSection
        label="Shadow"
        enabled={style.shadow.enabled}
        onToggle={(v) => onChange({ shadow: { ...style.shadow, enabled: v } })}
      >
        <CapText  label="Color"  value={style.shadow.color} placeholder="rgba(0,0,0,0.8)" overridden={false} onChange={(v) => onChange({ shadow: { ...style.shadow, color: v } })} onReset={() => {}} />
        <CapNum   label="Blur"   value={style.shadow.blur} min={0} max={40} step={1} overridden={false} onChange={(v) => onChange({ shadow: { ...style.shadow, blur: v } })} onReset={() => {}} />
        <CapNum   label="X off"  value={style.shadow.dx} min={-30} max={30} step={1} overridden={false} onChange={(v) => onChange({ shadow: { ...style.shadow, dx: v } })} onReset={() => {}} />
        <CapNum   label="Y off"  value={style.shadow.dy} min={-30} max={30} step={1} overridden={false} onChange={(v) => onChange({ shadow: { ...style.shadow, dy: v } })} onReset={() => {}} />
      </CapToggleSection>
    </>
  );
}

function CapToggleSection({ label, enabled, onToggle, children }: {
  label: string; enabled: boolean; onToggle: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className="cap-toggle-section">
      <label className="cap-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>{label}</span>
      </label>
      {enabled && <div className="cap-toggle-children">{children}</div>}
    </div>
  );
}

function CapNum({ label, value, min, max, step, overridden, onChange, onReset }: {
  label: string; value: number; min: number; max: number; step: number;
  overridden: boolean; onChange: (v: number) => void; onReset: () => void;
}) {
  return (
    <div className={`cap-row ${overridden ? 'overridden' : ''}`}>
      <span className="cap-field-label">{label}</span>
      <input className="cap-input" type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      {overridden && <button className="cap-reset" onClick={onReset} title="Use project default">↺</button>}
    </div>
  );
}
function CapEnum({ label, value, options, overridden, onChange, onReset }: {
  label: string; value: string; options: string[]; overridden: boolean;
  onChange: (v: string) => void; onReset: () => void;
}) {
  return (
    <div className={`cap-row ${overridden ? 'overridden' : ''}`}>
      <span className="cap-field-label">{label}</span>
      <select className="cap-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {overridden && <button className="cap-reset" onClick={onReset} title="Use project default">↺</button>}
    </div>
  );
}
function CapColor({ label, value, overridden, onChange, onReset }: {
  label: string; value: string; overridden: boolean;
  onChange: (v: string) => void; onReset: () => void;
}) {
  return (
    <div className={`cap-row ${overridden ? 'overridden' : ''}`}>
      <span className="cap-field-label">{label}</span>
      <input className="cap-input cap-color" type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onChange={(e) => onChange(e.target.value)} />
      <input className="cap-input" value={value} onChange={(e) => onChange(e.target.value)} />
      {overridden && <button className="cap-reset" onClick={onReset} title="Use project default">↺</button>}
    </div>
  );
}
function CapText({ label, value, overridden, placeholder, onChange, onReset }: {
  label: string; value: string; overridden: boolean; placeholder?: string;
  onChange: (v: string) => void; onReset: () => void;
}) {
  return (
    <div className={`cap-row ${overridden ? 'overridden' : ''}`}>
      <span className="cap-field-label">{label}</span>
      <input className="cap-input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {overridden && <button className="cap-reset" onClick={onReset} title="Use project default">↺</button>}
    </div>
  );
}
