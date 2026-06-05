import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { subscribeServerEvents } from '../sse';
import * as api from '../api';
import { useStore, assetUrl, type ChatAttachment } from '../store';
import { ModelPill } from './ModelPill';
import { VoiceCallBar } from './VoiceCallBar';
import { useVoiceCall } from '../useVoiceCall';

type Role = 'user' | 'assistant';

interface TextPart { type: 'text'; text: string }
interface ThinkingPart { type: 'thinking'; text: string }
interface ToolUsePart { type: 'tool_use'; name: string; input: unknown; status: 'running' | 'ok' | 'error'; resultPreview?: string }
type Part = TextPart | ThinkingPart | ToolUsePart;

interface Message {
  id: string;
  role: Role;
  parts: Part[];
  /** Optional tag — `btw` marks a side-stream Q&A that doesn't belong to
   *  the main agent thread. Renders distinctly so the user can see it
   *  was a quick side question, not part of the main task flow. */
  meta?: { kind: 'btw' };
}

let idCounter = 0;
const nextId = (): string => `m${++idCounter}_${Date.now().toString(36)}`;

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const draft = useStore((s) => s.chatDraft);
  const setDraft = useStore((s) => s.setChatDraft);
  const setView = useStore((s) => s.setView);
  const attachments = useStore((s) => s.chatAttachments);
  const attachToChat = useStore((s) => s.attachToChat);
  const removeAttachment = useStore((s) => s.removeChatAttachment);
  const clearAttachments = useStore((s) => s.clearChatAttachments);
  const clearSelection = useStore((s) => s.clearSelection);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dropHover, setDropHover] = useState(false);

  // Voice-call lifecycle. Transcripts stream into the same `messages`
  // list as text chat so the conversation reads as one continuous
  // thread regardless of which channel the user used. The voice
  // assistant deltas + tool calls accumulate into an in-flight
  // message id we hold across the turn via `voiceAssistantIdRef`.
  // Tool calls are rendered as `tool_use` parts — identical UI to
  // text-mode tool calls — so the user can see exactly what the
  // voice agent did and whether it succeeded.
  const voiceAssistantIdRef = useRef<string | null>(null);
  function ensureVoiceAssistantMessage(m: Message[]): { id: string; m: Message[] } {
    const id = voiceAssistantIdRef.current;
    if (id && m.length && m[m.length - 1].id === id) return { id, m };
    const newId = nextId();
    voiceAssistantIdRef.current = newId;
    return { id: newId, m: [...m, { id: newId, role: 'assistant', parts: [] }] };
  }
  const voice = useVoiceCall({
    onUserTurn: (text) => {
      const userMsg: Message = { id: nextId(), role: 'user', parts: [{ type: 'text', text }] };
      setMessages((m) => [...m, userMsg]);
    },
    onAssistantDelta: (delta) => {
      setMessages((prev) => {
        const { id, m } = ensureVoiceAssistantMessage(prev);
        const last = m[m.length - 1];
        const lastPart = last.parts[last.parts.length - 1];
        const nextParts = lastPart?.type === 'text'
          ? last.parts.slice(0, -1).concat({ ...lastPart, text: lastPart.text + delta })
          : last.parts.concat({ type: 'text', text: delta });
        void id;
        return m.slice(0, -1).concat({ ...last, parts: nextParts });
      });
    },
    onAssistantEnd: () => { voiceAssistantIdRef.current = null; },
    onToolStart: (callId, name, input) => {
      setMessages((prev) => {
        const { id, m } = ensureVoiceAssistantMessage(prev);
        const last = m[m.length - 1];
        // Stash callId in the input so onToolEnd can find this part.
        const nextParts = last.parts.concat({
          type: 'tool_use',
          name,
          input: { ...(typeof input === 'object' && input ? input : {}), _callId: callId },
          status: 'running',
        });
        void id;
        return m.slice(0, -1).concat({ ...last, parts: nextParts });
      });
    },
    onToolEnd: (callId, ok, preview) => {
      setMessages((prev) => prev.map((mm) => {
        const updated = mm.parts.map((p) => {
          if (p.type === 'tool_use' && (p.input as any)?._callId === callId && p.status === 'running') {
            return { ...p, status: ok ? 'ok' as const : 'error' as const, resultPreview: preview };
          }
          return p;
        });
        return { ...mm, parts: updated };
      }));
    },
  });
  const [streaming, setStreaming] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pending, setPending] = useState<string[]>([]);   // queued follow-ups
  const [pikaAuth, setPikaAuth] = useState<api.PikaAuthStatus | null>(null);
  const [persona, setPersona] = useState<api.AgentPersona | null>(null);
  const [chatStats, setChatStats] = useState<api.ChatStats | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compactNotice, setCompactNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<string[]>([]);
  pendingRef.current = pending;

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Hydrate the chat thread from the active project's persisted
  // conversation. Fires on mount AND every time the active project
  // changes — so opening a tab on Project-B no longer shows an empty
  // thread, and switching from A to B swaps the visible history in
  // step with the timeline / workspace.
  useEffect(() => {
    let cancelled = false;
    async function hydrate(): Promise<void> {
      try {
        const res = await fetch('/chat/history');
        if (!res.ok) return;
        const body = await res.json() as { messages: Message[] };
        if (cancelled) return;
        const next = body.messages ?? [];
        setMessages(next);
        // Flip chatStarted true if any history exists. NEVER force it
        // back to false from here — the launcher's `submit` sets it
        // true to hand off to the editor, and an empty `/chat/history`
        // would otherwise yank the user straight back to the launcher
        // mid-handoff. The "fresh project on tab open" case is already
        // covered by the store's default value of false.
        if (next.length > 0) useStore.getState().setChatStarted(true);
      } catch { /* offline / no history */ }
      // If the launcher captured a first message before ChatPanel
      // mounted, fire it directly via runTurn(text) — going through
      // the draft+send round-trip doesn't work because the `send`
      // closure references the stale `draft` from the initial render
      // (the store update hasn't reached this component yet). runTurn
      // takes the message as an explicit arg so the text is wired
      // straight into the POST /chat/stream body. Clear pending
      // immediately so HMR / double-mounts can't re-send.
      const pending = useStore.getState().pendingFirstMessage;
      if (pending && !cancelled) {
        // Same attachment-formatting path as send() — if the user
        // dropped files on the launcher composer, they're already in
        // the store; we prepend the [Attached files] header here so
        // the agent's first turn knows about them. Clear the chips
        // after formatting so the editor's right rail doesn't show
        // them lingering after the handoff.
        const atts = useStore.getState().chatAttachments;
        const fullText = buildMessageWithAttachments(pending, atts);
        useStore.getState().setPendingFirstMessage(null);
        if (atts.length > 0) useStore.getState().clearChatAttachments();
        void runTurn(fullText);
      }
    }
    void hydrate();
    // Re-hydrate when the project changes underneath us. Reset
    // chatStarted to false first so a fresh new project actually
    // shows the launcher — hydrate will set it back true if the new
    // project's chat history has messages.
    const off = subscribeServerEvents((ev) => {
      if (ev.type === 'project-changed') {
        useStore.getState().setChatStarted(false);
        // Drop any composer chips the user left from the previous
        // project's launcher. Without this, an attachment uploaded
        // under project A's assets/refs/uploads/ (with path like
        // "assets/refs/uploads/foo.png") would tag along into
        // project B's first turn — the agent's read_file would
        // either 404 or, worse, silently read B's same-named file
        // if one happens to exist.
        useStore.getState().clearChatAttachments();
        void hydrate();
      }
    });
    return () => { cancelled = true; off(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Workspace tiles dispatch `chat:focus` when the user clicks the "talk
  // about this" affordance, after the store has appended a reference token.
  // We focus the textarea + put the caret at the end so they can keep typing.
  useEffect(() => {
    const onFocus = () => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const v = el.value;
      el.setSelectionRange(v.length, v.length);
    };
    window.addEventListener('chat:focus', onFocus);
    return () => window.removeEventListener('chat:focus', onFocus);
  }, []);

  // Poll chat-buffer size so the meter stays current; auto-compact when
  // we cross 92% of the 1M cap. The API has built-in compaction enabled
  // (compact-2026-01-12 beta header) which keeps the buffer manageable
  // automatically — but auto-compact here is the second line of
  // defence in case the buffer grows faster than compaction trims it.
  // Server-side compaction is purely a truncation, no API call — safe
  // to trigger.
  useEffect(() => {
    let cancelled = false;
    async function refreshStats(): Promise<void> {
      const stats = await api.getChatStats();
      if (cancelled || !stats) return;
      setChatStats(stats);
      // Auto-compact at 92% to keep clear of the 1M ceiling. The user
      // gets a one-time notice; they can still hit Reset if preferred.
      if (stats.fractionUsed > 0.92 && !compacting) {
        setCompacting(true);
        const r = await api.compactChat();
        setCompacting(false);
        if (r.ok && r.droppedMessages) {
          setCompactNotice(`Auto-trimmed ${r.droppedMessages} old turns (${(r.beforeTokens! / 1000).toFixed(0)}K → ${(r.afterTokens! / 1000).toFixed(0)}K tokens)`);
          const next = await api.getChatStats();
          if (!cancelled && next) setChatStats(next);
          // Auto-dismiss the notice after 6s.
          window.setTimeout(() => setCompactNotice(null), 6000);
        }
      }
    }
    void refreshStats();
    const id = window.setInterval(refreshStats, 15000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [compacting]);

  async function manualCompact(): Promise<void> {
    if (compacting) return;
    setCompacting(true);
    const r = await api.compactChat();
    setCompacting(false);
    if (r.ok) {
      const next = await api.getChatStats();
      if (next) setChatStats(next);
      setCompactNotice(r.droppedMessages
        ? `Trimmed ${r.droppedMessages} old turns (${(r.beforeTokens! / 1000).toFixed(0)}K → ${(r.afterTokens! / 1000).toFixed(0)}K tokens)`
        : 'Nothing to trim — chat is already under target.');
      window.setTimeout(() => setCompactNotice(null), 6000);
    }
  }
  async function manualReset(): Promise<void> {
    if (!window.confirm('Clear the entire chat history? Project files stay on disk.')) return;
    await api.resetChat();
    setMessages([]);
    setChatStats({ tokens: 0, messageCount: 0, contextLimit: 1_000_000, fractionUsed: 0 });
  }

  // Paperclip / drop-zone upload. Each file goes to `assets/refs/uploads/`
  // via /upload/ref, then is auto-attached as a composer chip so the user
  // can immediately type something about it. Mirrors the old left-rail
  // upload zone but lives inline with the message they're writing.
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

  // Initial auth + persona load + live updates
  useEffect(() => {
    void api.getPikaAuthStatus().then(setPikaAuth).catch(() => { /* offline */ });
    void api.getAgentPersona().then(setPersona).catch(() => { /* offline */ });
    return subscribeServerEvents((ev) => {
      if (ev.type === 'pika-auth-changed') {
        setPikaAuth({ authenticated: Boolean(ev.authenticated) });
        if (!ev.authenticated) setPersona(null);
        // On auth-on, we DON'T refetch persona here — the server emits
        // persona-loaded once warmup completes (handled below).
      } else if (ev.type === 'persona-loaded') {
        void api.getAgentPersona().then(setPersona).catch(() => null);
      }
    });
  }, []);

  async function connectPika() {
    const r = await api.startPikaAuth();
    if (r.authorizeUrl) window.open(r.authorizeUrl, '_blank', 'noopener');
    else alert(r.error ?? 'Could not start Pika authorization.');
  }

  /** Run one full /chat/stream request. Set `interrupt: true` if this
   *  message is a /btw that aborted the previous turn — server preserves
   *  the partial assistant turn in that case. */
  async function runTurn(text: string, opts: { interrupt?: boolean } = {}) {
    const userMsg: Message = { id: nextId(), role: 'user', parts: [{ type: 'text', text }] };
    const assistantId = nextId();
    setMessages((m) => [...m, userMsg, { id: assistantId, role: 'assistant', parts: [{ type: 'text', text: '' }] }]);
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, interrupt: !!opts.interrupt }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`chat: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buf.indexOf('\n\n');
          if (nl < 0) break;
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (!chunk.startsWith('data: ')) continue;
          const payload = chunk.slice(6);
          if (payload === '[DONE]') continue;
          let ev: { type: string; [k: string]: unknown };
          try { ev = JSON.parse(payload); } catch { continue; }
          applyEvent(assistantId, ev, setMessages);
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const msg = (err as Error).message ?? 'chat failed';
        setMessages((m) => m.map((mm) => mm.id === assistantId
          ? { ...mm, parts: [...mm.parts, { type: 'text', text: `\n\n[error: ${msg}]` }] }
          : mm));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // Drain queue
      const next = pendingRef.current[0];
      if (next) {
        setPending((q) => q.slice(1));
        // Don't await — let the .finally chain unblock, then run next
        setTimeout(() => { void runTurn(next); }, 0);
      }
    }
  }

  /** Side-stream Q&A that runs IN PARALLEL with the main turn.
   *  Claude Code's `/btw` pattern. Hits the read-only /chat/btw route
   *  which fires a fresh Anthropic call with no tools — the main
   *  /chat/stream turn keeps running untouched. The btw user message
   *  + answer get their own ids in messages[] tagged `meta.kind=btw`
   *  so the UI can render them distinctly. Doesn't flip `streaming`. */
  async function runBtw(question: string): Promise<void> {
    const userMsg: Message = { id: nextId(), role: 'user', parts: [{ type: 'text', text: question }], meta: { kind: 'btw' } };
    const assistantId = nextId();
    setMessages((m) => [...m, userMsg, { id: assistantId, role: 'assistant', parts: [{ type: 'text', text: '' }], meta: { kind: 'btw' } }]);
    try {
      const res = await fetch('/chat/btw', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!res.ok || !res.body) throw new Error(`btw: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buf.indexOf('\n\n');
          if (nl < 0) break;
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (!chunk.startsWith('data: ')) continue;
          const payload = chunk.slice(6);
          if (payload === '[DONE]') continue;
          let ev: { type: string; [k: string]: unknown };
          try { ev = JSON.parse(payload); } catch { continue; }
          applyEvent(assistantId, ev, setMessages);
        }
      }
    } catch (err) {
      const msg = (err as Error).message ?? 'btw failed';
      setMessages((m) => m.map((mm) => mm.id === assistantId
        ? { ...mm, parts: [...mm.parts, { type: 'text', text: `\n\n[btw error: ${msg}]` }] }
        : mm));
    }
  }

  /** User hit send. Three paths:
   *   - idle: send right away
   *   - streaming + msg starts with "btw ": abort current, restart with this
   *   - streaming + plain msg: queue */
  async function send() {
    const text = draft.trim();
    const atts = attachments;
    // Allow send when there's text OR at least one attachment ("here, look
    // at this" with no caption is a valid intent).
    if (!text && atts.length === 0) return;
    const fullText = buildMessageWithAttachments(text, atts);
    setDraft('');
    // First send in a fresh project dismisses the launcher landing
    // screen — the editor proper takes over immediately so the user
    // doesn't see a mid-transition blank state.
    useStore.getState().setChatStarted(true);
    // Clear selection too — selection-derived chips would otherwise be
    // immediately re-added by the syncSelectionAttachments effect, leaving
    // the pill visible even after the user sent it. Treating send as "I'm
    // done referring to that clip" matches the user's mental model; they
    // can re-select if they want to send another reference.
    clearSelection();
    clearAttachments();
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    if (!streaming) {
      void runTurn(fullText);
      return;
    }
    // /btw pattern (Claude Code style). The question fires a parallel
    // read-only side-stream to /chat/btw — the main turn keeps
    // running untouched. Strip the prefix before sending so the model
    // doesn't see "/btw " in the question itself.
    if (/^\/?btw\b/i.test(text)) {
      const stripped = text.replace(/^\/?btw\s*/i, '').trim();
      if (stripped) void runBtw(stripped);
      return;
    }
    setPending((q) => [...q, fullText]);
  }

  function cancelQueued(idx: number) {
    setPending((q) => q.filter((_, i) => i !== idx));
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a newline. Cmd/Ctrl+Enter also sends
    // (mostly muscle memory from before this change).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const pikaConnected = pikaAuth?.authenticated ?? false;
  const authChecked = pikaAuth !== null;

  return (
    <div className="chat">
      <div className="chat-header">
        <div className="chat-identity">
          {persona?.avatarUrl ? (
            <img className="chat-avatar" src={persona.avatarUrl} alt={persona.name} />
          ) : (
            <div className="chat-avatar chat-avatar-fallback">{persona?.emoji ?? '✦'}</div>
          )}
          <div className="chat-title">{persona?.name ?? 'Agent'}</div>
        </div>
        <div className="chat-header-right">
          {pikaAuth && (
            <button
              className={`chat-pika-pill ${pikaConnected ? 'chat-pika-on' : 'chat-pika-off'}`}
              onClick={pikaConnected ? undefined : connectPika}
              title={pikaConnected ? 'Pika connected' : 'Click to connect Pika'}
            >
              <span className="chat-pika-dot" />
              Pika
            </button>
          )}
          <button
            className={`voice-btn ${voice.active ? 'voice-btn-active' : ''}`}
            onClick={() => voice.start()}
            disabled={voice.phase === 'live' || voice.phase === 'connecting' || voice.phase === 'requesting' || voice.phase === 'needs-key'}
            title={voice.active ? 'Call in progress' : 'Voice call with the agent'}
            aria-label="Start voice call"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </button>
          <ModelPill />
        </div>
      </div>

      {/* Context meter — only renders once we have a stats snapshot.
       *  Pure indicator at low usage; surfaces Compact + Reset
       *  affordances starting at 50% so they're always one click away
       *  before the next danger threshold. Red at >85%. */}
      {chatStats && (
        <div className={`chat-ctx-meter ${chatStats.fractionUsed > 0.85 ? 'chat-ctx-meter-danger' : chatStats.fractionUsed > 0.5 ? 'chat-ctx-meter-warn' : ''}`}>
          <div className="chat-ctx-meter-row">
            <span className="chat-ctx-meter-label">
              Context {(chatStats.fractionUsed * 100).toFixed(0)}% · {(chatStats.tokens / 1000).toFixed(0)}K / 1M tokens
            </span>
            <div className="chat-ctx-meter-actions">
              <button
                className="chat-ctx-btn"
                onClick={() => void manualCompact()}
                disabled={compacting}
                title="Drop oldest turns until under 500K tokens — project files stay intact"
              >{compacting ? 'Compacting…' : 'Compact'}</button>
              <button
                className="chat-ctx-btn chat-ctx-btn-danger"
                onClick={() => void manualReset()}
                title="Clear chat entirely (project files stay)"
              >Reset</button>
            </div>
          </div>
          <div className="chat-ctx-meter-bar">
            <div className="chat-ctx-meter-fill" style={{ width: `${Math.min(100, chatStats.fractionUsed * 100)}%` }} />
          </div>
          {compactNotice && <div className="chat-ctx-meter-notice">{compactNotice}</div>}
        </div>
      )}

      {/* Pika is mandatory — show a hero connect gate when not authenticated.
          We wait for authChecked so we don't flash the gate during the
          first /oauth/pika/status request. */}
      {authChecked && !pikaConnected ? (
        <div className="chat-gate">
          <div className="chat-gate-card">
            <div className="chat-gate-icon">✦</div>
            <div className="chat-gate-h">Connect Pika to start</div>
            <div className="chat-gate-p">
              Your agent generates images, videos, and music through your Pika account. Connect once — the tokens stay on this Mac, same trust model as Claude Code.
            </div>
            <button className="chat-gate-btn" onClick={connectPika}>Connect Pika</button>
            <div className="chat-gate-sub">Opens pika.me in a new tab. You'll come back here when authorized.</div>
          </div>
        </div>
      ) : (
        <>
          <div className="chat-scroll" ref={scrollerRef}>
            {messages.length === 0 && (
              <div className="chat-empty">
                <div className="chat-empty-h">Ready</div>
                <div className="chat-empty-p">
                  Ask me to plan, edit, or generate. I read your project files, drive the editor, and call Pika directly.
                </div>
              </div>
            )}
            {messages.map((m, idx) => (
              <MessageView key={m.id} message={m} streaming={streaming && idx === messages.length - 1} />
            ))}
            {streaming && shouldShowDots(messages) && <ChatDots />}
          </div>
          <VoiceCallBar voice={voice} />
          <div
            className={`chat-composer ${dropHover ? 'chat-composer-dropover' : ''}`}
            onDragOver={(e) => {
              if (!e.dataTransfer?.types.includes('Files')) return;
              e.preventDefault();
              setDropHover(true);
            }}
            onDragLeave={() => setDropHover(false)}
            onDrop={(e) => {
              if (!e.dataTransfer?.files?.length) return;
              e.preventDefault();
              setDropHover(false);
              void uploadAndAttach(e.dataTransfer.files);
            }}
          >
            {pending.length > 0 && (
              <div className="chat-queue">
                {pending.map((q, i) => (
                  <span key={i} className="chat-queue-chip" title={q}>
                    <span className="chat-queue-text">{q.length > 60 ? q.slice(0, 60) + '…' : q}</span>
                    <button className="chat-queue-x" onClick={() => cancelQueued(i)}>×</button>
                  </span>
                ))}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="chat-chips">
                {attachments.map((a) => (
                  <AttachmentChipView
                    key={a.id}
                    attachment={a}
                    onRemove={() => {
                      // Selection-derived chip: deselect the underlying
                      // clip AND remove the chip directly. We used to
                      // rely on Timeline.tsx's selection→attachment sync
                      // effect to drop the chip on next render, but that
                      // effect only runs while Timeline is mounted. On
                      // Workspace view (Timeline unmounted) the chip
                      // would stick around with no way to remove it
                      // without going back to Timeline. The chip id is
                      // `sel_<clipId>` (see Timeline.tsx).
                      if (a.fromSelection && a.id.startsWith('sel_')) {
                        const clipId = a.id.slice(4);
                        const cur = useStore.getState().selectedClipIds;
                        const next = cur.filter((x) => x !== clipId);
                        useStore.setState({ selectedClipIds: next });
                      }
                      removeAttachment(a.id);
                    }}
                  />
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="chat-textarea-auto"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                // Auto-grow: snap height back so we can MEASURE the
                // natural scrollHeight, then set it to max(min-rows,
                // measured). The CSS min-height handles the 3-row
                // baseline; we only push above it.
                const el = e.currentTarget;
                el.style.height = 'auto';
                const MAX = 240;          // ~10 lines at 24px line-height
                el.style.height = Math.min(el.scrollHeight, MAX) + 'px';
              }}
              onKeyDown={onKeyDown}
              placeholder={streaming ? 'Agent is working · ↩ queues for after · "/btw …" answers in parallel · ⇧↩ newline' : 'Message the agent · ↩ to send · ⇧↩ newline'}
              rows={3}
            />
            <div className="chat-composer-row">
              <button
                className="chat-attach-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Attach a reference (image, video, or audio)"
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
              <div className="chat-hint">
                ↩ {streaming ? 'queue' : 'send'} · ⇧↩ newline
              </div>
              {streaming
                ? <button className="chat-send chat-stop" onClick={stop}>Stop</button>
                : <button className="chat-send" onClick={() => void send()} disabled={!draft.trim()}>Send</button>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Reducer for incoming SSE events. MUST be pure / immutable — React Strict
 * Mode runs state updaters twice in dev to surface mutation bugs, and any
 * `last.text += delta` style mutation will double-append (we hit this with
 * text appearing twice mid-stream). Every part object is replaced, never
 * mutated.
 */
function applyEvent(
  assistantId: string,
  ev: { type: string; [k: string]: unknown },
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  setMessages((msgs) => msgs.map((m) => {
    if (m.id !== assistantId) return m;
    const parts = m.parts.slice();
    const last = parts[parts.length - 1];
    const delta = String(ev.text ?? '');

    if (ev.type === 'text_delta') {
      if (last && last.type === 'text') parts[parts.length - 1] = { ...last, text: last.text + delta };
      else parts.push({ type: 'text', text: delta });
    } else if (ev.type === 'thinking_delta') {
      if (last && last.type === 'thinking') parts[parts.length - 1] = { ...last, text: last.text + delta };
      else parts.push({ type: 'thinking', text: delta });
    } else if (ev.type === 'thinking_start') {
      // Coalesce an empty trailing thinking block (idempotent under Strict Mode)
      if (!last || last.type !== 'thinking' || last.text) parts.push({ type: 'thinking', text: '' });
    } else if (ev.type === 'text_start') {
      if (!last || last.type !== 'text' || last.text) parts.push({ type: 'text', text: '' });
    } else if (ev.type === 'tool_start') {
      parts.push({ type: 'tool_use', name: String(ev.name ?? '?'), input: ev.input, status: 'running' });
    } else if (ev.type === 'tool_end') {
      // Replace the last running tool with a settled copy — find from the tail
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.type === 'tool_use' && p.status === 'running') {
          parts[i] = {
            ...p,
            status: ev.error ? 'error' : 'ok',
            resultPreview: ev.preview ? String(ev.preview) : undefined,
          };
          break;
        }
      }
    }
    return { ...m, parts };
  }));
}

function MessageView({ message, streaming }: { message: Message; streaming: boolean }) {
  // The "live" part is the trailing text/thinking part of the assistant
  // message — that's the only one being streamed right now.
  const liveIdx = streaming && message.role === 'assistant'
    ? lastIndex(message.parts, (p) => p.type === 'text' || p.type === 'thinking')
    : -1;
  // Coalesce consecutive tool_use parts at render time so the chat doesn't
  // get spammed with one technical pill per tool call.
  const groups = groupParts(message.parts);
  return (
    <div className={`chat-msg chat-msg-${message.role} ${message.meta?.kind === 'btw' ? 'chat-msg-btw' : ''}`}>
      {message.meta?.kind === 'btw' && message.role === 'user' && (
        <span className="chat-btw-tag" title="Side question — main task is still running">btw</span>
      )}
      {groups.map((g, gi) => {
        if (g.kind === 'part') {
          const i = g.index;
          const p = g.part;
          if (p.type === 'text') {
            if (!p.text && i !== liveIdx) return null;
            // User messages may carry an "[Attached file]" header from the
            // send pipeline. Render it as a chip strip + the caption below,
            // not as raw debug text.
            if (message.role === 'user' && i !== liveIdx) {
              const split = splitAttachments(p.text);
              return (
                <div key={gi} className="chat-text">
                  {split.attachments.length > 0 && (
                    <div className="chat-msg-chips">
                      {split.attachments.map((a, ai) => (
                        <MsgChip key={ai} att={a} />
                      ))}
                    </div>
                  )}
                  {split.text && <div>{split.text}</div>}
                </div>
              );
            }
            return (
              <div key={gi} className={`chat-text ${i === liveIdx ? 'chat-text-streaming' : ''}`}>
                {i === liveIdx ? <TypewriterText text={p.text} /> : p.text}
              </div>
            );
          }
          if (p.type === 'thinking') {
            if (!p.text && i !== liveIdx) return null;
            return <ThinkingBlock key={gi} text={p.text} live={i === liveIdx} />;
          }
          return null;
        }
        return <ToolCluster key={gi} tools={g.tools} />;
      })}
    </div>
  );
}

interface ParsedAttachment { rel: string; kind: 'image' | 'video' | 'audio' | 'other'; name: string }

/** Pull "[Attached file]" / "[Attached files]" header off the front of a
 *  user message and return both the parsed attachment list and the
 *  remaining caption text. Tolerates either singular / plural label and
 *  either "(kind)" suffix or none (kind defaults to 'other'). */
function splitAttachments(raw: string): { attachments: ParsedAttachment[]; text: string } {
  if (!raw.startsWith('[Attached file')) return { attachments: [], text: raw };
  const lines = raw.split('\n');
  const attachments: ParsedAttachment[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('- ')) {
      // "- assets/path/to/file.ext  (kind)"
      const m = /^- (.+?)(?:\s+\(([a-z]+)\))?\s*$/i.exec(line.trim());
      if (m) {
        const rel = m[1].trim();
        const kind = (['image','video','audio','other'].includes((m[2] ?? '').toLowerCase())
          ? (m[2]!.toLowerCase() as ParsedAttachment['kind'])
          : 'other');
        const name = rel.split('/').pop() ?? rel;
        attachments.push({ rel, kind, name });
        continue;
      }
    }
    if (line.trim() === '') { i++; break; }   // blank line = end of header
    // Unrecognized line — bail and treat the whole thing as plain text.
    return { attachments: [], text: raw };
  }
  // Skip the placeholder caption the send pipeline injects when the user
  // attached without typing anything.
  const rest = lines.slice(i).join('\n').trim();
  const text = rest === '(no caption — please look at the attached file(s))' ? '' : rest;
  return { attachments, text };
}

/** Mini chip rendered inside a chat-history user bubble. Smaller than the
 *  composer chip (24px square) and not removable — the message has
 *  already been sent. */
function MsgChip({ att }: { att: ParsedAttachment }) {
  return (
    <div className={`chat-msg-chip chat-msg-chip-${att.kind}`} title={att.rel}>
      <div className="chat-msg-chip-thumb">
        {att.kind === 'image' && <img src={assetUrl(att.rel)} alt="" />}
        {att.kind === 'video' && <video src={assetUrl(att.rel)} preload="metadata" muted playsInline />}
        {att.kind === 'audio' && (
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M3 12h2l2-5 4 14 3-9 2 4h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {att.kind === 'other' && (
          <span className="chat-msg-chip-ext">{(att.name.split('.').pop() ?? '?').toUpperCase()}</span>
        )}
      </div>
      <span className="chat-msg-chip-name">{att.name}</span>
    </div>
  );
}

type RenderGroup =
  | { kind: 'part'; index: number; part: Part }
  | { kind: 'tools'; tools: ToolUsePart[] };

function groupParts(parts: Part[]): RenderGroup[] {
  const out: RenderGroup[] = [];
  let pendingTools: ToolUsePart[] = [];
  parts.forEach((p, i) => {
    if (p.type === 'tool_use') {
      pendingTools.push(p);
    } else {
      if (pendingTools.length) { out.push({ kind: 'tools', tools: pendingTools }); pendingTools = []; }
      out.push({ kind: 'part', index: i, part: p });
    }
  });
  if (pendingTools.length) out.push({ kind: 'tools', tools: pendingTools });
  return out;
}

function lastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

/**
 * Typewriter — decouples display from network jitter. We keep `target` (full
 * incoming text) in a ref and progressively reveal it via requestAnimationFrame.
 * Reveal rate scales with buffer size: small buffer → ~200 chars/sec for that
 * live typed feel; bigger buffer (chunky deltas) → up to ~2000 chars/sec to
 * catch up without ever feeling laggy.
 */
function TypewriterText({ text }: { text: string }) {
  const [displayed, setDisplayed] = useState('');
  const targetRef = useRef(text);
  targetRef.current = text;
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setDisplayed((d) => {
        const t = targetRef.current;
        const remaining = t.length - d.length;
        if (remaining <= 0) return d;
        // Live typing while we're close to caught-up, fast catch-up on bursts
        const rate = remaining < 8 ? 220 : remaining < 30 ? 700 : 1800;
        const add = Math.max(1, Math.floor(dt * rate));
        return t.slice(0, Math.min(t.length, d.length + add));
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  // When the component unmounts mid-stream OR the parent flips streaming off,
  // the live class is dropped and the parent re-renders this position as
  // plain text — at which point we want the user to see the full string, not
  // whatever displayed got to. The parent handles that branch; here we just
  // animate up to whatever the latest target is.
  return <>{displayed}</>;
}

function ChatDots() {
  return <div className="chat-dots"><span /><span /><span /></div>;
}

/** Inline three-dot trail for use after a label like THINKING or READING.
 *  Smaller and tighter than the standalone ChatDots; lives in flow with text. */
function DotTrail() {
  return <span className="dot-trail" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>;
}

function shouldShowDots(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return false;
  return !last.parts.some((p) => {
    if (p.type === 'text' || p.type === 'thinking') return p.text.length > 0;
    return true; // tool_use counts as content
  });
}

function ThinkingBlock({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  // First line, trimmed, as the collapsed preview
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
  return (
    <div className={`chat-think ${open ? 'chat-think-open' : ''} ${live ? 'chat-think-live' : ''}`}>
      <button className="chat-think-head" onClick={() => setOpen(!open)}>
        <span className="chat-think-chev">{open ? '▾' : '▸'}</span>
        <span className="chat-think-label">Thinking{live && <DotTrail />}</span>
        {!open && preview && (
          <span className="chat-think-preview">
            {live ? <TypewriterText text={preview} /> : preview}
          </span>
        )}
      </button>
      {open && (
        <div className="chat-think-body">
          {live ? <TypewriterText text={text} /> : text}
        </div>
      )}
    </div>
  );
}

function previewInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object') return String(input);
  const obj = input as Record<string, unknown>;
  for (const k of ['path', 'rel', 'pattern', 'prompt', 'command', 'query']) {
    if (typeof obj[k] === 'string' && obj[k]) return String(obj[k]);
  }
  return '';
}

/** Translate tool name + args into a friendly verb + subject. The subject
 *  should be informative on its own (file name, command with key arg) — a
 *  reader scanning the chat should understand what the agent did without
 *  expanding anything. */
function friendlyTool(t: ToolUsePart): { verb: string; subject: string; group: string } {
  const args = (t.input ?? {}) as Record<string, unknown>;
  const basename = (s: string) => s.split('/').pop() || s;
  const shortPath = (s: string) => {
    const parts = s.split('/').filter(Boolean);
    return parts.slice(-2).join('/') || s;
  };
  // For shell commands, keep something meaningful — verb + last informative
  // arg (basename of the last path-looking token, or the next word).
  const shortCmd = (s: string) => {
    const trimmed = s.trim();
    if (trimmed.length <= 36) return trimmed;
    const words = trimmed.split(/\s+/);
    const verb = words[0];
    // last non-flag token, basename if it looks like a path
    const last = [...words].reverse().find((w) => !w.startsWith('-')) ?? '';
    const tail = last.includes('/') ? last.split('/').filter(Boolean).slice(-2).join('/') : last;
    const candidate = verb && tail && verb !== tail ? `${verb} … ${tail}` : trimmed.slice(0, 36) + '…';
    return candidate.length <= 50 ? candidate : trimmed.slice(0, 36) + '…';
  };
  switch (t.name) {
    case 'read_file':       return { verb: 'Read',        subject: basename(String(args.path ?? '')), group: 'read' };
    case 'write_file':      return { verb: 'Wrote',       subject: basename(String(args.path ?? '')), group: 'write' };
    case 'edit_file':       return { verb: 'Edited',      subject: basename(String(args.path ?? '')), group: 'write' };
    case 'list_dir':        return { verb: 'Listed',      subject: shortPath(String(args.path ?? '')), group: 'read' };
    case 'glob':            return { verb: 'Found',       subject: String(args.pattern ?? ''),         group: 'read' };
    case 'grep':            return { verb: 'Searched',    subject: String(args.pattern ?? '').slice(0, 40), group: 'read' };
    case 'bash':            return { verb: 'Ran',         subject: shortCmd(String(args.command ?? '')), group: 'run' };
    case 'read_timeline':   return { verb: 'Checked',     subject: 'timeline', group: 'read' };
    case 'create_scene':    return { verb: 'Added scene', subject: String(args.prompt ?? '').slice(0, 36), group: 'edit' };
    case 'patch_scene':     return { verb: 'Updated',     subject: `scene ${String(args.id ?? '')}`, group: 'edit' };
    case 'list_comments':   return { verb: 'Checked',     subject: 'comments', group: 'read' };
    case 'patch_comment':   return { verb: 'Updated',     subject: 'comment', group: 'edit' };
    case 'add_comment':     return { verb: 'Added',       subject: 'comment', group: 'edit' };
    case 'write_workspace': return { verb: 'Updated',     subject: 'workspace', group: 'workspace' };
    case 'set_view':        return { verb: 'Switched to', subject: `${String(args.view ?? '')} view`, group: 'ui' };
    case 'select_clip':     return { verb: 'Selected',    subject: 'clip', group: 'ui' };
    case 'set_playhead':    return { verb: 'Set playhead', subject: `${args.t}s`, group: 'ui' };
    case 'play_pause':      return { verb: args.play === false ? 'Paused' : 'Played', subject: '', group: 'ui' };
    case 'set_zoom':        return { verb: 'Zoomed',      subject: `${args.px}px/sec`, group: 'ui' };
    case 'set_tool':        return { verb: 'Tool',        subject: String(args.tool ?? ''), group: 'ui' };
    case 'open_modal':      return { verb: args.modal ? 'Opened' : 'Closed', subject: String(args.modal ?? 'modal'), group: 'ui' };
    case 'start_render':    return { verb: 'Queued',      subject: 'render', group: 'run' };
    case 'save_version':    return { verb: 'Saved',       subject: `version "${String(args.name ?? '')}"`, group: 'edit' };
    case 'generate_sfx':    return { verb: 'Generated',   subject: 'SFX', group: 'gen' };
    case 'generate_music':  return { verb: 'Generated',   subject: 'music', group: 'gen' };
    case 'delegate_to_claude': return { verb: 'Delegated', subject: String(args.brief ?? '').slice(0, 50) + (String(args.brief ?? '').length > 50 ? '…' : ''), group: 'gen' };
    case 'list_projects':   return { verb: 'Listed',      subject: 'projects', group: 'read' };
    case 'switch_project':  return { verb: 'Switched to', subject: `project ${String(args.name ?? '')}`, group: 'ui' };
    case 'create_project':  return { verb: 'Created',     subject: `project ${String(args.name ?? '')}`, group: 'edit' };
    case 'delete_clip':     return { verb: 'Deleted',     subject: 'clip', group: 'edit' };
    case 'set_track_gain':  return { verb: 'Set track gain', subject: `${args.trackId} → ${args.db}dB`, group: 'edit' };
    case 'set_clip_gain':   return { verb: 'Set clip gain',  subject: `${args.db}dB`, group: 'edit' };
    default:                return { verb: t.name, subject: '', group: 'other' };
  }
}

function clusterStatus(tools: ToolUsePart[]): 'running' | 'error' | 'ok' {
  if (tools.some((t) => t.status === 'running')) return 'running';
  if (tools.some((t) => t.status === 'error')) return 'error';
  return 'ok';
}

/** Cluster label — uppercase tag like THINKING's. Derived from the dominant
 *  action group; falls back to WORKING for mixed. */
function clusterLabel(tools: ToolUsePart[]): string {
  if (tools.length === 1) {
    return friendlyTool(tools[0]).group === 'ui' ? 'UI' : 'Action';
  }
  const counts = new Map<string, number>();
  for (const t of tools) {
    const g = friendlyTool(t).group;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let topG = '', topN = 0;
  for (const [g, n] of counts) if (n > topN) { topG = g; topN = n; }
  if (topN <= tools.length / 2) return 'Working';
  const labels: Record<string, string> = {
    read: 'Reading', write: 'Editing', edit: 'Editing', run: 'Running', gen: 'Generating', ui: 'UI', workspace: 'Workspace', other: 'Working',
  };
  return labels[topG] ?? 'Working';
}

/** Subject preview — show actual file names / commands so the row is
 *  legible without expanding. Up to 3 subjects, then "+N more". */
function clusterPreview(tools: ToolUsePart[]): string {
  const subjects = tools.map((t) => {
    const f = friendlyTool(t);
    // For a single-tool cluster the verb is included so it reads as a sentence;
    // for a multi-tool cluster the label already conveys the verb category.
    return tools.length === 1
      ? (f.subject ? `${f.verb} ${f.subject}` : f.verb)
      : (f.subject || f.verb);
  }).filter(Boolean);
  if (subjects.length === 0) return `${tools.length} actions`;
  if (subjects.length <= 3) return subjects.join(', ');
  return `${subjects.slice(0, 2).join(', ')} +${subjects.length - 2} more`;
}

function ToolCluster({ tools }: { tools: ToolUsePart[] }) {
  const status = clusterStatus(tools);
  const [open, setOpen] = useState(false);
  const label = clusterLabel(tools);
  const preview = clusterPreview(tools);
  const setView = useStore((s) => s.setView);
  // Single-tool clusters don't need to expand — the head already says everything
  const expandable = tools.length > 1;
  // If any tool in the cluster updated a visible tab, expose a "jump" link
  // so the user can switch to that surface right from chat.
  const jumpTarget = tools.find((t) => t.status === 'ok' && t.name === 'write_workspace');
  return (
    <div className={`chat-tg chat-tg-${status} ${open ? 'chat-tg-open' : ''}`}>
      <button className="chat-tg-head" onClick={() => expandable && setOpen(!open)} disabled={!expandable}>
        <span className="chat-tg-chev">{expandable ? (open ? '▾' : '▸') : '•'}</span>
        <span className="chat-tg-label">{label}{status === 'running' && <DotTrail />}</span>
        {!open && <span className="chat-tg-preview">{preview}</span>}
        {status === 'error' && <span className="chat-tg-err">!</span>}
        {jumpTarget && (
          <button
            className="chat-tg-jump"
            onClick={(e) => {
              e.stopPropagation();
              setView('workspace');
            }}
            title="Open Workspace"
          >
            Workspace →
          </button>
        )}
      </button>
      {expandable && open && (
        <div className="chat-tg-body">
          {tools.map((t, i) => {
            const f = friendlyTool(t);
            const dotClass = t.status === 'running' ? 'running' : t.status === 'error' ? 'error' : 'ok';
            return (
              <div key={i} className="chat-tg-row">
                <span className={`chat-tg-row-dot chat-tg-row-dot-${dotClass}`} />
                <span className="chat-tg-row-verb">{f.verb}</span>
                {f.subject && <span className="chat-tg-row-subject">{f.subject}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Inline thumbnail chip rendered above the chat textarea per attachment.
 * Tiny — 48px tall — so a chip strip with 3-4 attachments stays compact
 * and doesn't push the textarea off-screen. Images and videos show their
 * actual frame; audio gets a small waveform glyph; other files show their
 * extension. ✕ removes the attachment from the next send.
 */
function AttachmentChipView({ attachment, onRemove }: { attachment: ChatAttachment; onRemove: () => void }) {
  const { rel, kind, name, startSec, endSec } = attachment;
  // Timecode badge: only present when the chip came from a timeline
  // selection (fromSelection sets startSec/endSec). Manual "talk about it"
  // attachments don't have a position on the timeline — the badge would
  // be misleading there.
  const tc = (typeof startSec === 'number' && typeof endSec === 'number')
    ? `${formatTC(startSec)}–${formatTC(endSec)}`
    : null;
  return (
    <div className="chat-chip" title={`${name}\n${rel}${tc ? `\n${tc}` : ''}`}>
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
      {tc && <span className="chat-chip-tc">{tc}</span>}
      <button className="chat-chip-x" onClick={onRemove} aria-label="Remove attachment">×</button>
    </div>
  );
}

function formatTC(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Prepend a clearly-delimited `[Attached files]` header listing every
 *  chip's project-relative path. Selection-derived chips also carry a
 *  timecode badge inline so the agent knows "this clip currently
 *  sitting at 0:08–0:16" vs "this asset somewhere". The agent's
 *  read_file / analyze_media tools act on the listed paths. Shared by
 *  both the manual send() path and the launcher → hydrate handoff so
 *  both produce identical message shapes. */
function buildMessageWithAttachments(text: string, atts: ChatAttachment[]): string {
  if (atts.length === 0) return text;
  const header = atts.map((a) => {
    const tc = (typeof a.startSec === 'number' && typeof a.endSec === 'number')
      ? `  @ ${formatTC(a.startSec)}–${formatTC(a.endSec)} on timeline`
      : '';
    return `- ${a.rel}  (${a.kind})${tc}`;
  }).join('\n');
  const caption = text || '(no caption — please look at the attached file(s))';
  return `[Attached ${atts.length === 1 ? 'file' : 'files'}]\n${header}\n\n${caption}`;
}
