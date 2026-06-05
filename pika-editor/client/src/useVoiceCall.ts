/**
 * useVoiceCall — WebRTC + OpenAI realtime lifecycle, lifted out of any
 * particular UI shell. The hook itself renders nothing; the caller
 * owns the chrome (a strip in ChatPanel, currently). Transcripts are
 * surfaced through callbacks so the parent can render voice turns as
 * real chat messages — no separate transcript pane.
 *
 * Lifecycle phases:
 *   idle        — no call has been started this mount
 *   needs-key   — OPENAI_API_KEY isn't set on the server yet
 *   requesting  — mic permission prompt is open
 *   connecting  — SDP handshake with OpenAI in flight
 *   live        — audio + data channel both up
 *   ended       — user hung up
 *   error       — fatal failure (key bad, mic denied, network down)
 *
 * Project awareness: at session open, /voice/context is fetched and
 * the last ~12 Claude turns + the live editor state are pushed into
 * the realtime session as conversation seed + system instructions.
 * Tool calls from the realtime model proxy through /voice/tool, which
 * reuses the EXACT same executeTool the text agent uses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import { useStore } from './store';

export type VoicePhase = 'idle' | 'needs-key' | 'requesting' | 'connecting' | 'live' | 'ended' | 'error';

export interface UseVoiceCallOptions {
  /** Called once per finalized user utterance (after OpenAI's input
   *  transcription completes). Parent appends this as a chat message. */
  onUserTurn: (text: string) => void;
  /** Stream of assistant transcript deltas. Parent should accumulate
   *  these into a single in-flight assistant message; `onAssistantEnd`
   *  marks the message complete. */
  onAssistantDelta: (delta: string) => void;
  /** Fired when the assistant finishes a response turn — parent can
   *  finalize the in-flight message and prepare for the next one. */
  onAssistantEnd: () => void;
  /** Realtime model called a tool. callId is the OpenAI-issued id we
   *  later match in onToolEnd. Parent should render a `tool_use` part
   *  in the in-flight assistant message (same UI as text-chat tool
   *  calls — full visibility). */
  onToolStart: (callId: string, name: string, input: unknown) => void;
  /** Tool execution finished — parent updates the tool_use part by
   *  callId with the result preview + ok/error status. */
  onToolEnd: (callId: string, ok: boolean, preview: string) => void;
}

export interface UseVoiceCallApi {
  phase: VoicePhase;
  error: string | null;
  muted: boolean;
  /** Seconds since the call went `live`. Resets on hang-up. 0 when
   *  not live yet. The voice API is billed per minute, so the bar
   *  surfaces this so the user can see the meter running. */
  elapsedSec: number;
  /** Click handler for the call button. Picks the right next step
   *  based on the current phase: starts the connection, prompts for
   *  the key, or no-ops if already live. */
  start: () => void;
  /** Submit the entered OpenAI key and continue connecting. */
  saveKeyAndConnect: (key: string) => Promise<void>;
  /** Hang up the call (or close out an error). Always safe to call. */
  hangUp: () => void;
  /** Toggle mic mute. No-op outside `live`. */
  toggleMute: () => void;
  /** True between `start()` and any terminal phase (ended | error |
   *  idle). Useful for "show the call strip" rendering checks. */
  active: boolean;
}

