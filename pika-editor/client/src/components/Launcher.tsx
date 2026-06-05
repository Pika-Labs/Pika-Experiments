/**
 * Launcher — landing screen for fresh projects.
 *
 * Three states (only one renders at a time):
 *
 *   1. Pika NOT connected → big "Connect Pika" card. Nothing else.
 *      Once OAuth completes (pika-auth-changed SSE), we re-render in
 *      state 2.
 *
 *   2. Pika connected, presets fetched → grid of preset cards + the
 *      Custom card at the end + a centered composer underneath
 *      ("…or describe your own brief").
 *
 *   3. Mounting / loading → nothing (skeleton would flash; on fast
 *      local fetches this state lasts <100ms).
 *
 * Clicking a preset card fills the composer with the preset's
 * triggerText and focuses the input. The user adds specifics + hits
 * enter. Sending uses the existing /chat/stream endpoint via the
 * normal ChatPanel send pipeline — we flip `chatStarted` in the store
 * so App.tsx dismisses the launcher and mounts the editor proper.
 *
 * Topbar stays mounted above the launcher so the project switcher,
 * credits pill, and reconciler health are always reachable.
 */
import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import * as api from '../api';
import { useStore, assetUrl } from '../store';
import { subscribeServerEvents } from '../sse';

export function Launcher() {
  const [pikaConnected, setPikaConnected] = useState<boolean | null>(null);
  const [presets, setPresets] = useState<api.Preset[] | null>(null);
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const setChatStarted = useStore((s) => s.setChatStarted);
  const setPendingFirstMessage = useStore((s) => s.setPendingFirstMessage);
  // Same chatAttachments store the right-rail ChatPanel uses — anything
  // attached here survives the launcher → editor handoff for free, since
  // the store outlives the component swap. ChatPanel's first turn will
  // include these attachments in the message.
  const attachments = useStore((s) => s.chatAttachments);
  const attachToChat = useStore((s) => s.attachToChat);
  const removeChatAttachment = useStore((s) => s.removeChatAttachment);

  async function uploadAndAttach(files: FileList | File[]): Promise<void> {
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const r = await api.uploadRef(f);
        if (!r.ok) continue;
        const id = `att_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000).toString(36)}`;
        attachToChat({
          id,
          rel: r.rel.startsWith('assets/') ? r.rel : `assets/${r.rel}`,
          kind: r.kind,
          name: r.filename,
        });
      }
    } finally {
      setUploading(false);
    }
  }

  // Hydrate auth + presets in parallel.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/oauth/pika/status');
        if (r.ok) {
          const body = await r.json() as { authenticated: boolean };
          if (!cancelled) setPikaConnected(!!body.authenticated);
        } else if (!cancelled) setPikaConnected(false);
      } catch { if (!cancelled) setPikaConnected(false); }
    })();
    void (async () => {
      const list = await api.getPresets();
      if (!cancelled) setPresets(list);
    })();
    // Re-check auth whenever the oauth flow finishes.
    const off = subscribeServerEvents((ev) => {
      if ((ev as { type?: string }).type === 'pika-auth-changed') {
        const a = (ev as unknown as { authenticated: boolean }).authenticated;
        if (!cancelled) setPikaConnected(!!a);
      }
    });
    return () => { cancelled = true; off(); };
  }, []);

  async function startPikaAuth(): Promise<void> {
    try {
      const r = await fetch('/oauth/pika/start', { method: 'POST' });
      const body = await r.json() as { authorizeUrl?: string };
      if (body.authorizeUrl) window.open(body.authorizeUrl, '_blank', 'noopener');
    } catch { /* user can retry */ }
  }

  function pickPreset(p: api.Preset): void {
    if (p.kind === 'custom') {
      // Custom = just focus the inline composer; no pre-fill.
      textareaRef.current?.focus();
      return;
    }
    if (p.requiresPika && !pikaConnected) {
      void startPikaAuth();
      return;
    }
    setDraft(p.triggerText);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

  function submit(): void {
    const text = draft.trim();
    // Allow send when there's text OR at least one attachment — same
    // rule as the editor's right-rail composer. The empty-caption
    // attachments-only case uses a fallback caption inline so the
    // hydrate hook (which gates on `pendingFirstMessage` being
    // non-empty) still fires.
    if (!text && attachments.length === 0) return;
    const caption = text || '(no caption — please look at the attached file(s))';
    // Hand off to ChatPanel via the store. App immediately re-renders
    // with the editor (Launcher unmounts, ChatPanel mounts);
    // ChatPanel's mount hook reads pendingFirstMessage + chatAttachments
    // and prepends the [Attached files] header before firing the first
    // turn. No flicker — the transition is one React render away.
    setPendingFirstMessage(caption);
    setChatStarted(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter to send, Shift-Enter for newline — same convention as the
    // right-rail composer so the muscle memory transfers.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submit();
    }
  }

  // State 1: Pika not connected.
  if (pikaConnected === false) {
    return (
      <div className="launcher launcher-connect">
        <div className="launcher-connect-card">
          <div className="launcher-connect-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          </div>
          <div className="launcher-connect-title">CONNECT PIKA</div>
          <div className="launcher-connect-body">
            Generations route through your Pika wallet. Connect once and you&rsquo;re set — credits, persona, and voice all sync over.
          </div>
          <button className="pill dark launcher-connect-btn" onClick={() => void startPikaAuth()}>
            Connect Pika
          </button>
        </div>
      </div>
    );
  }

  // State 3: still loading.
  if (pikaConnected === null || presets === null) {
    return <div className="launcher launcher-loading" />;
  }

  // State 2: connected, presets ready.
  return (
    <div className="launcher launcher-presets">
      <div className="launcher-head">
        <h1 className="launcher-head-title">READY WHEN YOU ARE</h1>
        <p className="launcher-head-sub">
          Pick a preset, or scroll to the bottom and describe your own.
        </p>
      </div>

      <div className="preset-grid">
        {presets.map((p) => <PresetCard key={p.id} preset={p} onPick={pickPreset} />)}
      </div>

      <div className="launcher-composer">
        <div className="launcher-composer-label">Or describe what you want to make</div>
        {attachments.length > 0 && (
          <div className="launcher-composer-chips">
            {attachments.map((a) => (
              <LauncherAttachmentChip
                key={a.id}
                attachment={a}
                onRemove={() => removeChatAttachment(a.id)}
              />
            ))}
          </div>
        )}
        <div className="launcher-composer-row">
          <textarea
            ref={textareaRef}
            className="launcher-composer-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Describe your brief — a 30-second product teaser, a podcast about AGI, a short drama about lost twins…"
            rows={3}
            autoFocus
          />
          <div className="launcher-composer-actions">
            <button
              className="chat-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Attach an image, video, or audio reference"
              aria-label="Attach a reference"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              {uploading ? 'Uploading…' : 'Attach'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,audio/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files) void uploadAndAttach(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              className="pill dark launcher-composer-send"
              onClick={submit}
              disabled={!draft.trim() && attachments.length === 0}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Compact attachment chip for the launcher composer. Mirrors the
 *  right-rail ChatPanel chip but inlined here since the parent
 *  component isn't exported. */
function LauncherAttachmentChip({ attachment, onRemove }: {
  attachment: { id: string; rel: string; kind: 'image' | 'video' | 'audio' | 'other'; name: string };
  onRemove: () => void;
}) {
  const { rel, kind, name } = attachment;
  return (
    <div className="chat-chip" title={`${name}\n${rel}`}>
      <div className={`chat-chip-thumb chat-chip-thumb-${kind}`}>
        {kind === 'image' && <img src={assetUrl(rel)} alt="" />}
        {kind === 'video' && <video src={assetUrl(rel)} preload="metadata" muted playsInline />}
        {kind === 'audio' && (
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M3 12h2l2-5 4 14 3-9 2 4h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {kind === 'other' && <span className="chat-chip-ext">{(name.split('.').pop() ?? '?').toUpperCase()}</span>}
      </div>
      <div className="chat-chip-name">{name}</div>
      <button className="chat-chip-x" onClick={onRemove} aria-label="Remove attachment">×</button>
    </div>
  );
}

function PresetCard({ preset, onPick }: { preset: api.Preset; onPick: (p: api.Preset) => void }) {
  return (
    <button
      className="preset-card"
      onClick={() => onPick(preset)}
      title={preset.oneliner}
    >
      <div className="preset-card-media">
        {preset.previewSrc ? (
          <video
            className="preset-card-video"
            src={preset.previewSrc}
            autoPlay
            loop
            muted
            playsInline
          />
        ) : (
          <PresetPlaceholder kind={preset.kind} />
        )}
        {/* Title + oneliner overlaid on the media — white with soft drop
         *  shadow so it stays legible across any preview content. */}
        <div className="preset-card-overlay">
          <div className="preset-card-title">{preset.title}</div>
          <div className="preset-card-oneliner">{preset.oneliner}</div>
        </div>
      </div>
    </button>
  );
}

/** Placeholder shown when a preset doesn't (yet) have a sample
 *  output. Uses the brand's lavender tint + a kind-specific icon so
 *  the card still reads cleanly. */
function PresetPlaceholder({ kind }: { kind: api.Preset['kind'] }) {
  const icon = kind === 'video' ? (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7L8 5z" />
    </svg>
  ) : kind === 'image' ? (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ) : kind === 'brand' ? (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-7" />
    </svg>
  ) : kind === 'audio' ? (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <line x1="4" y1="12" x2="4" y2="12" />
      <line x1="8" y1="8" x2="8" y2="16" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="16" y1="8" x2="16" y2="16" />
      <line x1="20" y1="12" x2="20" y2="12" />
    </svg>
  ) : (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" strokeLinecap="round" />
      <line x1="5" y1="12" x2="19" y2="12" strokeLinecap="round" />
    </svg>
  );
  return <div className="preset-card-placeholder">{icon}</div>;
}
