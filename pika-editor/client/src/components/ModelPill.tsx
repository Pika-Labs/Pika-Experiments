/**
 * ModelPill — top-right of the chat header. Two surfaces in one:
 *
 *   - No API key set → "BYOK" pill. Click opens a modal that takes a
 *     Claude API key, POSTs it to /agent/config. Key goes straight into
 *     server/.env (atomic write) and process.env so the next /chat/stream
 *     turn picks it up without a restart.
 *
 *   - Key set → "Opus 4.7 ▾" model name + chevron. Click opens a tiny
 *     dropdown listing the available models; selecting one POSTs to
 *     /agent/config { model } and the next turn uses the new id.
 *
 * Security:
 *   - The key never lives in the browser. The POST request is the only
 *     time it crosses the wire. GET /agent/config returns `hasKey` only.
 *   - The input field is `type="password"` so the key isn't visible in
 *     screenshots / shoulder-surfing. The modal hints that the key is
 *     written to server/.env and points the user at console.anthropic.com.
 */
import { useEffect, useRef, useState } from 'react';
import * as api from '../api';

export function ModelPill() {
  const [config, setConfig] = useState<api.AgentConfig | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  async function refresh(): Promise<void> {
    try { setConfig(await api.getAgentConfig()); } catch {/* offline */}
  }
  useEffect(() => { void refresh(); }, []);

  // Click-outside to close the model dropdown. The modal owns its own
  // overlay so it doesn't need this.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  async function chooseModel(id: string): Promise<void> {
    setMenuOpen(false);
    const r = await api.setAgentConfig({ model: id });
    if (r.ok) void refresh();
  }

  if (!config) return <div className="chat-sub model-pill model-pill-loading">…</div>;

  if (!config.hasKey) {
    return (
      <>
        <button className="model-pill model-pill-byok" onClick={() => setKeyModalOpen(true)} title="Add your Anthropic API key">
          <span className="model-pill-dot" /> BYOK
        </button>
        {keyModalOpen && (
          <ApiKeyModal
            hasKey={false}
            onClose={() => setKeyModalOpen(false)}
            onSaved={() => { setKeyModalOpen(false); void refresh(); }}
          />
        )}
      </>
    );
  }

  const active = config.availableModels.find((m) => m.id === config.model);
  return (
    <div className="model-pill-wrap" ref={wrapRef}>
      <button
        className="model-pill model-pill-active"
        onClick={() => setMenuOpen((v) => !v)}
        title={`Model · ${active?.label ?? config.model}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <span>{active?.label ?? config.model}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {menuOpen && (
        <div className="model-menu" role="menu">
          {config.availableModels.map((m) => (
            <button
              key={m.id}
              role="menuitem"
              className={`model-menu-item ${m.id === config.model ? 'on' : ''}`}
              onClick={() => void chooseModel(m.id)}
            >
              <span className="model-menu-name">{m.label}</span>
              <span className="model-menu-tier">{m.tier}</span>
            </button>
          ))}
          <div className="model-menu-sep" />
          <button
            role="menuitem"
            className="model-menu-item model-menu-key"
            onClick={() => { setMenuOpen(false); setKeyModalOpen(true); }}
          >
            <span className="model-menu-name">Update API key…</span>
          </button>
        </div>
      )}
      {keyModalOpen && (
        <ApiKeyModal
          hasKey={true}
          onClose={() => setKeyModalOpen(false)}
          onSaved={() => { setKeyModalOpen(false); void refresh(); }}
        />
      )}
    </div>
  );
}

function ApiKeyModal({ hasKey, onClose, onSaved }: {
  hasKey: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [oaiValue, setOaiValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hasOAI, setHasOAI] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    void api.getAgentConfig().then((c) => setHasOAI(c.hasOpenAIKey)).catch(() => null);
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const body: { apiKey?: string; openaiApiKey?: string } = {};
      if (value.trim()) body.apiKey = value;
      if (oaiValue.trim()) body.openaiApiKey = oaiValue;
      if (!body.apiKey && !body.openaiApiKey) { setBusy(false); return; }
      const r = await api.setAgentConfig(body);
      if (r.ok) onSaved();
      else setErr(r.error ?? 'failed to save');
    } catch (e: any) {
      setErr(e?.message ?? 'failed to save');
    } finally {
      setBusy(false);
    }
  }

  async function clearKey(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.setAgentConfig({ clearKey: true });
      if (r.ok) onSaved();
      else setErr(r.error ?? 'failed to clear');
    } finally {
      setBusy(false);
    }
  }

  async function clearOAI(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.setAgentConfig({ clearOpenAIKey: true });
      if (r.ok) { setHasOAI(false); setOaiValue(''); }
      else setErr(r.error ?? 'failed to clear');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && (value.trim() || oaiValue.trim()) && !busy) void save();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card model-key-modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="modal-h">{hasKey ? 'Manage API keys' : 'Add your Anthropic API key'}</div>
        <div className="modal-p">
          Keys are written to <code>server/.env</code> and never leave this machine.
        </div>

        <div className="key-row">
          <div className="key-row-label">
            Anthropic <span className={`key-pill ${hasKey ? 'on' : 'off'}`}>{hasKey ? 'set' : 'required'}</span>
          </div>
          <div className="key-row-desc">
            Powers the text chat. Grab one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.
          </div>
          <input
            ref={inputRef}
            className="modal-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={hasKey ? 'sk-ant-…  (leave blank to keep current)' : 'sk-ant-…'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          {hasKey && (
            <button className="key-row-clear" onClick={() => void clearKey()} disabled={busy}>Remove</button>
          )}
        </div>

        <div className="key-row">
          <div className="key-row-label">
            OpenAI <span className={`key-pill ${hasOAI ? 'on' : 'off'}`}>{hasOAI ? 'set' : 'optional'}</span>
          </div>
          <div className="key-row-desc">
            Needed only for voice mode (realtime API). Grab one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com</a>.
          </div>
          <input
            className="modal-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={hasOAI ? 'sk-…  (leave blank to keep current)' : 'sk-…'}
            value={oaiValue}
            onChange={(e) => setOaiValue(e.target.value)}
            disabled={busy}
          />
          {hasOAI && (
            <button className="key-row-clear" onClick={() => void clearOAI()} disabled={busy}>Remove</button>
          )}
        </div>

        {err && <div className="modal-err">{err}</div>}
        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <button className="modal-btn modal-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={() => void save()}
            disabled={busy || (!value.trim() && !oaiValue.trim())}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