export function useVoiceCall({ onUserTurn, onAssistantDelta, onAssistantEnd, onToolStart, onToolEnd }: UseVoiceCallOptions): UseVoiceCallApi {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const liveStartRef = useRef<number | null>(null);

  // Elapsed-time meter — starts when phase flips to `live`, ticks every
  // second, resets on hang-up. Voice billing is per-minute so we surface
  // this in the call bar so the user can see the meter running.
  useEffect(() => {
    if (phase !== 'live') {
      liveStartRef.current = null;
      setElapsedSec(0);
      return;
    }
    if (liveStartRef.current === null) liveStartRef.current = Date.now();
    const tick = (): void => {
      const start = liveStartRef.current;
      if (start !== null) setElapsedSec(Math.floor((Date.now() - start) / 1000));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const cancelRef = useRef(false);

  // Mount one shared <audio> element on first call. Hidden, autoplay'd
  // remote-track audio routes here. We keep a singleton so re-running
  // start() (after an error) doesn't leak audio elements.
  useEffect(() => {
    if (audioElRef.current) return;
    const el = document.createElement('audio');
    el.autoplay = true;
    el.style.display = 'none';
    document.body.appendChild(el);
    audioElRef.current = el;
    return () => {
      try { document.body.removeChild(el); } catch {/* unmounted already */}
      audioElRef.current = null;
    };
  }, []);

  // ---- Live state snapshot pushed through the data channel ----
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const view = useStore((s) => s.view);
  const selectedClipIds = useStore((s) => s.selectedClipIds);
  const timeline = useStore((s) => s.timeline);

  const stateBlock = useCallback((): string => {
    const lines: string[] = [];
    const t = timeline;
    if (t) {
      lines.push(`Playhead: ${fmtTime(playhead)} / ${fmtTime(t.duration ?? 0)}`);
      lines.push(`Playing: ${playing ? 'yes' : 'no'}`);
      lines.push(`View: ${view}`);
      let activeLabel: string | null = null;
      for (const tr of t.tracks ?? []) {
        for (const c of tr.clips ?? []) {
          const end = c.start + (c.out - c.in);
          if (playhead >= c.start - 0.001 && playhead < end + 0.001) {
            activeLabel = (c as any).label ?? (c as any).sceneId ?? c.id;
            break;
          }
        }
        if (activeLabel) break;
      }
      if (activeLabel) lines.push(`Active clip under playhead: ${activeLabel}`);
      if (selectedClipIds.length) lines.push(`Selected clips: ${selectedClipIds.join(', ')}`);
    } else {
      lines.push('No timeline loaded yet.');
    }
    return lines.join('\n');
  }, [playhead, playing, view, selectedClipIds, timeline]);

  const stateBlockRef = useRef<string>('');
  useEffect(() => {
    if (phase !== 'live') return;
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;
    const next = stateBlock();
    if (next === stateBlockRef.current) return;
    stateBlockRef.current = next;
    const timer = window.setTimeout(() => {
      try {
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: BASE_LIVE_INSTRUCTIONS + '\n\nLIVE STATE (auto-updated):\n' + next,
          },
        }));
      } catch {/* socket may close mid-throttle */}
    }, 120);
    return () => window.clearTimeout(timer);
  }, [phase, stateBlock]);

  // ---- Realtime event handling ----
  const stateBlockRef2 = useRef<() => string>(() => '');
  stateBlockRef2.current = stateBlock;

  const handleRealtimeEvent = useCallback((ev: any): void => {
    // Diagnostic: log every realtime event type so we can find the
    // right event name on GA (it may have renamed audio_transcript →
    // output_audio_transcript between beta and GA).
    console.log('[voice ev]', ev.type, ev.delta ? `delta="${String(ev.delta).slice(0, 40)}"` : '');
    if ((ev.type === 'response.audio_transcript.delta'
         || ev.type === 'response.output_audio_transcript.delta'
         || ev.type === 'response.output_audio.transcript.delta'
         || ev.type === 'response.output_text.delta')
        && typeof ev.delta === 'string') {
      onAssistantDelta(ev.delta);
    } else if (ev.type === 'response.audio_transcript.done'
            || ev.type === 'response.output_audio_transcript.done'
            || ev.type === 'response.output_audio.transcript.done'
            || ev.type === 'response.done') {
      onAssistantEnd();
    } else if (ev.type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(ev.transcript ?? '').trim();
      if (text) onUserTurn(text);
      // Inject the freshest STATE block as a system note RIGHT BEFORE
      // the model generates its reply. The in-instructions block
      // (pushed via session.update) isn't always re-read; a per-turn
      // system conversation item is — and the model treats it as
      // authoritative context for the current playhead/clip. This is
      // what makes "what's the playhead at?" actually accurate.
      const dc = dcRef.current;
      if (dc && dc.readyState === 'open') {
        try {
          dc.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{ type: 'input_text', text: 'LIVE STATE:\n' + stateBlockRef2.current() }],
            },
          }));
        } catch {/* socket may have closed */}
      }
    } else if (ev.type === 'response.function_call_arguments.done') {
      const name: string = ev.name;
      const callId: string = ev.call_id;
      let input: unknown = {};
      try { input = JSON.parse(ev.arguments ?? '{}'); } catch {/* empty args */}
      onToolStart(callId, name, input);
      // ALWAYS cancel the current audio response the moment we know a
      // tool call is firing. The realtime model streams audio AND
      // function calls concurrently, so without a cancel here it
      // leaks filler ("It looks like that request needs a longer
      // streaming setup…") DURING delegate calls before the actual
      // result is back. After the tool returns, runTool() decides
      // whether to fire response.create for a fresh reply (delegate,
      // read_*) or stay silent (play/pause/select/etc.).
      const dc = dcRef.current;
      if (dc && dc.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'response.cancel' })); } catch {/* race ok */}
      }
      void runTool(name, input, callId);
    } else if (ev.type === 'error') {
      console.warn('voice session error', ev);
    }
  }, [onAssistantDelta, onAssistantEnd, onUserTurn, onToolStart]);

  async function runTool(name: string, input: unknown, callId: string): Promise<void> {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;
    try {
      const r = await api.callVoiceTool(name, input);
      const output = r.ok ? JSON.stringify(r.result ?? { ok: true }) : JSON.stringify({ error: r.error ?? 'tool failed' });
      const preview = r.ok
        ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? {}).slice(0, 120))
        : (r.error ?? 'tool failed');
      onToolEnd(callId, r.ok, preview);
      dc.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
      }));
      // Silent-tool short circuit: DON'T trigger a follow-up response.
      // The user gave a direct command (play / pause / open projects),
      // we executed it, the editor already reflects the result — there
      // is nothing for the agent to say. response.create here would
      // make the model narrate ("okay, paused"), exactly what the user
      // does not want. For non-silent tools (read_*, list_comments)
      // the model genuinely needs to speak the answer, so we DO
      // request a response.
      if (!SILENT_TOOLS.has(name)) {
        dc.send(JSON.stringify({ type: 'response.create' }));
      }
    } catch (e: any) {
      console.warn('runTool failed', name, e);
      onToolEnd(callId, false, e?.message ?? 'tool failed');
    }
  }


  async function seedSession(dc: RTCDataChannel): Promise<void> {
    try {
      const ctx = await api.getVoiceContext();
      if (!ctx.ok) return;
      for (const turn of ctx.history) {
        dc.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: turn.role === 'assistant' ? 'assistant' : 'user',
            content: [{ type: 'input_text', text: turn.text }],
          },
        }));
      }
      dc.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions: BASE_LIVE_INSTRUCTIONS + '\n\nLIVE STATE (auto-updated):\n' + stateBlock(),
        },
      }));
    } catch (e) {
      console.warn('seedSession failed', e);
    }
  }

  // ---- Connection flow ----
  async function connect(): Promise<void> {
    cancelRef.current = false;
    setPhase('requesting');
    setError(null);
    try {
      const session = await api.startVoiceSession();
      if (!session.ok || !session.clientSecret) {
        if ((session.error ?? '').includes('OPENAI_API_KEY')) {
          setPhase('needs-key');
          return;
        }
        setError(session.error ?? 'failed to start session');
        setPhase('error');
        return;
      }
      if (cancelRef.current) return;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (cancelRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      micStreamRef.current = stream;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.ontrack = (e) => {
        const el = audioElRef.current;
        if (el && e.streams[0]) {
          el.srcObject = e.streams[0];
          void el.play().catch(() => {/* autoplay may need a tap */});
        }
      };
      stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));

      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;
      dc.addEventListener('open', () => { void seedSession(dc); });
      dc.addEventListener('message', (e) => {
        try { handleRealtimeEvent(JSON.parse(e.data)); }
        catch (err) { console.warn('voice event parse failed', err); }
      });

      setPhase('connecting');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // GA Realtime WebRTC SDP handshake: POST /v1/realtime/calls.
      // Despite OpenAI's error message saying "use /v1/realtime", the
      // actual GA WebRTC endpoint is /v1/realtime/calls — plain
      // /v1/realtime returns `beta_api_shape_disabled` even when the
      // ephemeral key + content-type look correct. The model is baked
      // into the ephemeral key during /client_secrets, no query param.
      const HANDSHAKE_URL = 'https://api.openai.com/v1/realtime/calls';
      console.log('[voice] BUILD=2026-05-17-ga3  handshake URL =', HANDSHAKE_URL);
      const sdpRes = await fetch(HANDSHAKE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp ?? '',
      });
      if (!sdpRes.ok) {
        const detail = await sdpRes.text().catch(() => '');
        setError(`OpenAI handshake ${sdpRes.status}: ${detail.slice(0, 200)}`);
        setPhase('error');
        return;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });
      if (cancelRef.current) return;
      setPhase('live');
    } catch (e: any) {
      console.error('voice connect failed', e);
      setError(e?.message ?? 'connection failed');
      setPhase('error');
    }
  }

  function toggleMute(): void {
    const stream = micStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => { t.enabled = !next; });
    setMuted(next);
  }

  async function teardown(): Promise<void> {
    const dc = dcRef.current;
    const pc = pcRef.current;
    const stream = micStreamRef.current;
    dcRef.current = null;
    pcRef.current = null;
    micStreamRef.current = null;
    try { dc?.close(); } catch {/* ignore */}
    try { pc?.close(); } catch {/* ignore */}
    stream?.getTracks().forEach((t) => { try { t.stop(); } catch {/* ignore */} });
  }

  function hangUp(): void {
    cancelRef.current = true;
    void teardown();
    setMuted(false);
    setPhase('ended');
    // After a brief moment, return to idle so the next click on the
    // call button starts fresh. We don't await teardown — it's safe
    // to fire-and-forget; pc.close() is synchronous-ish.
    window.setTimeout(() => setPhase('idle'), 250);
  }

  function start(): void {
    // Branching by phase keeps the start handler one-button-fits-all:
    //  - idle/ended/error → kick off connect()
    //  - needs-key        → no-op (caller renders the inline form)
    //  - live/connecting  → no-op
    if (phase === 'idle' || phase === 'ended' || phase === 'error') {
      void preflightThenConnect();
    }
  }

  async function preflightThenConnect(): Promise<void> {
    // Check the OpenAI key state before touching mic/network so we can
    // surface `needs-key` instantly instead of going through a useless
    // /voice/session round trip.
    setError(null);
    try {
      const cfg = await api.getAgentConfig();
      if (!cfg.hasOpenAIKey) { setPhase('needs-key'); return; }
    } catch {/* if config fetch fails, let connect() surface it */}
    await connect();
  }

  async function saveKeyAndConnect(key: string): Promise<void> {
    const v = key.trim();
    if (!v) return;
    setError(null);
    try {
      const r = await api.setAgentConfig({ openaiApiKey: v });
      if (!r.ok) { setError(r.error ?? 'failed to save key'); return; }
      await connect();
    } catch (e: any) {
      setError(e?.message ?? 'failed to save key');
    }
  }

  // Cleanup on unmount: tear down the connection so the mic LED dies
  // with the component. This catches the "close the tab mid-call" case.
  useEffect(() => () => { cancelRef.current = true; void teardown(); }, []);

  const active = phase !== 'idle' && phase !== 'ended';

  return { phase, error, muted, elapsedSec, start, saveKeyAndConnect, hangUp, toggleMute, active };
}

