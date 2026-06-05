import { create } from 'zustand';
import type { Timeline, Clip, MusicClip, SfxClip, Aspect, Resolution } from './types';
import * as api from './api';
import * as edit from './edit';
import { audio } from './audio';

/** A file attached to the next chat message. Carries enough metadata for
 *  the chip UI (kind → which thumbnail / icon) and the send pipeline
 *  (rel → project-relative path the agent can read_file / analyze_media). */
export interface ChatAttachment {
  id: string;
  rel: string;
  kind: 'image' | 'video' | 'audio' | 'other';
  name: string;
  /** When true, this attachment was added automatically because the
   *  underlying clip is selected on the timeline — clearing the
   *  selection (or selecting different clips) replaces it. Manual
   *  attachments from "Talk about it" omit this flag and are
   *  user-owned: only the user can remove them. */
  fromSelection?: boolean;
  /** Master-timeline start (sec). Only set for selection-derived chips
   *  — manual "talk about it" attachments don't have a position. The UI
   *  renders this as a small `0:08–0:16` badge on the chip so the agent
   *  knows which slice of the timeline the user is referring to (vs.
   *  just "this asset somewhere"). */
  startSec?: number;
  endSec?: number;
}

interface State {
  timeline: Timeline | null;
  etag: string;
  loading: boolean;
  error: string | null;

  // Transport
  playhead: number;
  playing: boolean;

  // Selection + tools
  selectedClipIds: string[];
  // Mutually-exclusive with selectedClipIds — when a caption row is being
  // edited, the side panel surfaces its style controls instead of the
  // generic clip inspector.
  selectedCaptionId: string | null;
  selectCaption: (id: string | null) => void;
  // Track-level panel toggle — independent of row selection. Opened by
  // clicking the CC lane label even when no row is selected, so the user
  // can run "auto-caption all" or change the project's default style.
  captionsPanelOpen: boolean;
  setCaptionsPanelOpen: (open: boolean) => void;
  tool: 'select' | 'blade' | 'slip' | 'ripple' | 'stretch' | 'comment';
  snapEnabled: boolean;
  pxPerSec: number;

  // Right-panel tab
  inspectorTab: 'clip' | 'project' | 'render';
  // Library tab
  libraryTab: 'models' | 'assets' | 'music';
  // Top-level view — four tabs:
  //   timeline  — the edit surface
  //   workspace — agent's real-time working canvas (ephemeral)
  // (The standalone history/plan views were folded into the left-rail
  // Library panel — there's no separate route for them anymore.)
  view: 'timeline' | 'workspace';
  // Modal state — lifted from Topbar so the agent can drive it via SSE.
  openModal: 'projects' | null;
  // Chat draft — lifted from ChatPanel local state so Workspace tiles can
  // append reference tokens (e.g. "[beat5_v2]") via the store. Keeps the
  // "talk about this" affordance one store call away from anywhere.
  chatDraft: string;

  /** Figma-style insertion indicator shown while the user drags a clip
   *  over a sibling — a vertical line at the exact cut where the
   *  dragged clip will land if released. Null when no drag is active.
   *  Coordinates are in fractional-time space (0..1 of the lane's
   *  duration) so the renderer can position it without knowing pixel
   *  geometry. Cleared by Clip onPointerUp. */
  dropIndicator: { trackId: string; timeSec: number } | null;

  // Per-asset cache-bust counter. Incremented every time the watcher emits
  // an asset-added event for a given relPath, so the next render of an
  // <img src="/asset/foo"> uses /asset/foo?v=N and forces the browser to
  // re-fetch instead of serving the stale cached version. Consumed by
  // assetUrl() below.
  assetVersions: Record<string, number>;
  bumpAssetVersion: (relPath: string) => void;

  // Undo/redo
  past: Timeline[];
  future: Timeline[];
  /**
   * Drag-coalescing: when a user drags a clip edge / body / playhead, the
   * pointermove handler fires dozens of times per second, each one calling
   * a mutating action (trimLeft, moveSelectedBy, etc.). Without coalescing,
   * each one pushes its own entry onto `past` and a single drag becomes
   * dozens of undo steps — pressing Ctrl-Z once just rewinds 1ms of drag,
   * which is what the user was hitting.
   *
   * Solution: drag start calls `beginTransaction()`, which captures the
   * pre-drag timeline in `transactionBase`. While `transactionBase != null`,
   * `withHistory` does NOT push to `past` — it just updates `timeline`.
   * Drag end calls `endTransaction()`, which pushes `transactionBase` (the
   * single pre-drag snapshot) onto `past` as one undo step.
   *
   * If a drag is cancelled mid-flight (e.g. browser blur), the next user
   * action implicitly commits the transaction. We also commit on save.
   */
  transactionBase: Timeline | null;
  beginTransaction: () => void;
  endTransaction: () => void;

  // Lifecycle
  load: () => Promise<void>;
  save: () => Promise<void>;
  applyServerTimeline: (t: Timeline) => void;

  // Transport
  setPlayhead: (t: number) => void;
  togglePlay: () => void;
  setTool: (t: State['tool']) => void;
  toggleSnap: () => void;
  setZoom: (px: number) => void;
  setInspectorTab: (t: State['inspectorTab']) => void;
  setLibraryTab: (t: State['libraryTab']) => void;
  setView: (v: State['view']) => void;
  setOpenModal: (m: State['openModal']) => void;
  setPlaying: (p: boolean) => void;
  setChatDraft: (s: string) => void;
  setDropIndicator: (ind: { trackId: string; timeSec: number } | null) => void;
  /** Full-height "insert here" indicator shown while dragging a library
   *  ref over the timeline. Distinct from `dropIndicator` (per-track,
   *  used for moving an existing clip) — this one spans every lane and
   *  signals the ripple-push that will happen on drop. */
  rippleDropIndicator: { timeSec: number } | null;
  setRippleDropIndicator: (ind: { timeSec: number } | null) => void;
  /** Shift everything on / after `timeSec` forward by `dur` seconds —
   *  V clips, audio clips, captions, floating comments. Used by the
   *  library-drop flow to "make room" for a freshly-imported clip at
   *  the snapped insert point so the rest of the cut stays intact. */
  rippleInsertAt: (timeSec: number, dur: number) => void;
  appendChatToken: (token: string) => void;
  focusChatInput: () => void;

  /** Files attached to the next chat message — rendered as thumbnail chips
   *  above the textarea. The send pipeline prepends an "Attached:" header
   *  with each file's project-relative path so the agent's read_file /
   *  analyze_media tools can act on it. Cleared on send. */
  chatAttachments: ChatAttachment[];
  attachToChat: (a: ChatAttachment) => void;
  /** Add if `rel` is not yet attached, remove if it is. Returns the
   *  resulting "is attached" boolean so the caller can drive UI state. */
  toggleChatAttachment: (a: ChatAttachment) => boolean;
  removeChatAttachment: (id: string) => void;
  clearChatAttachments: () => void;
  /** Replace the SELECTION-DERIVED set of attachments — manual
   *  attachments (from "Talk about it") are kept untouched. Called
   *  whenever the timeline selection changes so the chat input shows
   *  what the user currently has selected as if they'd clicked "Talk
   *  about it" on each. */
  syncSelectionAttachments: (atts: ChatAttachment[]) => void;

  // Live Pika MCP gens, keyed by gen.id. Populated by App.tsx's global
  // SSE subscription (pika-live-gen events) + periodic hydrate. Consumed
  // by Workspace tile placeholders AND timeline V1 clips so both render
  // the same progress %.
  pikaLiveGens: Map<string, api.LiveGen>;
  upsertPikaLiveGen: (gen: api.LiveGen) => void;
  setPikaLiveGens: (gens: api.LiveGen[]) => void;

