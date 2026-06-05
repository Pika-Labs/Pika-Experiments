import { useEffect, useState } from 'react';

type Preset = 'draft' | 'standard' | 'high';

interface Props {
  defaultFilename: string;        // e.g. "parrot-vs-cat.mp4"
  defaultPreset: Preset;
  onCancel: () => void;
  onConfirm: (settings: { filename: string; saveDir: string; preset: Preset }) => void;
}

const FOLDER_PRESETS: { label: string; path: string }[] = [
  { label: 'Downloads', path: '~/Downloads' },
  { label: 'Desktop',   path: '~/Desktop' },
  { label: 'Movies',    path: '~/Movies' },
];

const PRESET_NOTES: Record<Preset, string> = {
  draft:    'Fastest · larger file (CRF 23, ultrafast)',
  standard: 'Balanced quality + size (CRF 18, fast)',
  high:     'Best quality · slowest (CRF 14, fast)',
};

export function RenderModal({ defaultFilename, defaultPreset, onCancel, onConfirm }: Props) {
  const [filename, setFilename] = useState(defaultFilename);
  const [saveDir, setSaveDir] = useState(FOLDER_PRESETS[0].path);
  const [preset, setPreset] = useState<Preset>(defaultPreset);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) confirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function confirm() {
    const name = filename.trim() || defaultFilename;
    onConfirm({ filename: name, saveDir: saveDir.trim() || '~/Downloads', preset });
  }

  return (
    <div className="render-modal-backdrop" onClick={onCancel}>
      <div className="render-modal" style={{ width: 'min(540px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="render-modal-head">
          <div>
            <div className="render-modal-title">Export render</div>
            <div className="render-modal-sub">Choose where to save, then start the export</div>
          </div>
          <button className="render-modal-close" onClick={onCancel}>×</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Field label="Filename">
            <input
              className="rm-input"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="my-render.mp4"
              autoFocus
            />
          </Field>

          <Field label="Save to folder">
            <input
              className="rm-input"
              value={saveDir}
              onChange={(e) => setSaveDir(e.target.value)}
              placeholder="~/Downloads"
              spellCheck={false}
            />
            <div className="rm-chip-row">
              {FOLDER_PRESETS.map((p) => (
                <button
                  key={p.path}
                  className={`rm-chip ${saveDir === p.path ? 'on' : ''}`}
                  onClick={() => setSaveDir(p.path)}
                >{p.label}</button>
              ))}
            </div>
          </Field>

          <Field label="Quality">
            <div className="rm-preset-row">
              {(['draft', 'standard', 'high'] as Preset[]).map((p) => (
                <button
                  key={p}
                  className={`rm-preset ${preset === p ? 'on' : ''}`}
                  onClick={() => setPreset(p)}
                >
                  <span className="rm-preset-name">{p}</span>
                  <span className="rm-preset-note">{PRESET_NOTES[p]}</span>
                </button>
              ))}
            </div>
          </Field>
        </div>

        <div className="render-modal-actions">
          <button className="btn secondary" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={confirm}>Render</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="rm-field-label">{label}</span>
      {children}
    </label>
  );
}