/** Tools the agent should execute SILENTLY — no audio output, no
 *  follow-up "okay done". The editor surface already shows the result
 *  so verbal acknowledgment is friction, not help. Read-style tools
 *  (read_timeline, read_file, list_comments) are NOT in this set:
 *  when the user asks "what comments are open?" they expect the agent
 *  to speak the answer. */
const SILENT_TOOLS = new Set([
  'set_view', 'set_playhead', 'play_pause', 'select_clip',
  'set_zoom', 'set_tool', 'open_modal', 'switch_project', 'create_project',
  'set_track_gain', 'set_clip_gain', 'delete_clip',
]);

const BASE_LIVE_INSTRUCTIONS = [
  'Live voice call in PikaAgentEditor. You are a voice front-end.',
  'DELEGATE to Claude ONLY when the user gives an explicit action verb — generate / make / apply / fix / render / check / show / plan. Brainstorm, opinions, "what do you think" → answer in voice yourself, do NOT delegate every utterance. When you do delegate, read Claude\'s returned summary verbatim, don\'t pad.',
  'Direct UI / read commands (play / pause / skip / select / zoom / switch project / read_timeline / list_comments) — call the tool yourself, STAY SILENT. The editor shows what happened.',
  'AUTONOMY: only mutate state when explicitly asked. Never proactively save / render / generate / comment.',
  'LIVE STATE block below = authoritative playhead + active clip.',
].join(' ');

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