  /** Canonical GenJob projection map (Phase 1). Indexed by GenJob id.
   *  Production surfaces (timeline V1 clip, workspace tile placeholder,
   *  topbar health pill) prefer this over the legacy LiveGen feed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  genJobs: Map<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertGenJob: (job: any) => void;

  /** Reconciler health snapshot (Phase 3) — last tick summary the
   *  server broadcast. Rendered as a small topbar indicator. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reconcilerHealth: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setReconcilerHealth: (summary: any) => void;

  /** True once the user has interacted with the chat in this session (or
   *  if there was already chat history on mount). Used by the launcher
   *  landing screen — when timeline is empty AND chatStarted is false,
   *  we show the preset launcher instead of the editor. */
  chatStarted: boolean;
  setChatStarted: (v: boolean) => void;
  /** Message the launcher composer captured but couldn't send itself
   *  (ChatPanel owns the send pipeline). Set when the user submits
   *  from the launcher; ChatPanel reads it on mount and auto-fires
   *  the runTurn, then clears. Survives the launcher→editor remount. */
  pendingFirstMessage: string | null;
  setPendingFirstMessage: (text: string | null) => void;

  // Project metadata
  setAspect: (a: Aspect) => void;
  setResolution: (r: Resolution) => void;
  setProjectName: (name: string) => void;
  setFps: (fps: 24 | 30 | 60) => void;
  setRenderPreset: (preset: 'draft' | 'standard' | 'high') => void;
  // Per-track gain (replaces setLaneGainDb). trackId is `a1`, `a2`, …
  setAudioTrackGain: (trackId: string, db: number) => void;
  setAudioTrackLabel: (trackId: string, label: string | null) => void;
  addAudioTrack: () => string;
  setAudioClipGainDb: (clipId: string, db: number) => void;

  // Unified audio-clip edits — every audio item lives on an AudioTrack now,
  // so these single action names cover what music/SFX/VO used to need
  // separate actions for. Legacy aliases (move{Music,Sfx}Clip etc.) all
  // route through these.
  moveAudioClip: (id: string, newStart: number) => void;
  trimAudioClipLeft: (id: string, deltaSec: number) => void;
  trimAudioClipRight: (id: string, deltaSec: number) => void;
  splitAudioClipAt: (id: string, atTime: number) => void;
  deleteAudioClip: (id: string) => void;
  moveAudioClipToTrack: (id: string, trackId: string) => void;

  // Legacy aliases — wrappers over the unified actions above so the
  // existing component call sites keep working through the refactor.
  moveMusicClip: (id: string, newStart: number) => void;
  trimMusicClipLeft: (id: string, deltaSec: number) => void;
  trimMusicClipRight: (id: string, deltaSec: number) => void;
  deleteMusicClip: (id: string) => void;
  moveSfxClip: (id: string, newStart: number) => void;
  trimSfxClipLeft: (id: string, deltaSec: number) => void;
  trimSfxClipRight: (id: string, deltaSec: number) => void;
  deleteSfxClip: (id: string) => void;
  splitSfxClipAt: (id: string, atTime: number) => void;
  setSfxClipLane: (id: string, lane: 'VO' | 'SFX1' | 'SFX2') => void;
  splitMusicClipAt: (id: string, atTime: number) => void;

  // Clipboard for copy/paste
  clipboard: Clip[];
  copyClips: () => void;
  pasteClips: () => void;

  // Group move — drag any selected clip; all others shift by the same delta.
  moveSelectedBy: (deltaSec: number, anchorClipId: string) => void;

  // Add an imported video as a new scene + clip on V1.
  addVideoImport: (params: { rel: string; filename: string; duration: number; startSec: number; sfxRel?: string | null; linkId?: string | null }) => void;
  /** Drop a PNG / WebP / JPG onto the timeline as an alpha overlay.
   *  Lands on V2 (creates V2 if missing) so it composites over V1. */
  addImageOverlay: (params: { rel: string; filename: string; duration: number; startSec: number }) => void;
  addAudioImport: (params: { rel: string; name: string; duration: number; startSec: number }) => void;

  // Selection
  selectClip: (id: string, additive?: boolean) => void;
  clearSelection: () => void;

  // Edit ops (push undo entry, mutate, debounce save)
  moveClip: (clipId: string, newStart: number) => void;
  moveClipToTrack: (clipId: string, trackId: string) => void;
  toggleVideoTrackMute: (trackId: string) => void;
  reorderClipNearClip: (draggedId: string, targetId: string, insertBefore: boolean) => void;
  trimLeft: (clipId: string, deltaSec: number) => void;
  trimRight: (clipId: string, deltaSec: number) => void;
  stretchRight: (clipId: string, deltaSec: number) => void;
  rippleTrimLeft: (clipId: string, deltaSec: number) => void;
  rippleTrimRight: (clipId: string, deltaSec: number) => void;
  rippleMove: (group: import('./edit').RippleMoveGroup, deltaSec: number) => void;
  slipClip: (clipId: string, deltaSec: number) => void;
  setRate: (clipId: string, rate: number) => void;
  splitClipAt: (clipId: string, atTime: number) => void;
  rippleDelete: (clipId: string) => void;
  deleteClip: (clipId: string) => void;
  breakLink: (linkId: string) => void;
  /** Relink an A-clip whose `id` follows the `sfx_<sceneId>` convention
   *  back to the V clip that owns that sceneId. Assigns a fresh shared
   *  linkId on both. No-op if no matching V clip exists. */
  relinkAudioClip: (audioClipId: string) => void;
  patchClip: (clipId: string, patch: Partial<Clip>) => void;

  // Captions
  addCaptionRow: (start: number, end: number, text?: string) => string;
  patchCaptionRow: (id: string, patch: Partial<import('./types').CaptionRow>) => void;
  deleteCaptionRow: (id: string) => void;
  moveCaptionRow: (id: string, newStart: number) => void;
  trimCaptionRowLeft: (id: string, deltaSec: number) => void;
  trimCaptionRowRight: (id: string, deltaSec: number) => void;
  splitCaptionRowAt: (id: string, atTime: number) => void;
  setCaptionsEnabled: (enabled: boolean) => void;
  setCaptionsDefaultStyle: (patch: Partial<import('./types').CaptionStyle>) => void;

  undo: () => void;
  redo: () => void;
}

const UNDO_MAX = 100;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Helpers for the unified audio model — find / patch / remove an audio
 * clip by id, no matter which track it sits on. The store's audio actions
 * are thin wrappers around these so legacy aliases (moveMusicClip / etc.)
 * and the new ones (moveAudioClip) share one canonical implementation.
 */
function findAudioClip(tl: Timeline | null, clipId: string): { track: import('./types').AudioTrack; clip: import('./types').AudioClip } | null {
  if (!tl) return null;
  for (const t of tl.audioTracks ?? []) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return null;
}

function patchAudioClip(tl: Timeline, clipId: string, patch: Partial<import('./types').AudioClip>): Timeline {
  return {
    ...tl,
    audioTracks: tl.audioTracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => c.id === clipId ? { ...c, ...patch } : c),
    })),
  };
}

function dropAudioClip(tl: Timeline, clipId: string): Timeline {
  return {
    ...tl,
    audioTracks: tl.audioTracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => c.id !== clipId),
    })),
  };
}

function withHistory(s: State, next: Timeline | null): Partial<State> {
  if (!s.timeline || !next) return { timeline: next ?? undefined };
  // Inside a drag (transactionBase set), bypass the past stack entirely —
  // intermediate states between begin/end are not separate undo steps.
  // endTransaction commits ONE entry (the original pre-drag state) for
  // the whole drag.
  if (s.transactionBase !== null) {
    return { timeline: next };
  }
  const past = [...s.past, s.timeline].slice(-UNDO_MAX);
  return { timeline: next, past, future: [] };
}

