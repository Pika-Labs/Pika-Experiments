/**
 * VoiceCallBar — inline strip rendered above the chat composer
 * whenever a voice call is active (or pending a key). Replaces the
 * earlier popup modal. Three states:
 *
 *   needs-key             → inline OpenAI-key form, "Save & call" CTA
 *   requesting/connecting → tiny status row with a pulsing dot
 *   live                  → mute + hang-up controls + the "on the line" badge
 *   error                 → red error row with dismiss
 *
 * Hidden when phase is `idle` — i.e. no call yet this mount. Voice
 * transcripts themselves don't live here; they're pushed into the
 * regular chat messages list so they read like any other turn.
 */
import { useState } from 'react';
import type { UseVoiceCallApi } from '../useVoiceCall';

export function VoiceCallBar({ voice }: { voice: UseVoiceCallApi }) {
  const { phase, error, muted, elapsedSec, hangUp, toggleMute, saveKeyAndConnect } = voice;
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);

  if (phase === 'idle' || phase === 'ended') return null;

  if (phase === 'needs-key') {
    return (
      <div className="voice-bar voice-bar-needkey">
        <div className="voice-bar-h">
          <span className="voice-dot voice-dot-needs-key" />
          <span className="voice-bar-title">OpenAI API key needed</span>
        </div>
        <div className="voice-bar-p">
          Voice mode uses OpenAI's realtime API. Key is written to <code>server/.env</code> and never leaves this machine.
        </div>
        <div className="voice-bar-row">
          <input
            className="modal-input voice-bar-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keyInput.trim() && !busy) void submit();
              if (e.key === 'Escape') hangUp();
            }}
            disabled={busy}
            autoFocus
          />
          <button className="voice-bar-btn voice-bar-cancel" onClick={hangUp} disabled={busy}>Cancel</button>
          <button
            className="voice-bar-btn voice-bar-call"
            onClick={() => void submit()}
            disabled={busy || !keyInput.trim()}
          >
            {busy ? 'Saving…' : 'Save & call'}
          </button>
        </div>
        {error && <div className="voice-bar-err">{error}</div>}
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="voice-bar voice-bar-err-state">
        <span className="voice-dot voice-dot-error" />
        <span className="voice-bar-title">Couldn't start the call</span>
        <span className="voice-bar-detail">{error ?? 'unknown error'}</span>
        <div style={{ flex: 1 }} />
        <button className="voice-bar-btn voice-bar-cancel" onClick={hangUp}>Dismiss</button>
      </div>
    );
  }

  // requesting / connecting / live
  return (
    <div className={`voice-bar voice-bar-${phase}`}>
      <span className={`voice-dot voice-dot-${phase}`} />
      <span className="voice-bar-title">
        {phase === 'requesting' && 'Getting mic permission…'}
        {phase === 'connecting' && 'Connecting…'}
        {phase === 'live'       && 'On the line'}
      </span>
      {phase === 'live' && (
        <span className="voice-bar-timer" title="Call duration (voice API is billed per minute)">
          {fmtElapsed(elapsedSec)}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {phase === 'live' && (
        <button
          className={`voice-bar-mic ${muted ? 'voice-bar-mic-off' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Unmute — agent will hear you again' : 'Mute — agent stops hearing you'}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
              <line x1="12" y1="19" x2="12" y2="23" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8"  y1="23" x2="16" y2="23" />
            </svg>
          )}
          {muted ? 'Unmute' : 'Mute'}
        </button>
      )}
      <button className="voice-bar-btn voice-bar-hangup" onClick={hangUp}>Hang up</button>
    </div>
  );

  function fmtElapsed(s: number): string {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  async function submit(): Promise<void> {
    setBusy(true);
    try { await saveKeyAndConnect(keyInput); setKeyInput(''); }
    finally { setBusy(false); }
  }
}
