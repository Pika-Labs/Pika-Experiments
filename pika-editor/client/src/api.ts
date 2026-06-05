import type { Timeline } from './types';

const headers = (etag?: string): HeadersInit => ({
  'content-type': 'application/json',
  ...(etag ? { 'if-match': etag } : {}),
});

export async function getTimeline(): Promise<{ timeline: Timeline; etag: string }> {
  const res = await fetch('/timeline');
  if (!res.ok) throw new Error(`getTimeline: ${res.status}`);
  return { timeline: await res.json(), etag: res.headers.get('etag') ?? '' };
}

export async function putTimeline(timeline: Timeline, etag: string): Promise<{ etag: string; conflict?: { current: Timeline; currentSha: string } }> {
  const res = await fetch('/timeline', { method: 'PUT', headers: headers(etag), body: JSON.stringify(timeline) });
  // Conflict path: server returns 200 with `conflict: true` (was 409
  // until the noise-suppression fix in routes/timeline.ts — see comment
  // there). We still need to handle a real 4xx for actual errors, so
  // check both shapes. Body-flag wins when present.
  if (!res.ok) throw new Error(`putTimeline: ${res.status}`);
  const body = await res.json();
  if (body?.conflict === true) {
    return { etag, conflict: { current: body.current, currentSha: body.currentSha } };
  }
  return { etag: body.sha };
}

export async function getProject(): Promise<any> { return (await fetch('/project')).json(); }
export interface ProjectEntry {
  name: string;
  displayName: string;
  dir: string;
  active: boolean;
  openedAt: number;
  aspect: string;
  resolution: string;
  fps: number;
  clipCount: number;
}
export async function getProjects(): Promise<{ activeDir: string; projects: ProjectEntry[] }> {
  return (await fetch('/projects')).json();
}
export async function selectProject(name: string): Promise<any> {
  const res = await fetch('/projects/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  return res.json();
}
export async function deleteProject(name: string): Promise<{ ok: boolean; deleted?: string; wasActive?: boolean; activated?: string | null; error?: string }> {
  const res = await fetch('/projects/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, confirm: true }),
  });
  return res.json();
}

export async function createProject(body: { name: string; aspect: string; resolution: string; fps?: 24 | 30 | 60 }): Promise<{ ok: boolean; name: string; displayName: string }> {
  const res = await fetch('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`createProject: ${res.status}`);
  return res.json();
}
export async function getLibrary(): Promise<any> { return (await fetch('/library')).json(); }

export interface UploadedRef {
  ok: boolean;
  rel: string;
  filename: string;
  kind: 'image' | 'video' | 'audio' | 'other';
  size: number;
  error?: string;
}

// ----- Agent runtime config (model + BYOK API key) -----------------
export interface AgentModel { id: string; label: string; tier: 'opus' | 'sonnet' | 'haiku' }
export interface AgentConfig {
  hasKey: boolean;
  hasOpenAIKey: boolean;
  model: string;
  availableModels: AgentModel[];
}
export async function getAgentConfig(): Promise<AgentConfig> {
  const r = await fetch('/agent/config');
  return r.json();
}
/** Set / clear API keys (Anthropic + OpenAI realtime), change the
 *  model. Keys never round-trip back — server returns `hasKey` /
 *  `hasOpenAIKey` only. */
export async function setAgentConfig(body: {
  apiKey?: string;
  openaiApiKey?: string;
  model?: string;
  clearKey?: boolean;
  clearOpenAIKey?: boolean;
}): Promise<{ ok: boolean; error?: string; hasKey?: boolean; hasOpenAIKey?: boolean; model?: string }> {
  const r = await fetch('/agent/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ----- Voice mode (OpenAI realtime) --------------------------------
/** Safe JSON parser — if the response body is empty or non-JSON
 *  (which can happen on weird proxy / network failures), returns a
 *  structured error object instead of throwing a cryptic
 *  "Unexpected end of JSON input". */
async function safeJson<T>(r: Response): Promise<T & { ok?: boolean; error?: string }> {
  const text = await r.text().catch(() => '');
  if (!text) {
    return { ok: false, error: `empty response (HTTP ${r.status})` } as any;
  }
  try { return JSON.parse(text); }
  catch {
    return { ok: false, error: `non-JSON response (HTTP ${r.status}): ${text.slice(0, 160)}` } as any;
  }
}

export interface VoiceSession {
  ok: boolean;
  sessionId?: string;
  clientSecret?: string;
  expiresAt?: number;
  model?: string;
  voice?: string;
  error?: string;
}
export async function startVoiceSession(): Promise<VoiceSession> {
  const r = await fetch('/voice/session', { method: 'POST' });
  return safeJson<VoiceSession>(r);
}
export interface VoiceContext {
  ok: boolean;
  history: Array<{ role: string; text: string }>;
  timeline: unknown;
}
export async function getVoiceContext(): Promise<VoiceContext> {
  const r = await fetch('/voice/context');
  return safeJson<VoiceContext>(r);
}
export async function callVoiceTool(name: string, input: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const r = await fetch('/voice/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }),
  });
  return safeJson(r);
}
export async function syncVoiceTranscript(transcript: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/voice/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript }),
  });
  return safeJson(r);
}