export const useStore = create<State>((set, get) => ({
  timeline: null,
  etag: '',
  loading: false,
  error: null,
  playhead: 0,
  playing: false,
  selectedClipIds: [],
  selectedCaptionId: null,
  selectCaption: (id) => set((s) => ({
    selectedCaptionId: id,
    selectedClipIds: id ? [] : s.selectedClipIds,
    // Selecting a row implicitly opens the panel. Deselecting doesn't close
    // it — the track-level controls may still be useful.
    captionsPanelOpen: id ? true : s.captionsPanelOpen,
  })),
  captionsPanelOpen: false,
  setCaptionsPanelOpen: (open) => set({ captionsPanelOpen: open }),
  tool: 'select',
  snapEnabled: false,
  pxPerSec: 80,
  inspectorTab: 'clip',
  libraryTab: 'models',
  view: 'timeline',
  openModal: null,
  chatDraft: '',
  dropIndicator: null,
  rippleDropIndicator: null,
  assetVersions: {},
  bumpAssetVersion: (relPath) => set((s) => {
    const key = relPath.replace(/^assets\//, '');
    return { assetVersions: { ...s.assetVersions, [key]: (s.assetVersions[key] ?? 0) + 1 } };
  }),
  past: [],
  future: [],
  transactionBase: null,
  beginTransaction: () => set((s) => {
    // Idempotent: if already in a transaction (e.g. user starts a new drag
    // before pointerup fires from a previous one), keep the OLDER base so
    // the whole interaction collapses to one undo step.
    if (s.transactionBase !== null) return {};
    return { transactionBase: s.timeline };
  }),
  endTransaction: () => set((s) => {
    if (s.transactionBase === null) return {};
    // No-op if nothing actually changed during the drag.
    if (s.timeline === null || s.transactionBase === s.timeline) {
      return { transactionBase: null };
    }
    return {
      past: [...s.past, s.transactionBase].slice(-UNDO_MAX),
      future: [],
      transactionBase: null,
    };
  }),
  clipboard: [],

  load: async () => {
    set({ loading: true, error: null });
    try {
      const { timeline, etag } = await api.getTimeline();
      set({ timeline, etag, loading: false, past: [], future: [] });
    } catch (e: any) { set({ error: e.message, loading: false }); }
  },

  applyServerTimeline: (t) => {
    set({ timeline: t });
    // Pre-warm audio buffers so the first play() after a refresh / project
    // switch doesn't lag behind the video while music + SFX decode. Fire
    // and forget — warmup() is safe to call repeatedly.
    audio.warmup(t as any);
  },

  save: async () => {
    const { timeline, etag } = get();
    if (!timeline) return;
    try {
      const r = await api.putTimeline(timeline, etag);
      if (r.conflict) {
        set({ timeline: r.conflict.current, etag: r.conflict.currentSha, error: 'remote changed; reloaded' });
      } else {
        set({ etag: r.etag, error: null });
      }
    } catch (e: any) { set({ error: e.message }); }
  },

  setPlayhead: (t) => set((s) => ({ playhead: Math.max(0, Math.min(s.timeline ? edit.effectiveDuration(s.timeline) : t, t)) })),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setTool: (tool) => set({ tool }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  // Floor at 4px/sec — low enough that a 5-minute project fits in a
  // ~1200px viewport (5min * 4 = 1200), keeping the "0 / fit to width"
  // hotkey honest. Below ~3px/sec clips become invisible slivers.
  setZoom: (px) => set({ pxPerSec: Math.max(4, Math.min(400, px)) }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setLibraryTab: (libraryTab) => set({ libraryTab }),
  setView: (view) => set({ view }),
  setOpenModal: (openModal) => set({ openModal }),
  setPlaying: (playing) => set({ playing }),
  setChatDraft: (chatDraft) => set({ chatDraft }),
  setDropIndicator: (dropIndicator) => set({ dropIndicator }),
  setRippleDropIndicator: (rippleDropIndicator) => set({ rippleDropIndicator }),
  rippleInsertAt: (timeSec, dur) => set((s) => {
    if (!s.timeline || dur <= 0) return s;
    const t = Math.max(0, timeSec);
    const r3 = (n: number): number => Math.round(n * 1000) / 1000;
    const shiftIfAfter = <C extends { start: number }>(c: C): C => (
      c.start >= t - 1e-6 ? { ...c, start: r3(c.start + dur) } : c
    );
    const next: Timeline = {
      ...s.timeline,
      tracks: s.timeline.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map(shiftIfAfter),
      })),
      audioTracks: s.timeline.audioTracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map(shiftIfAfter),
      })),
      captions: {
        ...s.timeline.captions,
        rows: s.timeline.captions.rows.map((r) => (
          r.start >= t - 1e-6
            ? { ...r, start: r3(r.start + dur), end: r3(r.end + dur) }
            : r
        )),
      },
      floatingComments: (s.timeline.floatingComments ?? []).map((fc) => (
        fc.at >= t - 1e-6 ? { ...fc, at: r3(fc.at + dur) } : fc
      )),
    };
    return withHistory(s, next);
  }),
  appendChatToken: (token) => set((s) => ({
    chatDraft: s.chatDraft ? `${s.chatDraft.replace(/\s+$/, '')} ${token} ` : `${token} `,
  })),
  focusChatInput: () => {
    // Custom event the ChatPanel listens for to focus its textarea and place
    // the caret at the end. Cheaper than threading a ref through the store.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('chat:focus'));
  },
  chatAttachments: [],
  toggleChatAttachment: (a) => {
    const s = get();
    const existing = s.chatAttachments.find((x) => x.rel === a.rel);
    if (existing) {
      set({ chatAttachments: s.chatAttachments.filter((x) => x.rel !== a.rel) });
      return false;
    }
    set({ chatAttachments: [...s.chatAttachments, a] });
    return true;
  },
  attachToChat: (a) => set((s) => {
    // Dedupe by rel — clicking the same tile twice is a no-op, not a stack.
    if (s.chatAttachments.some((x) => x.rel === a.rel)) return s;
    return { chatAttachments: [...s.chatAttachments, a] };
  }),
  removeChatAttachment: (id) => set((s) => ({
    chatAttachments: s.chatAttachments.filter((a) => a.id !== id),
  })),
  clearChatAttachments: () => set(() => ({
    // Clear EVERYTHING — manual and selection-derived. Sending a message
    // is a clean break: the chip's job is done. The caller is expected
    // to also clearSelection() if it wants to keep selection-sync from
    // re-adding the chips on the next timeline tick.
    chatAttachments: [],
  })),
  syncSelectionAttachments: (atts) => set((s) => {
    // Keep ALL manual attachments verbatim; drop any prior selection
    // entries; append the new selection set. Dedupe across both sets
    // by `rel` so a clip that the user also manually attached doesn't
    // appear twice — manual wins.
    const manual = s.chatAttachments.filter((a) => !a.fromSelection);
    const manualRels = new Set(manual.map((a) => a.rel));
    const flagged = atts
      .filter((a) => !manualRels.has(a.rel))
      .map((a): ChatAttachment => ({ ...a, fromSelection: true }));
    return { chatAttachments: [...manual, ...flagged] };
  }),

  pikaLiveGens: new Map(),
  upsertPikaLiveGen: (gen) => set((s) => {
    const next = new Map(s.pikaLiveGens);
    next.set(gen.id, gen);
    return { pikaLiveGens: next };
  }),
  setPikaLiveGens: (gens) => set(() => {
    const next = new Map<string, api.LiveGen>();
    for (const g of gens) next.set(g.id, g);
    return { pikaLiveGens: next };
  }),

  genJobs: new Map(),
  upsertGenJob: (job) => set((s) => {
    if (!job?.id) return s;
    const next = new Map(s.genJobs);
    next.set(job.id, job);
    return { genJobs: next };
  }),

  reconcilerHealth: null,
  setReconcilerHealth: (summary) => set({ reconcilerHealth: summary }),

  chatStarted: false,
  setChatStarted: (v) => set({ chatStarted: v }),
  pendingFirstMessage: null,
  setPendingFirstMessage: (text) => set({ pendingFirstMessage: text }),

  setAspect: (aspect) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, { ...s.timeline, aspect });
  }),
  setResolution: (resolution) => set((s) => {
    if (!s.timeline) return s;
    // 4K is only safe for Kling — but the renderer + agent enforce that.
    return withHistory(s, { ...s.timeline, resolution });
  }),
  setProjectName: (name) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, { ...s.timeline, name });
  }),
  setFps: (fps: 24 | 30 | 60) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, { ...s.timeline, fps });
  }),
  setRenderPreset: (preset: 'draft' | 'standard' | 'high') => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, { ...s.timeline, render: { ...s.timeline.render, preset } });
  }),

  // ─── Unified audio-clip actions ─────────────────────────────────────
  //
  // Single canonical implementation per op; we look up the clip on any
  // track and patch in place. Cross-track moves (the inter-lane drag) go
  // through moveAudioClipToTrack. Neighbor-clamp uses the same TRACK's
  // other clips so two A1 clips can't be dragged on top of each other,
  // but A1 and A2 can coexist at the same time.
  moveAudioClip: (id, newStart) => set((s) => {
    if (!s.timeline) return s;
    const found = findAudioClip(s.timeline, id);
    if (!found) return s;
    const dur = found.clip.out - found.clip.in;
    const clamped = Math.max(0, r3(newStart));
    const others = found.track.clips.filter((c) => c.id !== id);
    const prevEnd  = others.filter((c) => c.start < clamped).reduce((m, c) => Math.max(m, c.start + (c.out - c.in)), 0);
    const nextStart = others.filter((c) => c.start + (c.out - c.in) > clamped).reduce((m, c) => Math.min(m, c.start), Infinity);
    const start = Math.max(prevEnd, Math.min(nextStart - dur, clamped));
    const deltaSec = start - found.clip.start;
    let next = patchAudioClip(s.timeline, id, { start: r3(start) });
    // Premiere-style A↔V link — when an audio clip with a linkId moves,
    // every V clip sharing that link moves by the same delta.
    if (found.clip.linkId && Math.abs(deltaSec) > 1e-4) {
      next = {
        ...next,
        tracks: next.tracks.map((tr) => ({
          ...tr,
          clips: tr.clips.map((c) => c.linkId === found.clip.linkId
            ? { ...c, start: Math.max(0, r3(c.start + deltaSec)) }
            : c),
        })),
      };
    }
    return withHistory(s, next);
  }),
  trimAudioClipLeft: (id, deltaSec) => set((s) => {
    if (!s.timeline) return s;
    const found = findAudioClip(s.timeline, id);
    if (!found) return s;
    const { clip, track } = found;
    const others = track.clips.filter((c) => c.id !== id);
    const prevEnd = others.filter((c) => c.start < clip.start).reduce((m, c) => Math.max(m, c.start + (c.out - c.in)), 0);
    const clipEnd = clip.start + (clip.out - clip.in);
    const newStart = Math.max(prevEnd, Math.min(clipEnd - 0.05, clip.start + deltaSec));
    const newIn = Math.max(0, clip.in + (newStart - clip.start));
    if (newIn >= clip.out - 0.05) return s;
    const appliedDelta = newStart - clip.start;
    let next = patchAudioClip(s.timeline, id, { start: r3(newStart), in: r3(newIn) });
    if (clip.linkId && Math.abs(appliedDelta) > 1e-4) {
      next = {
        ...next,
        tracks: next.tracks.map((tr) => ({
          ...tr,
          clips: tr.clips.map((c) => {
            if (c.linkId !== clip.linkId) return c;
            const cNewStart = Math.max(0, c.start + appliedDelta);
            const cNewIn = Math.max(0, c.in + appliedDelta * (c.rate || 1));
            if (cNewIn >= c.out - 0.05) return c;
            return { ...c, start: r3(cNewStart), in: r3(cNewIn) };
          }),
        })),
      };
    }
    return withHistory(s, next);
  }),
  trimAudioClipRight: (id, deltaSec) => set((s) => {
    if (!s.timeline) return s;
    const found = findAudioClip(s.timeline, id);
    if (!found) return s;
    const { clip, track } = found;
    // maxOut precedence: naturalDuration → loaded buffer → c.out.
    const buffered = clip.src ? audio.buffers.get(clip.src)?.duration ?? 0 : 0;
    const naturalMax = clip.naturalDuration && clip.naturalDuration > 0
      ? clip.naturalDuration
      : (buffered > 0 ? buffered : clip.out);
    const others = track.clips.filter((c) => c.id !== id);
    const nextStart = others.filter((c) => c.start > clip.start).reduce((m, c) => Math.min(m, c.start), Infinity);
    const masterEndCap = nextStart - clip.start + clip.in;       // can't push past neighbor
    const maxOut = Math.min(naturalMax, masterEndCap);
    const newOut = Math.max(clip.in + 0.05, Math.min(maxOut, clip.out + deltaSec));
    const appliedDelta = newOut - clip.out;
    let next = patchAudioClip(s.timeline, id, { out: r3(newOut) });
    if (clip.linkId && Math.abs(appliedDelta) > 1e-4) {
      next = {
        ...next,
        tracks: next.tracks.map((tr) => ({
          ...tr,
          clips: tr.clips.map((c) => {
            if (c.linkId !== clip.linkId) return c;
            const scene = next.scenes.find((sc) => sc.id === c.sceneId);
            const natural = Math.max(0.1, scene?.naturalDuration ?? 5);
            const cNewOut = Math.max(c.in + 0.05, Math.min(natural, c.out + appliedDelta * (c.rate || 1)));
            return { ...c, out: r3(cNewOut) };
          }),
        })),
      };
    }
    return withHistory(s, next);
  }),
  splitAudioClipAt: (id, atTime) => set((s) => {
    if (!s.timeline) return s;
    // Route through the unified link-aware splitter — when the audio
    // clip carries a linkId (extracted-VO case), its sibling V clip on
    // V1 gets split at the same master-time and the second halves are
    // re-bound with a fresh shared linkId. Symmetric with the V-side
    // blade path.
    return withHistory(s, edit.splitClip(s.timeline, id, atTime));
  }),
  deleteAudioClip: (id) => set((s) => {
    if (!s.timeline) return s;
    return { ...withHistory(s, dropAudioClip(s.timeline, id)), selectedClipIds: [] };
  }),
  moveAudioClipToTrack: (id, trackId) => set((s) => {
    if (!s.timeline) return s;
    const found = findAudioClip(s.timeline, id);
    if (!found || found.track.id === trackId) return s;
    const next: Timeline = {
      ...s.timeline,
      audioTracks: s.timeline.audioTracks.map((t) => {
        if (t.id === found.track.id) return { ...t, clips: t.clips.filter((c) => c.id !== id) };
        if (t.id === trackId)         return { ...t, clips: [...t.clips, found.clip].sort((a, b) => a.start - b.start) };
        return t;
      }),
    };
    return withHistory(s, next);
  }),

  // Legacy aliases — all music/sfx-flavored methods route through the
  // unified actions above. Keeps existing component code (AudioClipBox,
  // Mixer, ClipGainPopover) working with no per-component edits required.
  moveMusicClip:      (id, newStart) => get().moveAudioClip(id, newStart),
  trimMusicClipLeft:  (id, delta) => get().trimAudioClipLeft(id, delta),
  trimMusicClipRight: (id, delta) => get().trimAudioClipRight(id, delta),
  deleteMusicClip:    (id) => get().deleteAudioClip(id),
  splitMusicClipAt:   (id, at) => get().splitAudioClipAt(id, at),
  moveSfxClip:        (id, newStart) => get().moveAudioClip(id, newStart),
  trimSfxClipLeft:    (id, delta) => get().trimAudioClipLeft(id, delta),
  trimSfxClipRight:   (id, delta) => get().trimAudioClipRight(id, delta),
  deleteSfxClip:      (id) => get().deleteAudioClip(id),
  splitSfxClipAt:     (id, at) => get().splitAudioClipAt(id, at),
  // Legacy lane-move: VO/SFX1/SFX2 map to a1/a2/a3 by convention from the
  // server-side migration. Move to that track id. If it doesn't exist
  // (e.g. user renamed lanes), this is a no-op — the call site shouldn't
  // be exercised in the new UI anyway.
  setSfxClipLane: (id, lane) => {
    const trackId = lane === 'VO' ? 'a1' : lane === 'SFX1' ? 'a2' : 'a3';
    get().moveAudioClipToTrack(id, trackId);
  },

  copyClips: () => set((s) => {
    if (!s.timeline) return s;
    const all = s.timeline.tracks.flatMap((tr) => tr.clips);
    const picked = all.filter((c) => s.selectedClipIds.includes(c.id));
    return { clipboard: picked };
  }),

  pasteClips: () => set((s) => {
    if (!s.timeline || s.clipboard.length === 0) return s;
    // Anchor the earliest clipboard clip at the current playhead; preserve
    // relative offsets of the rest.
    const minStart = Math.min(...s.clipboard.map((c) => c.start));
    const shift = s.playhead - minStart;
    const stamp = Date.now().toString(36);
    const newClips: Clip[] = s.clipboard.map((c, i) => ({
      ...c,
      id: `${c.id}_p${stamp}_${i}`,
      start: Math.max(0, Math.round((c.start + shift) * 1000) / 1000),
      comments: [],
      // Preserve linkId so a video+sfx group pasted together stays linked.
    }));
    const next: Timeline = {
      ...s.timeline,
      tracks: s.timeline.tracks.map((tr) => ({
        ...tr,
        clips: [...tr.clips, ...newClips.filter((nc) => nc.trackId === tr.id)].sort((a, b) => a.start - b.start),
      })),
    };
    return { ...withHistory(s, next), selectedClipIds: newClips.map((c) => c.id) };
  }),

  addVideoImport: ({ rel, filename, duration, startSec, sfxRel, linkId }) => set((s) => {
    if (!s.timeline) return s;
    const slug = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'video';
    const sceneId = `vi_${slug}_${Date.now().toString(36).slice(-4)}`;
    const clipId = `c_${sceneId}`;
    const scene = {
      id: sceneId,
      kind: 'video-import' as const,
      videoSrc: rel,
      naturalDuration: duration,
      sourceFps: 30,
      labels: [filename],
    };
    const newClip = {
      id: clipId,
      trackId: 'v1',
      sceneId,
      start: Math.max(0, Math.round(startSec * 1000) / 1000),
      in: 0,
      out: duration,
      rate: 1,
      fadeIn: 0,
      fadeOut: 0,
      smoothFps: false,
      linkId: linkId ?? null,
      comments: [],
    };
    let next: Timeline = {
      ...s.timeline,
      scenes: [...s.timeline.scenes, scene],
      tracks: s.timeline.tracks.map((tr) =>
        tr.id === 'v1' ? { ...tr, clips: [...tr.clips, newClip].sort((a, b) => a.start - b.start) } : tr,
      ),
      duration: Math.max(s.timeline.duration, newClip.start + duration),
    };
    if (sfxRel && linkId) {
      // Drop the imported audio onto the first audio track (A1 by
      // convention mirrors V1's audio); the server's auto-place can
      // bump it elsewhere on the next reload if it collides.
      const sfxClip = {
        id: `sfx_${sceneId}`,
        src: sfxRel,
        start: newClip.start,
        in: 0,
        out: duration,
        gain: 0,
        fadeIn: 0,
        fadeOut: 0,
        linkId,
        prompt: null,
        naturalDuration: duration,
        kind: 'vo' as const,
        status: 'ready' as const,
        errorMessage: null,
      };
      const targetTrackId = next.audioTracks[0]?.id ?? 'a1';
      next = {
        ...next,
        audioTracks: next.audioTracks.length === 0
          ? [{ id: 'a1', label: null, gain: 0, clips: [sfxClip] }]
          : next.audioTracks.map((t) => t.id === targetTrackId ? { ...t, clips: [...t.clips, sfxClip] } : t),
      };
    }
    return { ...withHistory(s, next), selectedClipIds: [clipId] };
  }),

  /**
   * Drop a PNG / WebP / JPG onto the timeline as an alpha overlay. Lands
   * on V2 (creates a V2 track if the project only has V1) so the image
   * composites OVER whatever video is playing on V1 at that time — the
   * renderer's `image-overlay` path skips the V1 carve and runs an
   * overlay= filter at export time. Duration defaults to 3s if the
   * caller doesn't pass one; user can trim afterwards on the timeline.
   */
  addImageOverlay: ({ rel, filename, duration, startSec }) => set((s) => {
    if (!s.timeline) return s;
    const slug = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'image';
    const sceneId = `io_${slug}_${Date.now().toString(36).slice(-4)}`;
    const clipId = `c_${sceneId}`;
    const dur = duration > 0 ? duration : 3;
    const scene = {
      id: sceneId,
      kind: 'image-overlay' as const,
      imageSrc: rel,
      naturalDuration: dur,
      labels: [filename],
    };
    // V2 hosts overlays. If the project's only got V1, materialize V2 so
    // the overlay has a home that's above the base video — otherwise
    // dropping it on V1 would just sit alongside the video clips and
    // visually conflict with them in the timeline UI.
    let tracks = s.timeline.tracks;
    const targetTrackId = 'v2';
    if (!tracks.some((t) => t.id === targetTrackId)) {
      tracks = [...tracks, { id: targetTrackId, label: null, kind: 'video' as const, audioMuted: false, clips: [] }];
    }
    const newClip = {
      id: clipId,
      trackId: targetTrackId,
      sceneId,
      start: Math.max(0, Math.round(startSec * 1000) / 1000),
      in: 0,
      out: dur,
      rate: 1,
      fadeIn: 0,
      fadeOut: 0,
      smoothFps: false,
      gain: 0,
      linkId: null,
      comments: [],
    };
    const next: Timeline = {
      ...s.timeline,
      scenes: [...s.timeline.scenes, scene],
      tracks: tracks.map((tr) =>
        tr.id === targetTrackId ? { ...tr, clips: [...tr.clips, newClip].sort((a, b) => a.start - b.start) } : tr,
      ),
      duration: Math.max(s.timeline.duration, newClip.start + dur),
    };
    return { ...withHistory(s, next), selectedClipIds: [clipId] };
  }),

  /** Drop an audio file (uploaded ref, already on disk under assets/) onto
   *  the timeline as a new AudioClip. Auto-places on the first track that
   *  has no time collision with the drop range; creates a new track if
   *  every existing one is occupied at that range. */
  addAudioImport: ({ rel, name, duration, startSec }) => set((s) => {
    if (!s.timeline) return s;
    const clipId = `aimp_${Date.now().toString(36)}`;
    const start = Math.max(0, Math.round(startSec * 1000) / 1000);
    const end = start + duration;
    const newClip = {
      id: clipId, src: rel.replace(/^assets\//, '').replace(/^\/+/, '') === '' ? rel : rel,
      // ^ keep rel as-is since render-job joins it with paths.project
      start,
      in: 0, out: duration,
      gain: 0, fadeIn: 0, fadeOut: 0,
      linkId: null, prompt: name,
      naturalDuration: duration,
      kind: 'imported' as const,
      status: 'ready' as const,
      errorMessage: null,
    };
    // Strip a leading "assets/" — the render pipeline + audio engine both
    // join the clip's src to paths.project, so the stored value should
    // be project-relative (e.g. "assets/refs/uploads/foo.mp3").
    if (!newClip.src.startsWith('assets/')) newClip.src = `assets/${newClip.src}`;
    // Find first track with no collision at [start, end).
    const tracks = s.timeline.audioTracks;
    let targetIdx = tracks.findIndex((t) => !t.clips.some((c) =>
      start < c.start + (c.out - c.in) - 1e-3 && c.start < end - 1e-3));
    let next: Timeline;
    if (targetIdx >= 0) {
      next = {
        ...s.timeline,
        audioTracks: tracks.map((t, i) => i === targetIdx ? { ...t, clips: [...t.clips, newClip] } : t),
      };
    } else {
      // No track fits — append a new one at the end of the list.
      const used = new Set(tracks.map((t) => t.id));
      let newId = `a${tracks.length + 1}`;
      while (used.has(newId)) newId = `a${Date.now().toString(36).slice(-4)}`;
      next = {
        ...s.timeline,
        audioTracks: [...tracks, { id: newId, label: null, gain: 0, clips: [newClip] }],
      };
    }
    return { ...withHistory(s, next), selectedClipIds: [clipId] };
  }),

  moveSelectedBy: (deltaSec, anchorClipId) => set((s) => {
    if (!s.timeline) return s;
    // Single-select path: defer to moveClip (snap + neighbor-clamp).
    // Only applies to V clips — audio + captions take their own move
    // paths from their components in the single-select case.
    if (s.selectedClipIds.length <= 1) {
      const anchor = s.timeline.tracks.flatMap((tr) => tr.clips).find((c) => c.id === anchorClipId);
      if (!anchor) return s;
      const next = edit.linkAfter(s.timeline, edit.moveClip(s.timeline, anchorClipId, anchor.start + deltaSec, s.timeline.downbeats, s.snapEnabled), anchorClipId);
      return withHistory(s, next);
    }
    // Group move: shift EVERY selected item — video clips, audio clips,
    // caption rows, floating comments — by deltaSec, clamped to >= 0.
    // Previously this only mapped over `tracks` (video), so multi-select
    // drag would visibly move only the video clips while linked audio
    // and selected captions sat in place. Now everything in the same
    // selection moves together as a true group.
    //
    // We deliberately skip per-clip neighbor clamps + snap here — a
    // group with mixed tracks would otherwise tear apart when one
    // member hits a neighbor. Round to ms. Caption rows preserve
    // (end - start), floating comments shift their single `at` field.
    const ids = new Set(s.selectedClipIds);
    const r3 = (n: number): number => Math.max(0, Math.round(n * 1000) / 1000);
    const shift = (n: number): number => r3(n + deltaSec);
    const next: Timeline = {
      ...s.timeline,
      tracks: s.timeline.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => ids.has(c.id) ? { ...c, start: shift(c.start) } : c),
      })),
      audioTracks: (s.timeline.audioTracks ?? []).map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => ids.has(c.id) ? { ...c, start: shift(c.start) } : c),
      })),
      captions: {
        ...s.timeline.captions,
        rows: s.timeline.captions.rows.map((r) => ids.has(r.id)
          ? { ...r, start: shift(r.start), end: r3(r.end + deltaSec) }
          : r),
      },
      floatingComments: (s.timeline.floatingComments ?? []).map((fc) => ids.has(fc.id)
        ? { ...fc, at: shift(fc.at) }
        : fc),
    };
    return withHistory(s, next);
  }),

  selectClip: (id, additive = false) => set((s) => ({
    selectedClipIds: additive
      ? (s.selectedClipIds.includes(id) ? s.selectedClipIds.filter((x) => x !== id) : [...s.selectedClipIds, id])
      : [id],
  })),
  clearSelection: () => set({ selectedClipIds: [] }),

  moveClip: (clipId, newStart) => set((s) => {
    if (!s.timeline) return s;
    const next = edit.linkAfter(s.timeline, edit.moveClip(s.timeline, clipId, newStart, s.timeline.downbeats, s.snapEnabled), clipId);
    return withHistory(s, next);
  }),
  reorderClipNearClip: (draggedId, targetId, insertBefore) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.reorderClipNearClip(s.timeline, draggedId, targetId, insertBefore));
  }),
  /** Move a video clip from whatever track currently holds it to `trackId`.
   *  No-op if the clip's not found or the target track equals the source.
   *  Caller is responsible for checking that the target track has room at
   *  the clip's current [start, end) range — drop-on-empty-lane semantics. */
  moveClipToTrack: (clipId, trackId) => set((s) => {
    if (!s.timeline) return s;
    let theClip: Clip | undefined;
    let sourceId = '';
    for (const tr of s.timeline.tracks) {
      const c = tr.clips.find((c) => c.id === clipId);
      if (c) { theClip = c; sourceId = tr.id; break; }
    }
    if (!theClip || sourceId === trackId) return s;
    const moved = { ...theClip, trackId };
    const next: Timeline = {
      ...s.timeline,
      tracks: s.timeline.tracks.map((tr) => {
        if (tr.id === sourceId) return { ...tr, clips: tr.clips.filter((c) => c.id !== clipId) };
        if (tr.id === trackId)  return { ...tr, clips: [...tr.clips, moved].sort((a, b) => a.start - b.start) };
        return tr;
      }),
    };
    return withHistory(s, next);
  }),

  /** Flip the per-track audioMuted flag on a video track. Affects both
   *  Preview's <video> mute state and the render pipeline's audio mix. */
  toggleVideoTrackMute: (trackId) => set((s) => {
    if (!s.timeline) return s;
    const next: Timeline = {
      ...s.timeline,
      tracks: s.timeline.tracks.map((tr) =>
        tr.id === trackId ? { ...tr, audioMuted: !tr.audioMuted } : tr,
      ),
    };
    return withHistory(s, next);
  }),
  trimLeft: (clipId, dt) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.linkAfter(s.timeline, edit.trimLeft(s.timeline, clipId, dt, s.timeline.downbeats, s.snapEnabled, s.playhead), clipId));
  }),
  trimRight: (clipId, dt) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.linkAfter(s.timeline, edit.trimRight(s.timeline, clipId, dt, s.timeline.downbeats, s.snapEnabled, s.playhead), clipId));
  }),
  stretchRight: (clipId, dt) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.stretchRight(s.timeline, clipId, dt, s.timeline.downbeats, s.snapEnabled));
  }),
  rippleTrimLeft: (clipId, dt) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.linkAfter(s.timeline, edit.rippleTrimLeft(s.timeline, clipId, dt, s.timeline.downbeats, s.snapEnabled, s.playhead), clipId));
  }),
  rippleTrimRight: (clipId, dt) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.linkAfter(s.timeline, edit.rippleTrimRight(s.timeline, clipId, dt, s.timeline.downbeats, s.snapEnabled, s.playhead), clipId));
  }),
  // Body-drag in ripple mode — `group` is captured once at drag start in
  // Clip.tsx so the moving set doesn't drift when dragging left.
  rippleMove: (group, dt) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.rippleMove(s.timeline, group, dt));
  }),
  slipClip: (clipId, dt) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.linkAfter(s.timeline, edit.slipClip(s.timeline, clipId, dt), clipId));
  }),
  setRate: (clipId, rate) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.setRate(s.timeline, clipId, rate));
  }),
  splitClipAt: (clipId, atTime) => set((s) => {
    if (!s.timeline) return s;
    return withHistory(s, edit.splitClip(s.timeline, clipId, atTime));
  }),
  rippleDelete: (clipId) => set((s) => {
    if (!s.timeline) return s;
    // Delete linked SFX siblings alongside the video clip + ripple downstream.
    const before = s.timeline.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId);
    let next = edit.rippleDelete(s.timeline, clipId);
    if (before?.linkId) {
      next = {
        ...next,
        audioTracks: next.audioTracks.map((t) => ({
          ...t,
          clips: t.clips.filter((sx) => sx.linkId !== before.linkId),
        })),
      };
    }
    return { ...withHistory(s, next), selectedClipIds: [] };
  }),
  deleteClip: (clipId) => set((s) => {
    if (!s.timeline) return s;
    const before = s.timeline.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId);
    let next = edit.deleteClip(s.timeline, clipId);
    if (before?.linkId) {
      next = {
        ...next,
        audioTracks: next.audioTracks.map((t) => ({
          ...t,
          clips: t.clips.filter((sx) => sx.linkId !== before.linkId),
        })),
      };
    }
    return { ...withHistory(s, next), selectedClipIds: [] };
  }),
  setAudioTrackGain: (trackId, db) => set((s) => {
    if (!s.timeline) return s;
    const next: Timeline = {
      ...s.timeline,
      audioTracks: s.timeline.audioTracks.map((t) => t.id === trackId ? { ...t, gain: db } : t),
    };
    return withHistory(s, next);
  }),
  setAudioTrackLabel: (trackId, label) => set((s) => {
    if (!s.timeline) return s;
    const next: Timeline = {
      ...s.timeline,
      audioTracks: s.timeline.audioTracks.map((t) => t.id === trackId ? { ...t, label } : t),
    };
    return withHistory(s, next);
  }),
  addAudioTrack: () => {
    const id = (() => {
      const tl = get().timeline;
      if (!tl) return 'a1';
      const used = new Set(tl.audioTracks.map((t) => t.id));
      for (let i = 1; i < 100; i++) if (!used.has(`a${i}`)) return `a${i}`;
      return `a_${Date.now().toString(36)}`;
    })();
    set((s) => {
      if (!s.timeline) return s;
      const next: Timeline = {
        ...s.timeline,
        audioTracks: [...s.timeline.audioTracks, { id, label: null, gain: 0, clips: [] }],
      };
      return withHistory(s, next);
    });
    return id;
  },

  /** Set the gain (dB) on a single music or SFX clip. Audio engine reads
   *  this on next play(); no live update because we're not tracking the
   *  per-clip gain node beyond schedule time. */
  setAudioClipGainDb: (clipId, db) => set((s) => {
    if (!s.timeline) return s;
    // Try audio tracks first (the canonical home of audio clips).
    // If not found there, fall through to V tracks — a V clip with
    // embedded audio (no linkId, source video has an audio track)
    // gets the same slider, applied to its embedded audio at render
    // time and in the preview <video>'s volume.
    for (const tr of s.timeline.audioTracks ?? []) {
      if (tr.clips.some((c) => c.id === clipId)) {
        return withHistory(s, patchAudioClip(s.timeline, clipId, { gain: db }));
      }
    }
    for (const tr of s.timeline.tracks ?? []) {
      if (tr.clips.some((c) => c.id === clipId)) {
        const next: Timeline = {
          ...s.timeline,
          tracks: s.timeline.tracks.map((t) => t.id !== tr.id ? t : {
            ...t,
            clips: t.clips.map((c) => c.id === clipId ? { ...c, gain: db } : c),
          }),
        };
        return withHistory(s, next);
      }
    }
    return s;
  }),

  patchClip: (clipId, patch) => set((s) => {
    if (!s.timeline) return s;
    const next: Timeline = {
      ...s.timeline,
      tracks: s.timeline.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
      })),
    };
    return withHistory(s, next);
  }),

  /** Break a video↔audio link: clear linkId on every clip that shares it
   *  (V1/V2 clips + SFX clips). After this, dragging/trimming the video no
   *  longer ripples to the audio (and vice-versa). Both stay on the timeline
   *  at their current positions — the user can then edit them independently. */
  breakLink: (linkId: string) => set((s) => {
    if (!s.timeline || !linkId) return s;
    const next: Timeline = {
      ...s.timeline,
      tracks: s.timeline.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => (c.linkId === linkId ? { ...c, linkId: null } : c)),
      })),
      audioTracks: s.timeline.audioTracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => (c.linkId === linkId ? { ...c, linkId: null } : c)),
      })),
    };
    return withHistory(s, next);
  }),
  relinkAudioClip: (audioClipId: string) => set((s) => {
    if (!s.timeline) return s;
    // Find the audio clip + parse its sceneId from the canonical id prefix.
    const audioClip = s.timeline.audioTracks.flatMap((tr) => tr.clips).find((c) => c.id === audioClipId);
    if (!audioClip || !audioClipId.startsWith('sfx_')) return s;
    const sceneId = audioClipId.slice(4);
    const vClip = s.timeline.tracks.flatMap((tr) => tr.clips).find((c) => c.sceneId === sceneId);
    if (!vClip) return s;   // no matching V → nothing to link to
    // Fresh shared linkId; overwrites any prior linkId on either side.
    const linkId = `lk_${sceneId}_${Date.now().toString(36).slice(-4)}`;
    const next: Timeline = {
      ...s.timeline,
      tracks: s.timeline.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => (c.id === vClip.id ? { ...c, linkId } : c)),
      })),
      audioTracks: s.timeline.audioTracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => (c.id === audioClipId ? { ...c, linkId } : c)),
      })),
    };
    return withHistory(s, next);
  }),

  // ─── Captions ────────────────────────────────────────────────────────
  addCaptionRow: (start, end, text = '') => {
    const id = `cap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000).toString(36)}`;
    set((s) => {
      if (!s.timeline) return s;
      const cap = s.timeline.captions;
      const row = {
        id,
        start: Math.max(0, Math.round(start * 1000) / 1000),
        end: Math.max(start + 0.1, Math.round(end * 1000) / 1000),
        text,
        style: null,
        linkSceneId: null,
      };
      const next: Timeline = { ...s.timeline, captions: { ...cap, rows: [...cap.rows, row] } };
      return { ...withHistory(s, next), selectedCaptionId: id };
    });
    return id;
  },
  patchCaptionRow: (id, patch) => set((s) => {
    if (!s.timeline) return s;
    const cap = s.timeline.captions;
    // Position + alignment live on captions.defaultStyle only — strip any
    // xPct/yPct/align that sneaks into a row.style override (legacy code
    // paths, agent tools) so the caption band stays a single linked group.
    const cleaned: typeof patch = { ...patch };
    if (cleaned.style && typeof cleaned.style === 'object') {
      const st = { ...cleaned.style };
      delete (st as Record<string, unknown>).xPct;
      delete (st as Record<string, unknown>).yPct;
      delete (st as Record<string, unknown>).align;
      cleaned.style = Object.keys(st).length === 0 ? null : st;
    }
    const next: Timeline = {
      ...s.timeline,
      captions: { ...cap, rows: cap.rows.map((r) => r.id === id ? { ...r, ...cleaned } : r) },
    };
    return withHistory(s, next);
  }),
  deleteCaptionRow: (id) => set((s) => {
    if (!s.timeline) return s;
    const cap = s.timeline.captions;
    const next: Timeline = {
      ...s.timeline,
      captions: { ...cap, rows: cap.rows.filter((r) => r.id !== id) },
    };
    return { ...withHistory(s, next), selectedCaptionId: s.selectedCaptionId === id ? null : s.selectedCaptionId };
  }),
  moveCaptionRow: (id, newStart) => set((s) => {
    if (!s.timeline) return s;
    const cap = s.timeline.captions;
    const target = cap.rows.find((r) => r.id === id);
    if (!target) return s;
    // Neighbor-clamp: a caption only ever displays one row at a time; if we
    // let rows overlap the preview shows the earlier one and the later one
    // silently disappears. Clamp against the closest previous-ending row
    // and next-starting row so dragging stops at their edges.
    const others = cap.rows.filter((r) => r.id !== id);
    const dur = target.end - target.start;
    const prevEnd = others.filter((r) => r.start < target.start).reduce((m, r) => Math.max(m, r.end), 0);
    const nextStart = others.filter((r) => r.start > target.start).reduce((m, r) => Math.min(m, r.start), Infinity);
    const start = Math.max(prevEnd, Math.min(nextStart - dur, Math.max(0, newStart)));
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const next: Timeline = {
      ...s.timeline,
      captions: {
        ...cap,
        rows: cap.rows.map((r) => r.id === id
          ? { ...r, start: r3(start), end: r3(start + dur) }
          : r),
      },
    };
    return withHistory(s, next);
  }),
  trimCaptionRowLeft: (id, deltaSec) => set((s) => {
    if (!s.timeline) return s;
    const cap = s.timeline.captions;
    const target = cap.rows.find((r) => r.id === id);
    if (!target) return s;
    const others = cap.rows.filter((r) => r.id !== id);
    // Clamp the new start against the previous row's end so the left edge
    // can't be dragged into a neighbor.
    const prevEnd = others.filter((r) => r.start < target.start).reduce((m, r) => Math.max(m, r.end), 0);
    const start = Math.max(prevEnd, Math.min(target.end - 0.1, target.start + deltaSec));
    const next: Timeline = {
      ...s.timeline,
      captions: { ...cap, rows: cap.rows.map((r) => r.id === id ? { ...r, start: Math.round(start * 1000) / 1000 } : r) },
    };
    return withHistory(s, next);
  }),
  trimCaptionRowRight: (id, deltaSec) => set((s) => {
    if (!s.timeline) return s;
    const cap = s.timeline.captions;
    const target = cap.rows.find((r) => r.id === id);
    if (!target) return s;
    const others = cap.rows.filter((r) => r.id !== id);
    // Clamp the new end against the next row's start.
    const nextStart = others.filter((r) => r.start > target.start).reduce((m, r) => Math.min(m, r.start), Infinity);
    const end = Math.max(target.start + 0.1, Math.min(nextStart, target.end + deltaSec));
    const next: Timeline = {
      ...s.timeline,
      captions: { ...cap, rows: cap.rows.map((r) => r.id === id ? { ...r, end: Math.round(end * 1000) / 1000 } : r) },
    };
    return withHistory(s, next);
  }),
  splitCaptionRowAt: (id, atTime) => set((s) => {
    if (!s.timeline) return s;
    const cap = s.timeline.captions;
    const row = cap.rows.find((r) => r.id === id);
    if (!row || atTime <= row.start + 0.05 || atTime >= row.end - 0.05) return s;
    const at = Math.round(atTime * 1000) / 1000;
    const newId = `${id}_b`;
    const first = { ...row, end: at };
    // Naive text split at the proportional midpoint of the line — good
    // enough for a "blade" cut; user fixes the words in the panel.
    const frac = (at - row.start) / Math.max(0.001, row.end - row.start);
    const splitAt = Math.max(0, Math.min(row.text.length, Math.round(row.text.length * frac)));
    const second = { ...row, id: newId, start: at, text: row.text.slice(splitAt).trimStart() };
    first.text = row.text.slice(0, splitAt).trimEnd();
    const next: Timeline = {
      ...s.timeline,
      captions: {
        ...cap,
        rows: cap.rows.flatMap((r) => r.id === id ? [first, second] : [r]),
      },
    };
    return withHistory(s, next);
  }),
  setCaptionsEnabled: (enabled) => set((s) => {
    if (!s.timeline) return s;
    const next: Timeline = { ...s.timeline, captions: { ...s.timeline.captions, enabled } };
    return withHistory(s, next);
  }),
  setCaptionsDefaultStyle: (patch) => set((s) => {
    if (!s.timeline) return s;
    const cap = s.timeline.captions;
    const next: Timeline = {
      ...s.timeline,
      captions: { ...cap, defaultStyle: { ...cap.defaultStyle, ...patch } },
    };
    return withHistory(s, next);
  }),

  undo: () => set((s) => {
    if (s.past.length === 0 || !s.timeline) return s;
    const previous = s.past[s.past.length - 1];
    return { timeline: previous, past: s.past.slice(0, -1), future: [s.timeline, ...s.future].slice(0, UNDO_MAX) };
  }),
  redo: () => set((s) => {
    if (s.future.length === 0 || !s.timeline) return s;
    const next = s.future[0];
    return { timeline: next, future: s.future.slice(1), past: [...s.past, s.timeline].slice(-UNDO_MAX) };
  }),
}));

