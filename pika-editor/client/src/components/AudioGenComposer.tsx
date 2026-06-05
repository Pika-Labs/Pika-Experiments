import { useEffect, useRef, useState } from 'react';
import { useEscapeKey } from '../useEscapeKey';
import * as api from '../api';

interface Props {
  kind: 'sfx' | 'music';
  at: number;
  durationSec?: number;
  /** Screen coords of the click — composer pins here via position:fixed so it escapes lane-content overflow clipping. */
  screenX: number;
  screenY: number;
  /** Legacy SFX lane bucket — kept for back-compat, unused in the unified-audio model. */
  targetLane?: 'VO' | 'SFX1' | 'SFX2';
  /** Audio track id (a1, a2, …) of the lane the user clicked. Forwarded to
   *  the server's auto-place as the PREFERRED track so the generated SFX
   *  lands on the lane the user actually clicked, instead of always
   *  falling through to the first free track. */
  targetTrackId?: string;
  onClose: () => void;
}

export function AudioGenComposer({ kind, at, durationSec, screenX, screenY, targetLane, targetTrackId, onClose }: Props) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEscapeKey(true, onClose);

  async function submit() {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      if (kind === 'sfx') {
        const r = await api.generateSfx({ prompt: prompt.trim(), startSec: at, durationSec, lane: targetLane, trackId: targetTrackId });
        if ('error' in r) {
          alert(`${r.error}\n${(r as any).hint ?? ''}`);
        }
      } else {
        await api.generateMusic({ prompt: prompt.trim(), startSec: at, durationSec: durationSec ?? 30 });
      }
      onClose();
    } finally { setBusy(false); }
  }

  // Clamp to viewport so the popover never spills off-screen — composer is
  // ~280px wide + ~150px tall.
  const left = Math.max(12, Math.min(window.innerWidth - 292, screenX));
  const top = Math.max(12, Math.min(window.innerHeight - 200, screenY + 12));
  return (
    <div
      className="cmt-composer fixed-composer"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Wrapper-level handler so ⌘⏎ submits even if focus drifted off the
        // textarea (e.g. user tabbed onto Cancel and changed their mind).
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="cmt-composer-head">
        {kind === 'sfx' ? 'New SFX' : `New music · ${durationSec?.toFixed(1) ?? '30'}s`}
      </div>
      <textarea
        ref={ref}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder={kind === 'sfx'
          ? 'e.g. low whoosh with a soft tail'
          : 'e.g. dreamy synthwave (the server will fill in instruments, tempo, mood)'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          if (e.key === 'Escape') onClose();
        }}
      />
      {kind === 'music' && (
        <div style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 4 }}>
          Always instrumental. ElevenLabs music-v1 · {durationSec?.toFixed(1) ?? '30'}s.
        </div>
      )}
      <div className="cmt-composer-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !prompt.trim()} onClick={submit}>
          {busy ? 'Adding…' : kind === 'sfx' ? 'Generate' : 'Queue · ⌘⏎'}
        </button>
      </div>
    </div>
  );
}