/** Upload a file as a reference asset. Server writes to
 *  `assets/refs/uploads/`; returns the project-relative path + inferred
 *  kind. Used by the left-rail Reference Library. */
export async function uploadRef(file: File): Promise<UploadedRef> {
  const res = await fetch(`/upload/ref?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  return res.json();
}

export async function getBeats(): Promise<any | null> {
  const res = await fetch('/beats');
  if (res.status === 404) return null;
  return res.json();
}

export async function detectBeats(src?: string): Promise<{ ok: boolean; bpm?: number; beatsCount?: number; error?: string; hint?: string }> {
  const res = await fetch('/beats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(src ? { src } : {}) });
  return res.json();
}

export interface WorkspaceAssetItem {
  name: string;
  rel: string;
  kind: 'image' | 'video' | 'audio' | 'other';
  size: number;
  mtime: number;
}
export interface WorkspaceAssetGroup {
  group: string;
  label: string;
  items: WorkspaceAssetItem[];
}
export async function getWorkspaceAssets(): Promise<{ groups: WorkspaceAssetGroup[] }> {
  return (await fetch('/workspace/assets')).json();
}
export async function getWorkspaceBrief(): Promise<string | null> {
  const res = await fetch('/workspace/brief');
  if (res.status === 404) return null;
  return res.text();
}

export interface WorkspaceDialogue { who?: string; line: string }
export interface WorkspaceItem {
  id?: string;            // stable identifier for "talk about this" refs
  src?: string;           // when omitted, item renders as a placeholder
  pending?: boolean;      // explicit "this is being generated" hint
  /** Live-bind this tile to a Pika gen. When set, the Workspace
   *  subscribes to pika-live-gen SSE events and auto-resolves this
   *  tile to the gen's result the moment it completes (or shows
   *  a red failed state on error). No second write_workspace needed. */
  taskId?: string;
  /** Server-set when claimWorkspaceTile binds this tile to a video
   *  scene at fire time. Lets the renderer link tile ↔ scene without
   *  the agent having to coordinate ids. */
  sceneId?: string;
  /** Persistent failure state — set by the server when an auto-bind
   *  download fails, the gen errors out, or a PATCH cannot land.
   *  Survives across the in-memory LiveGen's 8s expiry AND across
   *  page refreshes, so the user always sees what went wrong. The
   *  tile is rendered with a red "Generation failed" state until the
   *  user dismisses it. */
  failed?: boolean;
  errorMessage?: string;
  /** Model that produced this asset, e.g. "kling-v3-omni", "gpt-image-2",
   *  "seedance-2-pro". Persisted on the tile so the badge can show it
   *  long after the live-gen entry expires. Optional — falls back to
   *  the live gen's model (during gen) or generic "Image"/"Video". */
  model?: string;
  label?: string;
  caption?: string;       // optional cinematography / technical note
  action?: string;        // what happens in the beat (one short line)
  dialogue?: WorkspaceDialogue[];   // lines spoken in the beat
}

/** A single row in a `proposal` workspace block — one decision the user can
 *  scan, with disposition pill + short summary + optional before/after refs
 *  + collapsed rationale. */
export type Disposition = 'keep' | 'change' | 'regen' | 'new' | 'drop';
export interface ProposalItem {
  id: string;                // stable identifier — used when round-tripping decisions back
  label: string;             // beat / item name
  disposition: Disposition;
  summary?: string;          // one-line "what's changing"
  fromSrc?: string;          // current asset path
  toSrc?: string;            // proposed asset path (often absent if change is conceptual)
  fromNote?: string;         // current framing/state in plain text
  toNote?: string;           // proposed framing/state in plain text
  rationale?: string;        // collapsed by default
}

/** Side-by-side before/after pairs (no decision affordance — pure visual).
 *  Field names match the proposal item for consistency: from / to. */
export interface CompareItem {
  label: string;
  fromSrc: string;
  toSrc: string;
  note?: string;
}

export type WorkspacePrimary =
  | { kind: 'image-grid' | 'video-grid' | 'two-up-compare' | 'single' | 'video-player'; items: WorkspaceItem[] }
  | { kind: 'proposal'; items: ProposalItem[]; commitLabel?: string }
  | { kind: 'compare'; items: CompareItem[] }
  | { kind: 'none'; items: [] };
/** A single decision the user can greenlight with one click. The button
 *  label is what the user sees on the chip; `reply` is the templated
 *  message that fills the chat input when clicked. The agent should
 *  write replies as if the user is saying them ("Greenlight on the
 *  character refs", "Go with Reg", etc.) so submitting unaltered is
 *  unambiguous. */
export interface WorkspaceAskItem {
  id?: string;
  label: string;       // short button label, e.g. "Greenlight #1"
  reply: string;       // full message that lands in chatDraft on click
}
/** Structured ask block. Replaces the old freeform string — agent writes
 *  this when there are discrete confirmations the user can fire off as
 *  quick replies. The freeform string variant is still accepted for the
 *  legacy / no-buttons case. */
export interface WorkspaceAskStructured {
  headline?: string;
  body?: string;       // optional intro/context line (rendered above items)
  items: WorkspaceAskItem[];
}
export type WorkspaceAsk = string | WorkspaceAskStructured;

export interface WorkspaceState {
  phase?: string;
  generatedAt?: string;
  headline?: string;
  subhead?: string;
  body?: string;
  primary?: WorkspacePrimary;
  ask?: WorkspaceAsk;
  activity?: string[];
}
/** Remove a tile from workspace.json's primary.items by index. Used
 *  when a gen has hung / failed / orphaned and the user wants to clear
 *  it without waiting on the agent. */
export async function dismissWorkspaceTile(index: number): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/workspace/dismiss-tile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ index }),
  });
  return res.json();
}

export async function getWorkspaceState(): Promise<WorkspaceState | null> {
  const res = await fetch('/workspace/state');
  if (res.status === 404) return null;
  return res.json();
}

export async function getWorkspaceHistory(): Promise<{ snapshots: string[] }> {
  return (await fetch('/workspace/history')).json();
}

export async function autoCaption(body: { sceneId: string; script?: string; replace?: boolean }): Promise<{ ok?: boolean; added?: number; error?: string; detail?: string }> {
  const res = await fetch('/captions/auto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Robust parse: server can return empty body on crash or proxy timeout;
  // surface that as an error object instead of throwing.
  const text = await res.text();
  try { return text ? JSON.parse(text) : { error: 'empty-response' }; }
  catch { return { error: 'non-json-response', detail: text.slice(0, 400) }; }
}

export async function autoCaptionAll(body: { defaultScript?: string; clearAll?: boolean } = {}): Promise<{
  ok?: boolean;
  total?: number;
  scenes?: Array<{ sceneId: string; added?: number; usedWhisperTimings?: boolean; error?: string }>;
  error?: string;
  detail?: string;
}> {
  const res = await fetch('/captions/auto-all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return text ? JSON.parse(text) : { error: 'empty-response' }; }
  catch { return { error: 'non-json-response', detail: text.slice(0, 400) }; }
}

export async function deleteAllCaptions(): Promise<{ ok?: boolean; removed?: number; error?: string }> {
  const res = await fetch('/captions', { method: 'DELETE' });
  const text = await res.text();
  try { return text ? JSON.parse(text) : { error: 'empty-response' }; }
  catch { return { error: 'non-json-response' }; }
}

export async function repairCaptions(): Promise<{ ok?: boolean; rows?: number; error?: string }> {
  const res = await fetch('/captions/repair', { method: 'POST' });
  const text = await res.text();
  try { return text ? JSON.parse(text) : { error: 'empty-response' }; }
  catch { return { error: 'non-json-response' }; }
}

export async function getWorkspaceSnapshot(stamp: string): Promise<WorkspaceState | null> {
  const res = await fetch(`/workspace/history/${encodeURIComponent(stamp)}`);
  if (res.status === 404) return null;
  return res.json();
}

export interface PikaAuthStatus { authenticated: boolean; expiresInSec?: number }
export async function getPikaAuthStatus(): Promise<PikaAuthStatus> {
  return (await fetch('/oauth/pika/status')).json();
}

export interface PikaAccount {
  connected: boolean;
  display?: string | null;
  phone?: string | null;
  credits?: number | null;
}
export async function getPikaAccount(): Promise<PikaAccount> {
  return (await fetch('/pika/account')).json();
}
export async function startPikaAuth(): Promise<{ authorizeUrl?: string; error?: string }> {
  const res = await fetch('/oauth/pika/start', { method: 'POST' });
  return res.json();
}
export async function disconnectPika(): Promise<{ ok: boolean }> {
  const res = await fetch('/oauth/pika/disconnect', { method: 'POST' });
  return res.json();
}

/* ---------- Per-clip audio extract ---------- */
export async function extractClipAudio(clipId: string): Promise<{ ok: boolean; audioClipId?: string; trackId?: string; reused?: boolean; error?: string; detail?: string }> {
  const res = await fetch(`/clips/${encodeURIComponent(clipId)}/extract-audio`, { method: 'POST' });
  return res.json();
}

/* ---------- Chat conversation control ---------- */
export interface ChatStats { tokens: number; messageCount: number; contextLimit: number; fractionUsed: number }
export async function getChatStats(): Promise<ChatStats | null> {
  const res = await fetch('/chat/stats');
  if (!res.ok) return null;
  return res.json();
}
export async function compactChat(): Promise<{ ok: boolean; beforeTokens?: number; afterTokens?: number; droppedMessages?: number }> {
  const res = await fetch('/chat/compact', { method: 'POST' });
  return res.json();
}
export async function resetChat(): Promise<{ ok: boolean }> {
  const res = await fetch('/chat/reset', { method: 'POST' });
  return res.json();
}

export interface AgentPersona { name: string; creature?: string; vibe?: string; emoji?: string; avatarUrl?: string }
export async function getAgentPersona(): Promise<AgentPersona | null> {
  const res = await fetch('/agent/persona');
  if (!res.ok) return null;
  const body = await res.json() as { persona: AgentPersona | null };
  return body.persona;
}

export interface LiveGen {
  id: string;
  tool: string;
  model?: string;
  prompt?: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  resultPreview?: string;
  errorMessage?: string;
  // Progress streamed from Pika MCP via notifications/progress while a
  // gen runs. `progressPct` is the already-normalised 0–100 value the UI
  // renders directly; `progressMessage` is an optional short status line.
  progress?: number;
  progressTotal?: number;
  progressMessage?: string;
  progressPct?: number;
  // Bind targets — present once the gen is wired to a scene or workspace
  // tile. Lets the timeline V1 clip find its matching gen for progress
  // display without a separate lookup.
  sceneId?: string;
  tileId?: string;
}
export interface Preset {
  id: string;
  title: string;
  oneliner: string;
  bullets?: string[];
  kind: 'video' | 'image' | 'brand' | 'audio' | 'custom';
  triggerText: string;
  previewSrc: string | null;
  requiresPika: boolean;
}

export async function getPresets(): Promise<Preset[]> {
  try {
    const res = await fetch('/presets');
    if (!res.ok) return [];
    const body = await res.json() as { presets: Preset[] };
    return body.presets ?? [];
  } catch { return []; }
}

export async function getActivePikaGens(): Promise<LiveGen[]> {
  const res = await fetch('/agent/pika-gens');
  if (!res.ok) return [];
  const body = await res.json() as { gens: LiveGen[] };
  return body.gens;
}

/* ---------- Plan ---------- */

export interface PlanCast { id?: string; name?: string; role?: string; refSrc?: string; notes?: string }
export interface PlanLocation { id?: string; name?: string; refSrc?: string; notes?: string }
export interface PlanBeat {
  id?: string;
  label?: string;
  timecode?: string;
  durationSec?: number;
  action?: string;
  dialogue?: WorkspaceDialogue[];
  framingNote?: string;
  storyboardSrc?: string;
  videoSrc?: string;
  model?: string;
  status?: 'planned' | 'storyboard-approved' | 'video-ready';
}
export interface PlanDecision { id?: string; question?: string; options?: string[] }
export interface Plan {
  concept?: string;
  styleAnchor?: string;
  cast?: PlanCast[];
  locations?: PlanLocation[];
  beats?: PlanBeat[];
  music?: { plan?: string; cueRefs?: string[] };
  sfx?: { plan?: string };
  openDecisions?: PlanDecision[];
  updatedAt?: string;
}
export async function getPlan(): Promise<Plan> {
  const res = await fetch('/plan/state');
  if (!res.ok) return {};
  return res.json();
}

export async function getComments(): Promise<{ comments: any[] }> {
  return (await fetch('/comments')).json();
}

export async function addComment(b: { clipId?: string; trackId?: string; at: number; note: string; author?: 'user' | 'agent'; ghostClipId?: string | null }) {
  const res = await fetch('/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return res.json();
}

export async function patchComment(id: string, patch: { note?: string; resolved?: boolean; agentReply?: string | null }) {
  const res = await fetch(`/comments/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  return res.json();
}

export async function deleteComment(id: string) {
  const res = await fetch(`/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.json();
}

export async function createPikaScene(body: {
  prompt: string; model: string; duration: number; refs?: string[];
  trackId?: string; startSec?: number; labels?: string[];
}): Promise<{ ok: boolean; sceneId: string; clipId: string }> {
  const res = await fetch('/scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`createPikaScene: ${res.status}`);
  return res.json();
}

export async function patchScene(id: string, patch: Record<string, unknown>): Promise<any> {
  const res = await fetch(`/scenes/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`patchScene: ${res.status}`);
  return res.json();
}

export async function getPendingScenes(): Promise<{ pending: any[] }> {
  return (await fetch('/scenes/pending')).json();
}

export async function postRender(opts: {
  fps?: 24 | 30 | 60;
  preset?: 'draft' | 'standard' | 'high';
  saveDir?: string;
  filename?: string;
} = {}): Promise<{ ok: boolean; jobId: string }> {
  const res = await fetch('/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts) });
  return res.json();
}

export interface Version { sha: string; message: string; date: string; current: boolean }
export async function listVersions(): Promise<{ versions: Version[] }> {
  return (await fetch('/versions')).json();
}
export async function saveVersion(name: string): Promise<{ ok: boolean; versions: Version[] }> {
  const res = await fetch('/versions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  return res.json();
}
export async function restoreVersion(sha: string): Promise<any> {
  const res = await fetch(`/versions/${encodeURIComponent(sha)}/restore`, { method: 'POST' });
  return res.json();
}

export async function generateSfx(b: { prompt: string; startSec: number; durationSec?: number; lane?: 'VO' | 'SFX1' | 'SFX2'; trackId?: string }): Promise<{ ok: boolean; placeholderId: string } | { error: string; hint?: string }> {
  const res = await fetch('/sfx/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return res.json();
}

export async function generateMusic(b: { prompt: string; startSec: number; durationSec: number }): Promise<{ ok: boolean; id: string }> {
  const res = await fetch('/music/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return res.json();
}

export async function getMusicPending(): Promise<{ pending: any[] }> {
  return (await fetch('/music/pending')).json();
}

export async function patchMusicClip(id: string, patch: { src?: string; status?: string; errorMessage?: string | null }) {
  const res = await fetch(`/music/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  return res.json();
}

export async function uploadImport(file: File, opts: { extractAudio?: boolean } = {}): Promise<{ ok: boolean; rel: string; filename: string; duration: number; kind: 'video' | 'image'; sfxRel: string | null; linkId: string | null }> {
  const qs = new URLSearchParams({ filename: file.name });
  if (opts.extractAudio) qs.set('extractAudio', 'true');
  const res = await fetch(`/upload/import?${qs.toString()}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error(`uploadImport: ${res.status}`);
  return res.json();
}

/** Upload a user-supplied audio file as a music clip on the music lane.
 *  Same editability (move/trim/blade) as a generated music clip. */
export async function uploadMusic(file: File, startSec: number): Promise<{ ok: boolean; id: string; rel: string; durationSec: number }> {
  const qs = new URLSearchParams({ filename: file.name, startSec: String(startSec) });
  const res = await fetch(`/music/import?${qs.toString()}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error(`uploadMusic: ${res.status}`);
  return res.json();
}