// Debounced autosave: when timeline changes, push to server 100ms later.
// (Was 250ms — too long; users hit refresh before the timer fired and lost
// the deletion. Now 100ms is fast enough that most actions persist before
// any reload, and we also flush on beforeunload as a safety net.)
let saveTimer: number | null = null;
let pendingSave = false;
// In-flight save promise. Resolves when the current debounced save has
// landed on disk. App.tsx awaits this before re-fetching after an SSE
// `timeline-changed` so a save and a reload can't race.
let saveFlushPromise: Promise<void> | null = null;
let saveFlushResolve: (() => void) | null = null;
/**
 * Exported so the SSE handler in App.tsx can defer server-timeline reloads
 * while we have unsaved local edits. Otherwise SSE reloads racing with
 * deletes overwrite the deletion — the "delete three times" bug.
 */
export function hasPendingSave(): boolean { return pendingSave; }
/**
 * If a save is in flight (or queued), returns a promise that resolves once
 * it's persisted. Otherwise resolves immediately. Use this from any SSE
 * handler that wants to read fresh server state without racing the save —
 * `await flushPendingSave(); fetchTimeline()`. Replaces the old polling
 * loop in App.tsx which could miss reloads when the save cleared between
 * a flag-set and the first poll tick.
 */
export function flushPendingSave(): Promise<void> {
  return saveFlushPromise ?? Promise.resolve();
}

/**
 * Build an /asset/* URL with a cache-busting query param tied to the
 * current asset version in the store. Use this everywhere we render
 * <img src> / <video src> for project assets so a regenerated file
 * forces a re-fetch instead of serving the browser-cached version.
 *
 * `rel` accepts either "assets/foo.png" (raw timeline value) or
 * "foo.png" (already-stripped). The query param is appended only when
 * the asset has been seen via SSE asset-added; first load is plain.
 */
export function assetUrl(rel: string): string {
  // Pass through absolute URLs unchanged — used by live-bound workspace
  // tiles that resolve to a Pika CDN URL while waiting for the agent's
  // local download. Without this, an `https://...` URL would get rewritten
  // to `/asset/https://...` and 404.
  if (/^https?:\/\//i.test(rel)) return rel;
  const clean = rel.replace(/^assets\//, '');
  const v = useStore.getState().assetVersions[clean] ?? 0;
  return v > 0 ? `/asset/${clean}?v=${v}` : `/asset/${clean}`;
}
useStore.subscribe((state, prev) => {
  if (state.timeline && prev.timeline && state.timeline !== prev.timeline) {
    if (saveTimer) clearTimeout(saveTimer);
    pendingSave = true;
    // Start (or extend) the flush promise. If one is already pending we
    // re-use it so multiple edits coalesce into a single awaitable.
    if (!saveFlushPromise) {
      saveFlushPromise = new Promise<void>((res) => { saveFlushResolve = res; });
    }
    saveTimer = window.setTimeout(async () => {
      pendingSave = false;
      try { await state.save(); }
      finally {
        const resolve = saveFlushResolve;
        saveFlushPromise = null;
        saveFlushResolve = null;
        resolve?.();
      }
    }, 100);
  }
});

// Synchronous flush on tab close / refresh. If there's a pending save, send
// it now via fetch keepalive (same semantics as sendBeacon, but lets us PUT
// + set the if-match etag header — sendBeacon only does POST without
// headers). Without this, a Cmd-R immediately after deleting a clip would
// lose the change because the 100ms debounce hadn't fired yet.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (!pendingSave) return;
    const { timeline, etag } = useStore.getState();
    if (!timeline) return;
    try {
      void fetch('/timeline', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': etag },
        body: JSON.stringify(timeline),
        keepalive: true,
      });
    } catch { /* ignore — best effort */ }
    pendingSave = false;
  });
}
