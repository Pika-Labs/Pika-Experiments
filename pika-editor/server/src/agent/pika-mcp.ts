/**
 * Local MCP client for Pika MCP.
 *
 * We host the MCP client inside this server (same trust model as Claude
 * Code's plugin runtime). Bearer tokens never leave the user's machine —
 * the OAuth-issued token flows from `pika-auth.ts` directly to
 * `mcp.pika.me` via Streamable HTTP. Anthropic's Messages API only ever
 * sees the resulting text/image content as `tool_result` blocks; it
 * never sees the token itself.
 *
 * Lifecycle:
 *   - Lazy connect on first tool call (or on listTools).
 *   - Cache the tool list for the lifetime of the connection.
 *   - On 401 we drop the connection so the next call refreshes the token.
 *
 * Tool naming convention: every Pika MCP tool is exposed to our agent
 * loop with a `pika_` prefix (e.g. `pika_generate_image`). This avoids
 * collisions with our own native tools and gives the chat UI a clean
 * grouping handle.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool as MCPTool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createGenJob,
  recordTransition,
  recordProgress,
  newGenJobId,
  getJob as getGenJob,
  type GenJob,
  type GenJobBind,
} from './gen-jobs.js';
import { scheduleCreditsRefreshAfterGen } from './pika-credits.js';
import type Anthropic from '@anthropic-ai/sdk';
import { getAccessToken, isAuthenticated } from './pika-auth.js';
import { events, type LiveGen } from '../events.js';
import { recordPending, clearPending, listPending, type PendingGen } from './pending-gens.js';
import { recordGenEvent } from './gen-events.js';
import { paths, mutateWorkspace } from '../state.js';
import { resolveSafe } from './sandbox.js';

/** Containment guard for agent/model-supplied save paths. `resolveSafe`
 *  resolves the relative path against the active project and throws if it
 *  escapes the sandbox (defeating `../` traversal + symlink escapes). We
 *  additionally require the destination to be writable. Legit paths like
 *  `assets/refs/foo.png` pass unchanged; `../../server/.env` throws. */
function safeProjectAbs(rel: string): string {
  const resolved = resolveSafe(rel);
  if (!resolved.writable) {
    throw new Error(`refusing to write outside the writable sandbox: ${rel}`);
  }
  return resolved.abs;
}

/** SSRF guard for asset-download URLs returned by the MCP. Requires http(s)
 *  and rejects loopback / private / link-local hosts so a crafted or
 *  compromised tool result can't pivot the server's fetch onto internal
 *  endpoints (IMDS, localhost services). Public CDN URLs pass unchanged. */
function assertSafeAssetUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`invalid asset URL: ${raw}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`asset URL must be http(s): ${raw}`);
  }
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' || host === '::1' || host.endsWith('.localhost') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error(`asset URL host not allowed (SSRF guard): ${host}`);
  }
}

const liveGens = new Map<string, LiveGen>();
const LIVE_GEN_KEEP_AFTER_DONE_MS = 8000;
let nextGenId = 0;

/**
 * Best-guess expected duration for a gen so we can render an estimated
 * progress percent on top of Pika's elapsed-seconds heartbeats (Pika
 * itself doesn't send a denominator). Empirical from typical runs;
 * each value is a slight overestimate so the bar never claims 100%
 * before completion. Unknown tool/model falls back to 90s.
 *
 * Capped at 95% in the UI; flips to 100% only on the explicit
 * "image ready" / done broadcast.
 */
function expectedDurationSec(tool: string, model?: string): number {
  const t = tool.replace(/^pika_/, '');
  const m = (model ?? '').toLowerCase();
  if (t === 'generate_image') {
    if (m.includes('gpt-image-2')) return 180;
    if (m.includes('nano-banana')) return 20;
    if (m.includes('seedream')) return 30;
    if (m.includes('gemini-flash')) return 8;
    return 60;
  }
  if (t === 'generate_video' || t === 'generate_reference_video') {
    if (m.includes('seedance')) return 180;
    if (m.includes('kling')) return 100;
    if (m.includes('veo')) return 120;
    if (m.includes('sora')) return 200;
    return 150;
  }
  if (t === 'generate_keyframes_video') return 100;
  if (t === 'generate_motion_control_video') return 150;
  if (t === 'generate_lipsync') return 80;
  if (t === 'generate_speech') return 20;
  if (t === 'generate_music') return 60;
  return 90;
}

// Persistent gen_id → model map. liveGens expires entries 8s after a gen
// finishes (so the UI can stop rendering "live" spinners), but the model
// metadata is needed long-term for workspace tile enrichment — when the
// agent calls write_workspace with a tile carrying `taskId: gen_47`,
// server-side post-processing fills the tile's `model` field from this
// map. Never expires; small in-memory footprint (just strings).
const genIdToModel = new Map<string, string>();
export function getModelForGenId(id: string): string | undefined {
  return genIdToModel.get(id);
}

function isGenerationTool(toolName: string): boolean {
  // Includes generate_*, pika_scene, pika_swap, pika_effect, pika_addition,
  // edit_animate_zoom, etc. — anything that produces a new asset visibly.
  return /^(generate_|pika_(scene|swap|effect|addition)|sora_edit|create_kling_element|create_sora_character|clone_voice|edit_animate_zoom|edit_beat_sync|generate_lipsync|render_html_animation)/.test(toolName);
}

export function getActiveLiveGens(): LiveGen[] {
  return Array.from(liveGens.values());
}

const PIKA_MCP_URL = 'https://mcp.pika.me/api/mcp';
const TOOL_PREFIX = 'pika_';

// Pika's server-side blocking budget is ~260s per call; after that it
// falls back to {task_id, status}. The MCP SDK default request timeout
// is 60s, which is WAY too short for video generation. We use a 15min
// hard cap matched to POLL_TIMEOUT_MS — long enough that Seedance
// reference-to-video calls that take 5–8min on Pika's side can finish
// without our SDK aborting first (which surfaced as opaque `MCP error
// -32001: Request timed out` on the timeline clip). Combined with
// resetTimeoutOnProgress: true on every callTool, even slow gens that
// stream progress notifications can hold the connection indefinitely
// — the 15min ceiling is a sanity guard, not a real cap.
const CALL_TIMEOUT_MS = 15 * 60_000;
// task_status itself blocks server-side up to ~20s. Poll in a tight loop,
// no client-side sleep (per the MCP server's own guidance). Cap total time
// at 15 minutes — beyond that something is genuinely wrong.
const POLL_TIMEOUT_MS = 15 * 60_000;

let client: Client | null = null;
let cachedTools: MCPTool[] = [];
let connecting: Promise<Client> | null = null;

async function ensureConnected(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const token = await getAccessToken();
    if (!token) throw new Error('not connected to pika — click "Connect Pika" in the chat panel');
    const transport = new StreamableHTTPClientTransport(new URL(PIKA_MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const c = new Client({ name: 'PikaAgentEditor', version: '0.1.0' });
    await c.connect(transport);

    // Pika emits `notifications/message` (MCP's logging channel) — NOT
    // `notifications/progress` — for in-flight gens. Heartbeats look
    // like: `"still working (elapsed 76s, generating image via gpt-image-2)"`
    // with a `{event: "submitted", task_id, status: "queued"}` object
    // on start. We listen on the logging channel, parse the elapsed
    // seconds out of the text, and update the matching LiveGen so the
    // workspace tile / timeline V1 clip can show "Generating… 76s".
    //
    // The `data` field is either a string (the "still working" form)
    // or an object (the submit envelope). Both shapes are handled.
    console.log('[pika-mcp] notification handler ready (notifications/message → LiveGen.progress)');
    c.setNotificationHandler(LoggingMessageNotificationSchema, (notif: { params: { level?: string; data?: unknown; logger?: string } }) => {
      const data = notif.params?.data;
      let text: string | undefined;
      let derivedElapsedSec: number | undefined;
      if (typeof data === 'string') {
        text = data;
      } else if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        // submitted/queued envelope — no useful elapsed yet, but record
        // the message so the user sees "submitted to Pika" right away.
        if (typeof obj.event === 'string') {
          text = String(obj.event);
        } else if (typeof obj.message === 'string') {
          text = obj.message;
        }
      }
      // Pull elapsed seconds out of the heartbeat ("elapsed 76s", "elapsed 31s").
      if (text) {
        const m = text.match(/elapsed\s+(\d+)s/i);
        if (m) derivedElapsedSec = parseInt(m[1], 10);
      }
      // Without a per-request token in the notification, we can't
      // route deterministically. In practice for our editor (one
      // user, ≤handful of concurrent gens) routing to ALL currently-
      // running LiveGens is fine — they all care about their own
      // heartbeats anyway, and message text is per-tool ("generating
      // image via gpt-image-2" / "generating video via seedance").
      // Match by the tool name embedded in the text when possible to
      // avoid cross-talk between concurrent image vs. video gens.
      const targets = [...liveGens.values()].filter((lg) => lg.status === 'running');
      if (targets.length === 0) return;
      // Match by the tool name embedded in the text when possible — e.g.
      // "generating image via gpt-image-2" matches a LiveGen with tool
      // "generate_image". Avoids cross-talk between concurrent image and
      // video gens. Fallback: broadcast to every running gen (acceptable
      // for the typical single-batch case).
      const matchTool = text ? targets.find((lg) => text!.includes(lg.tool)) : undefined;
      const route = matchTool ? [matchTool] : targets;
      for (const lg of route) {
        if (text) lg.progressMessage = text.length > 80 ? text.slice(0, 80) + '…' : text;
        if (typeof derivedElapsedSec === 'number') {
          lg.progress = derivedElapsedSec;
          const expected = expectedDurationSec(lg.tool, lg.model);
          lg.progressPct = Math.max(1, Math.min(95, Math.round((derivedElapsedSec / expected) * 100)));
        }
        events.broadcast({ type: 'pika-live-gen', gen: lg });
        // Mirror onto the GenJob so the canonical record stays in sync
        // — UI surfaces that read GenJob (Phase 4) see the same heartbeats.
        const jobId = (lg as LiveGen & { jobId?: string }).jobId;
        if (jobId) {
          // A heartbeat is proof the gen is alive on Pika's side. If
          // the GenJob is still in `firing` (no task envelope yet —
          // Pika may respond inline), transition to `running` so the
          // reconciler's firing-timeout doesn't falsely kill a healthy
          // long gen. Best-effort; bookkeeping must never block the
          // gen pipeline.
          try {
            const job = getGenJob(jobId);
            if (job && job.state === 'firing') {
              recordTransition(jobId, 'running');
            }
          } catch { /* swallow — reconciler will catch any real drift */ }
          recordProgress(jobId, {
            progressSec: lg.progress,
            progressPct: lg.progressPct,
          });
        }
      }
    });

    client = c;
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export function disconnect(): void {
  if (client) {
    try { void client.close(); } catch { /* best effort */ }
    client = null;
    cachedTools = [];
  }
}

/**
 * Boot-time resume: read .agent/pending-gens.json and spawn a poller for
 * every gen that was running when the server last died. The Pika side has
 * been cooking the gen the whole time — we just need to re-attach to its
 * task_id, finish the poll, download the asset, run the same auto-bind
 * that would've fired without the restart.
 *
 * Idempotent: if a task is already terminal at the time we poll, the
 * download+bind runs immediately. If Pika says the task_id is invalid
 * (e.g. expired), we clear the record and skip — no infinite retry.
 *
 * Called once from `init()`. Errors per-entry are logged and don't block
 * the others.
 */
export async function resumePendingGens(): Promise<void> {
  const pending = listPending();
  if (pending.length === 0) {
    console.log('[pika-mcp] resume: no pending gens to recover');
    return;
  }
  if (!isAuthenticated()) {
    console.log(`[pika-mcp] resume: ${pending.length} pending gen(s) on disk, but Pika not authenticated — leaving for next auth + restart`);
    return;
  }
  console.log(`[pika-mcp] resume: re-attaching ${pending.length} in-flight gen(s)`);
  for (const p of pending) {
    void resumeOnePending(p)
      .catch((err: unknown) => console.warn(`[pika-mcp] resume ${p.taskId.slice(0, 12)}… failed:`, (err as Error)?.message ?? err));
  }
}

async function resumeOnePending(p: PendingGen): Promise<void> {
  const tag = `[resume ${p.genId}]`;
  console.log(`${tag} re-attaching to task_id ${p.taskId.slice(0, 16)}… target=${p.sceneId ?? p.tileId ?? '?'}`);

  // Re-register the LiveGen so the UI sees the running state again.
  // Restore projectDir from the persisted record so the resumed
  // download still targets the project the gen was fired in, not
  // whatever the active project happens to be when the resume runs.
  const liveGen: LiveGen = {
    id: p.genId,
    tool: p.tool,
    model: p.model,
    prompt: p.prompt,
    status: 'running',
    startedAt: p.startedAt,
    sceneId: p.sceneId ?? undefined,
    tileId: p.tileId ?? undefined,
    projectDir: p.projectDir ?? paths.project,
  };
  liveGens.set(liveGen.id, liveGen);
  if (liveGen.model) genIdToModel.set(liveGen.id, liveGen.model);
  events.broadcast({ type: 'pika-live-gen', gen: liveGen });
  // Restore the bind target so finishLiveGen can label this gen's
  // event correctly after a restart-resume.
  recordGenTarget(liveGen.id, p.sceneId, p.tileId);

  // Build a minimal run/pollUntilDone pair — same as the main path.
  const run = async (toolName: string, toolArgs: Record<string, unknown>, timeoutMs: number = CALL_TIMEOUT_MS): Promise<CallToolResult> => {
    const c = await ensureConnected();
    // resetTimeoutOnProgress: every progress notification we receive
    // (Pika streams `notifications/message` while a gen runs) bumps
    // the SDK's per-request timer. Without this, the timer counts
    // down from the `timeout` value regardless of liveness — and a
    // slow Seedance r2v gen that's still progressing trips the
    // budget mid-generation, surfacing as opaque `MCP error -32001:
    // Request timed out` on the timeline clip.
    return await c.callTool({ name: toolName, arguments: toolArgs }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true }) as CallToolResult;
  };
  const pollUntilDone = async (taskId: string): Promise<CallToolResult> => {
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const status = await callWithReconnectRetry(
        () => run('task_status', { task_id: taskId }),
        `${tag} task_status`,
      );
      const parsed = tryParseTaskShape(status);
      if (!parsed) return status;
      if (isTerminalStatus(parsed.status)) return status;
    }
    throw new Error(`pika task ${taskId} did not finish within ${Math.round(POLL_TIMEOUT_MS/1000)}s`);
  };

  let result: CallToolResult;
  try {
    result = await pollUntilDone(p.taskId);
  } catch (err) {
    console.error(`${tag} polling failed:`, (err as Error)?.message ?? err);
    finishLiveGen(liveGen, true, undefined, String((err as Error)?.message ?? err));
    clearPending(p.taskId);
    return;
  }
  const out = formatResult(p.tool, result);
  const url = extractAssetUrl(result);
  console.log(`${tag} resumed result ${out.error ? 'ERROR' : 'OK'} · url=${url ?? 'none'}`);
  finishLiveGen(liveGen, !!out.error, url, out.error ? friendlyErrMsg(out.content) : undefined);
  clearPending(p.taskId);
  if (out.error || !url) return;
  try {
    if (p.sceneId) {
      await autoBindGenToScene(p.sceneId, url, p.genId, liveGen.projectDir);
    } else if (p.tileId) {
      await autoBindGenToTile(p.tileId, url, p.genId, p.localRel, liveGen.projectDir);
    }
  } catch (err: any) {
    console.warn(`${tag} auto-bind failed:`, err?.message ?? err);
  }
}

/** Force a fresh tool list — call after auth changes. */
export async function refreshTools(): Promise<MCPTool[]> {
  if (!isAuthenticated()) return [];
  disconnect();
  return listPikaTools();
}

export async function listPikaTools(): Promise<MCPTool[]> {
  if (!isAuthenticated()) return [];
  if (cachedTools.length > 0) return cachedTools;
  try {
    const c = await ensureConnected();
    const result = await c.listTools();
    cachedTools = result.tools;
    return cachedTools;
  } catch (err) {
    disconnect();
    throw err;
  }
}

/** Translate Pika MCP tool definitions to Anthropic tool format. The MCP
 *  Tool shape (name, description, inputSchema) maps cleanly to Anthropic's
 *  (name, description, input_schema). We prefix the name to avoid collisions
 *  with our native tools.
 *
 *  Sanitization: Anthropic rejects `oneOf` / `allOf` / `anyOf` at the top
 *  level of an input_schema. Some Pika MCP tools expose schemas with those
 *  constructs (e.g. union-shaped params) and the entire request 400s with
 *  "input_schema does not support oneOf/allOf/anyOf at the top level".
 *  We collapse by picking the first sub-schema — keeps the tool callable
 *  with one of its accepted shapes instead of dropping it entirely. */
function sanitizeForAnthropic(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const s = schema as Record<string, unknown>;
  // Top-level union: collapse to the first variant.
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(s[key]) && (s[key] as unknown[]).length > 0) {
      const first = (s[key] as unknown[])[0];
      return sanitizeForAnthropic(first);
    }
  }
  // Ensure object shape: Anthropic's tool input_schema must be type: 'object'.
  if (s.type !== 'object') {
    return { type: 'object', properties: s.properties ?? {}, ...(s.required ? { required: s.required } : {}) };
  }
  return s;
}
export async function getPikaToolDefs(): Promise<Anthropic.Tool[]> {
  const tools = await listPikaTools().catch(() => [] as MCPTool[]);
  return tools.map((t) => ({
    name: `${TOOL_PREFIX}${t.name}`,
    description: t.description ?? '',
    input_schema: sanitizeForAnthropic(t.inputSchema) as Anthropic.Tool['input_schema'],
  }));
}

export function isPikaTool(name: string): boolean {
  return name.startsWith(TOOL_PREFIX);
}

/** Execute a pika_-prefixed tool. Returns the textual content of the MCP
 *  tool result (joining all text blocks). Image / binary content blocks are
 *  surfaced as a short descriptor — Pika typically returns image and video
 *  URLs in text blocks, so the common path works.
 *
 *  Side effect: for generation tools (anything that produces an asset), we
 *  broadcast pika-live-gen SSE events on start + finish so the UI can show
 *  a live strip of what's cooking. */
export async function callPikaTool(prefixedName: string, input: unknown): Promise<{ content: string; error?: boolean; preview?: string }> {
  if (!isAuthenticated()) {
    return { content: 'Pika is not connected. The user needs to click "Connect Pika" in the chat panel.', error: true };
  }
  const name = prefixedName.startsWith(TOOL_PREFIX) ? prefixedName.slice(TOOL_PREFIX.length) : prefixedName;
  const rawArgs = (input ?? {}) as Record<string, unknown>;
  // Scripted auto-binding: the agent can pass `__sceneId` (or its alias
  // `_sceneId`) inside any gen tool's args to tell the server "when this
  // gen completes, download the result asset locally and PATCH this
  // scene to ready." Removes two manual agent steps per gen — without
  // it, the agent has to (a) bash-fetch the URL and (b) call patch_scene
  // itself, and either step can silently fail. The arg is stripped
  // before forwarding to the MCP server. Same for __tileTaskId — when
  // present we use that as the live-gen id so workspace tiles bind
  // deterministically without the agent having to parse [gen_id: …]
  // out of the tool result.
  const autoSceneId = typeof rawArgs.__sceneId === 'string' ? rawArgs.__sceneId
    : typeof rawArgs._sceneId === 'string' ? rawArgs._sceneId
    : null;
  // Workspace-tile bind: for IMAGE gens (refs, storyboards, hero
  // shots) the target isn't a timeline scene — it's a workspace.json
  // tile. The agent passes `__tileId` matching the tile's `id` field,
  // and optionally `__localRel` for an explicit save path (defaults
  // to `assets/refs/<tileId>.<ext>` when omitted). Same fire-and-
  // forget behavior as __sceneId: tool returns [queued] in <1s,
  // server downloads + writes the local src into the tile.
  const autoTileId = typeof rawArgs.__tileId === 'string' ? rawArgs.__tileId
    : typeof rawArgs._tileId === 'string' ? rawArgs._tileId
    : null;
  const autoLocalRel = typeof rawArgs.__localRel === 'string' ? rawArgs.__localRel : null;
  // Escape hatch: when the agent legitimately needs a throwaway gen
  // not tied to a workspace tile or timeline scene (e.g. analyze a
  // freshly-generated reference frame), it sets `__adHoc: true` to
  // bypass the auto-bind requirement below. Without this flag, gens
  // without a bind target are blocked — see the precondition further
  // down — to force fire-and-forget orchestration.
  const adHoc = rawArgs.__adHoc === true || rawArgs._adHoc === true;
  const args = { ...rawArgs };
  delete (args as Record<string, unknown>).__sceneId;
  delete (args as Record<string, unknown>)._sceneId;
  delete (args as Record<string, unknown>).__tileId;
  delete (args as Record<string, unknown>)._tileId;
  delete (args as Record<string, unknown>).__localRel;
  delete (args as Record<string, unknown>).__adHoc;
  delete (args as Record<string, unknown>)._adHoc;
  const isGen = isGenerationTool(name);

  // ENFORCE orchestration discipline: a gen tool call without a bind
  // target (and without the explicit __adHoc escape) is rejected.
  // This blocks the failure mode where the orchestrator stalls for
  // 60-120s on a batch because it forgot to pass __sceneId/__tileId.
  // The error is the agent's signal to retry with the right arg —
  // single missed turn, then back on the scripted rails.
  if (isGen && !autoSceneId && !autoTileId && !adHoc) {
    const isVideoTool = /^(generate_(video|reference_video|keyframes_video|motion_control_video|lipsync)|pika_scene|pika_swap|pika_effect|pika_addition|sora_edit|edit_animate_zoom)/.test(name);
    const isImageTool = /^(generate_image|generate_effect_video|extract_frame)/.test(name);
    const guidance = isVideoTool
      ? 'Pass `__sceneId: "<sceneId>"` to bind this gen to a pre-created scene (the server will auto-download + PATCH the scene to ready when it lands).'
      : isImageTool
        ? 'Pass `__tileId: "<the id of the workspace tile this fills>"` to bind this gen to a workspace tile (the server will auto-download + write src into the tile when it lands). Optionally pass `__localRel: "assets/refs/<path>.png"` for a custom save location.'
        : 'Pass `__sceneId` (for video → timeline scene) or `__tileId` (for image → workspace tile) to enable fire-and-forget orchestration.';
    return {
      content: `[blocked] ${name} requires a bind target so the orchestrator's turn ends in <1s instead of stalling on the gen. ${guidance} If this is genuinely a throwaway gen (e.g. analyzing a one-off frame), pass \`__adHoc: true\` to bypass.`,
      error: true,
    };
  }

  // EXISTENCE pre-check: when a bind target is supplied, verify it
  // actually exists in timeline.json / workspace.json BEFORE firing
  // the gen. Without this, the agent can ship a typo (e.g.
  // `__sceneId: "sc_47"` when the actual scene is `sc_48`) and the
  // server cheerfully fires the gen, the result lands on Pika's CDN,
  // auto-bind 404s, and the asset is orphaned forever with no UI
  // signal. Catching it at fire time is far cheaper — the agent gets
  // a clear "scene sc_47 doesn't exist" error and can retry within
  // one turn.
  if (isGen && (autoSceneId || autoTileId)) {
    const { existsOnDisk } = await validateBindTarget(autoSceneId, autoTileId);
    if (!existsOnDisk.scene && autoSceneId) {
      return {
        content: `[blocked] ${name} bound to __sceneId="${autoSceneId}" but no scene with that id exists in timeline.json. Either call create_scene first to register the scene, or check the spelling.`,
        error: true,
      };
    }
    if (!existsOnDisk.tile && autoTileId) {
      return {
        content: `[blocked] ${name} bound to __tileId="${autoTileId}" but no workspace tile with id="${autoTileId}" exists. Call write_workspace first with the tile in primary.items, or check the id.`,
        error: true,
      };
    }
  }

  // AUTO-UPLOAD LOCAL REFS. Before any URL preflight, walk all string /
  // array-of-string args; for each value that isn't a remote URL but
  // DOES resolve to a real file under the project, upload it to Pika's
  // CDN via upload_asset + presigned PUT and replace the arg in place
  // with the resulting public URL. This is the systemic fix for the
  // recurring failure mode where the agent passes
  // `reference_images: ["assets/refs/auto/screen-02.png"]` and Pika
  // rejects the call with `[invalid_input] Error resolving media for
  // reference_images` because Pika has no way to read our local disk.
  // Server-enforced — no agent discretion, no "upload first, then
  // gen" two-step that the agent forgets half the time.
  if (isGen) {
    const upErrors = await autoUploadLocalRefs(args);
    if (upErrors.length > 0) {
      const lines = upErrors.map((b) => `  • ${b.field}: ${b.message} (${b.localPath})`).join('\n');
      return {
        content: [
          `[upload-failed] Could not auto-upload one or more local ref files to Pika's CDN. The gen was NOT fired:`,
          lines,
          ``,
          `These local paths exist on disk but the upload step failed (size, permissions, or Pika upload_asset returned an error). Verify the files and retry.`,
        ].join('\n'),
        error: true,
      };
    }
  }

  // URL preflight. Any string arg (or array-of-string arg) that looks
  // like an http(s) URL gets a HEAD probe before we forward to Pika.
  // Catches the common "agent reused a stale CDN URL" failure mode —
  // e.g. `reference_images: ["...holly.png"]` where holly.png has
  // expired from Pika's CDN. Without this, Pika rejects the call with
  // a generic 4xx and the agent has to guess which URL is bad. The
  // preflight names the failing URL directly so the agent can re-
  // upload exactly that asset.
  //
  // Parallelized + 5s timeout so adding ~6 ref images doesn't slow the
  // gen call meaningfully. Validation passes silently if every URL is
  // reachable.
  if (isGen) {
    const badUrls = await preflightUrlArgs(args);
    if (badUrls.length > 0) {
      const lines = badUrls.map((b) => `  • ${b.field}: HTTP ${b.status} for ${b.url}`).join('\n');
      return {
        content: [
          `[preflight-failed] One or more reference URLs are not fetchable. Re-upload these assets and retry:`,
          lines,
          ``,
          `These URLs likely expired from Pika's CDN (uploads aren't permanent). Call \`pika_upload_asset\` with the local file again to get a fresh URL, then re-fire ${name} with the new URL in place of the dead one.`,
        ].join('\n'),
        error: true,
      };
    }
  }

  // Broadcast "started" — create BOTH a LiveGen (legacy in-memory map)
  // AND a GenJob (canonical durable lifecycle record). The GenJob is
  // the source of truth; LiveGen stays in parallel for backwards-
  // compatible UI paths that still subscribe to `pika-live-gen` SSE.
  let liveGen: LiveGen | undefined;
  let genJob: GenJob | undefined;
  if (isGen) {
    // `model` is the canonical field on the gen tools (generate_video,
    // generate_reference_video, etc.). `provider` is the equivalent on
    // generate_image. Accept either so the duration-estimate lookup
    // can find a meaningful key (gpt-image-2, seedance, kling, …)
    // instead of falling back to the generic 60s/90s default.
    const modelOrProvider =
      typeof args.model === 'string' ? args.model
      : typeof args.provider === 'string' ? args.provider
      : undefined;
    liveGen = {
      id: `gen_${++nextGenId}_${Date.now().toString(36)}`,
      tool: name,
      model: modelOrProvider,
      prompt: typeof args.prompt === 'string' ? String(args.prompt).slice(0, 120) : undefined,
      status: 'running',
      startedAt: Date.now(),
      // Anchor this gen to the project it was fired in. The background
      // runner uses this for every downstream write so a project
      // switch mid-flight can't misroute the asset.
      projectDir: paths.project,
    };
    liveGens.set(liveGen.id, liveGen);
    if (liveGen.model) genIdToModel.set(liveGen.id, liveGen.model);
    events.broadcast({ type: 'pika-live-gen', gen: liveGen });

    // GenJob: durable, replayable, owns the lifecycle. Bind is derived
    // from whichever hint the agent passed; ad-hoc image gens with a
    // __localRel become 'ref' jobs, everything else is scene/tile.
    const bind: GenJobBind = autoSceneId
      ? { kind: 'scene', sceneId: autoSceneId }
      : autoTileId
        ? { kind: 'tile', tileId: autoTileId, localRel: autoLocalRel ?? undefined }
        : { kind: 'ref',  localRel: autoLocalRel ?? `assets/refs/auto/${liveGen.id}.png` };
    try {
      genJob = createGenJob({
        id: newGenJobId(),
        bind,
        tool: name,
        args: { ...args },
        model: modelOrProvider,
        prompt: liveGen.prompt,
      });
      // Stash the GenJob id on the LiveGen so the rest of the pipeline
      // (progress notifications, completion, finishLiveGen) can find it.
      (liveGen as LiveGen & { jobId?: string }).jobId = genJob.id;
    } catch (err) {
      // Never block the gen on a GenJob bookkeeping failure. The legacy
      // LiveGen pipeline still works.
      console.warn(`[pika-mcp] createGenJob failed (non-fatal):`, (err as Error)?.message ?? err);
    }
  }

  const run = async (toolName: string, toolArgs: Record<string, unknown>, timeoutMs: number = CALL_TIMEOUT_MS): Promise<CallToolResult> => {
    const c = await ensureConnected();
    // resetTimeoutOnProgress: every progress notification we receive
    // (Pika streams `notifications/message` while a gen runs) bumps
    // the SDK's per-request timer. Without this, the timer counts
    // down from the `timeout` value regardless of liveness — and a
    // slow Seedance r2v gen that's still progressing trips the
    // budget mid-generation, surfacing as opaque `MCP error -32001:
    // Request timed out` on the timeline clip.
    return await c.callTool({ name: toolName, arguments: toolArgs }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true }) as CallToolResult;
  };

  // Pika's task-status pattern: if the original tool's server-side budget
  // (~260s) expires before generation completes, it returns {task_id, status}.
  // We auto-poll until terminal so the agent never sees a half-finished
  // response. Each task_status call blocks server-side up to ~20s — no sleep.
  const pollUntilDone = async (taskId: string): Promise<CallToolResult> => {
    const start = Date.now();
    let tick = 0;
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const status = await callWithReconnectRetry(
        () => run('task_status', { task_id: taskId }),
        `poll task_status`,
      );
      const parsed = tryParseTaskShape(status);
      tick += 1;
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      if (!parsed) {
        console.log(`[pika-mcp] poll tick ${tick} (${elapsedSec}s elapsed) — no envelope, treating as terminal`);
        return status;
      }
      console.log(`[pika-mcp] poll tick ${tick} (${elapsedSec}s elapsed) — status: ${parsed.status ?? '(none)'}`);
      if (isTerminalStatus(parsed.status)) return status;
    }
    throw new Error(`pika task ${taskId} did not finish within ${Math.round(POLL_TIMEOUT_MS/1000)}s`);
  };

  // Tier 1 fire-and-forget. Two bind targets, same semantics:
  //   - __sceneId → bind result to a timeline scene (video gens)
  //   - __tileId  → bind result to a workspace.json tile (image gens)
  // Either way the tool returns [queued] in <1s and the agent's
  // turn can end fast. The server owns the rest of the pipeline
  // (download + scene PATCH or tile update + SSE).
  if ((autoSceneId || autoTileId) && liveGen) {
    const target = autoSceneId ? `scene: ${autoSceneId}` : `tile: ${autoTileId}`;
    console.log(`[pika-mcp] [fire-and-forget] ${name} · ${liveGen.id} · ${target}`);

    // Remember which scene/tile this gen is bound to. finishLiveGen
    // looks this up when emitting the agent-facing gen event so the
    // event has a friendly label instead of an opaque gen id.
    recordGenTarget(liveGen.id, autoSceneId, autoTileId);
    // Also stash on the LiveGen itself so the client can show progress
    // on the matching timeline V1 clip / workspace tile without doing
    // its own lookup table. Broadcast already includes this object.
    if (autoSceneId) liveGen.sceneId = autoSceneId;
    if (autoTileId) liveGen.tileId = autoTileId;
    events.broadcast({ type: 'pika-live-gen', gen: liveGen });

    // CLAIM A WORKSPACE TILE AT FIRE TIME.
    //
    // The agent writes a workspace tile BEFORE firing the gen (so the
    // user sees "generating…" right away). At that point the agent
    // doesn't know the gen_id yet, and the tile's `id` field is a
    // free-form string they pick — frequently *mismatched* with the
    // scene id the server allocates (e.g. tile.id="sc_51_tile" but
    // create_scene returns sceneId="sc_52"). When that happens, the
    // auto-bind on completion can't find the tile and it stays stuck
    // on "generating" forever.
    //
    // Fix: at FIRE time, the server walks `workspace.primary.items` and
    // claims the first pending unbound tile by writing the sceneId AND
    // taskId onto it. After this, auto-bind on completion can find the
    // tile by either key. The agent doesn't need to coordinate ids.
    //
    // For __tileId: prefer EXACT id match first; fall back to first
    // unbound pending tile.
    void claimWorkspaceTile(liveGen.id, autoSceneId, autoTileId)
      .catch((err: unknown) => console.warn(`[pika-mcp] tile claim failed (non-fatal):`, (err as Error)?.message ?? err));

    // PATCH the timeline scene to `status: 'generating'` at fire time
    // so the V1 clip's in-flight state lives in persisted timeline.json
    // (not just the volatile LiveGen / SSE). Survives server restarts
    // and page refreshes. Non-blocking; if the PATCH itself fails the
    // gen still proceeds and the reconciler will catch up later.
    if (autoSceneId) {
      void withRetry(() => patchSceneGenerating(autoSceneId))
        .catch((e) => console.warn(`[pika-mcp] PATCH ${autoSceneId} → generating failed:`, (e as Error)?.message ?? e));
    }

    void runGenInBackground(name, args, liveGen, { sceneId: autoSceneId, tileId: autoTileId, localRel: autoLocalRel }, run, pollUntilDone)
      .catch((err: unknown) => {
        console.error(`[pika-mcp] runGenInBackground threw:`, err);
        // Even if the background runner itself dies with an unhandled
        // throw (bug, OOM, etc.), surface a failure on the bound scene
        // / tile so the UI doesn't sit on "Generating…" forever.
        void markBindFailure(
          { sceneId: autoSceneId, tileId: autoTileId },
          liveGen!.id,
          `background runner crashed: ${(err as Error)?.message ?? err}`,
          liveGen!.projectDir,
        );
      });
    return {
      content: [
        `[QUEUED — gen is actively running on Pika] gen_id: ${liveGen.id} · ${target}`,
        ``,
        `THE GEN IS FIRING RIGHT NOW. The server will:`,
        `  1. Run ${name} on Pika MCP in the background`,
        `  2. Poll task_status if needed (up to 15min)`,
        `  3. Download the result to the project's assets/`,
        `  4. PATCH the ${autoSceneId ? 'scene to ready+videoSrc' : 'workspace tile with the local src'}`,
        ``,
        `DO NOT call task_status, curl, or any other check tool. DO NOT retry this gen.`,
        `DO NOT use pika_task_status to poll — the server already polls and binds for you.`,
        ``,
        `Your job: END THIS TURN with a one-liner like "spawned ${target.split(': ')[1]}, watch the workspace/timeline" so the user knows what's running.`,
        `The user will see real-time progress via the pika-live-gen SSE → workspace tile spinner / timeline V1 clip state.`,
      ].join('\n'),
    };
  }

  // Legacy / non-scene-bound path — agent awaits the result inline.
  // GenJob lifecycle hook: this path is taken for __adHoc gens and for
  // tool calls that didn't satisfy the fire-and-forget bind targets.
  // Each transition catches its own error so bookkeeping never blocks
  // the gen flow.
  const inlineJobId = (liveGen as (LiveGen & { jobId?: string }) | undefined)?.jobId;
  const inlineTransition = (to: Parameters<typeof recordTransition>[1], patch?: Partial<GenJob>): void => {
    if (!inlineJobId) return;
    try { recordTransition(inlineJobId, to, patch ? { patch } : undefined); }
    catch (e) { console.warn(`[pika-mcp] inline GenJob ${to} failed:`, (e as Error)?.message ?? e); }
  };
  inlineTransition('firing');
  let result: CallToolResult;
  try {
    result = await callWithReconnectRetry(() => run(name, args), `inline ${name}`);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (liveGen) finishLiveGen(liveGen, true, undefined, msg);
    inlineTransition('error', { errorMessage: msg });
    return formatError(err);
  }

  // If Pika returned a task_id envelope (budget expired on its end), auto-poll.
  const taskShape = tryParseTaskShape(result);
  if (taskShape?.task_id && !isTerminalStatus(taskShape.status)) {
    inlineTransition('running', { pikaTaskId: taskShape.task_id });
    try {
      result = await pollUntilDone(taskShape.task_id);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (liveGen) finishLiveGen(liveGen, true, undefined, msg);
      inlineTransition('error', { errorMessage: msg, pikaTaskId: taskShape.task_id });
      return formatError(err);
    }
  }

  const out = formatResult(name, result);
  if (liveGen) {
    // Pull a result URL preview if Pika returned one
    const url = extractAssetUrl(result);
    finishLiveGen(liveGen, !!out.error, url, undefined);
    if (out.error) {
      inlineTransition('error', { errorMessage: friendlyErrMsg(out.content), remoteUrl: url });
    } else if (url) {
      inlineTransition('downloading', { remoteUrl: url });
    }

    // ENFORCED LOCAL-SAVE FOR AD-HOC GENS.
    //
    // The pae-agent skill instructs the agent to keep character / location
    // / storyboard refs at known local paths (assets/refs/cast/, /locations/,
    // /storyboard/). Previously this only happened when __sceneId or
    // __tileId was set — the legacy ad-hoc path returned a CDN URL with
    // no local copy, so the agent (and downstream gens) ended up citing
    // expirable CDN links. Some agent turns set __localRel explicitly,
    // others didn't, which left ref persistence to "agent discretion."
    //
    // New rule: any ad-hoc image-style gen with a fetchable URL is
    // ALWAYS saved locally. __localRel is honored if provided, else we
    // pick a deterministic fallback (`assets/refs/auto/<genId>.<ext>`).
    // The tool result advertises the LOCAL path so the agent cites that
    // in future calls instead of the dying CDN URL.
    const looksLikeImage = url && /\.(png|jpe?g|webp|gif|bmp|tiff)\b/i.test(url);
    if (url && !out.error && looksLikeImage) {
      try {
        const fsMod = await import('node:fs');
        const { promises: fsp } = fsMod;
        const pathMod = await import('node:path');
        const m = url.match(/\.(png|jpe?g|webp|gif|bmp|tiff)\b/i);
        const ext = (m?.[1] ?? 'png').toLowerCase();
        const relPath = autoLocalRel ?? `assets/refs/auto/${liveGen.id}.${ext}`;
        // Anchor the save to the project the gen was fired in. The
        // inline path is awaited by the agent, but the user may still
        // switch projects mid-await on slow models — same anchoring
        // rule as the background bg-runner path. We keep the sandbox
        // containment check (no traversal, no absolute paths) but
        // apply it against the captured projectDir, since
        // resolveSafe/safeProjectAbs are bound to the ACTIVE project
        // and can't validate against an arbitrary root.
        const targetProject = liveGen.projectDir ?? paths.project;
        const normRel = pathMod.normalize(relPath);
        if (pathMod.isAbsolute(normRel) || normRel.startsWith('..')) {
          throw new Error(`refusing to write outside the project sandbox: ${relPath}`);
        }
        const absPath = pathMod.join(targetProject, normRel);
        await fsp.mkdir(pathMod.dirname(absPath), { recursive: true });
        console.log(`[pika-mcp] ad-hoc download ${url} → ${relPath}${autoLocalRel ? '' : ' (auto path)'}`);
        assertSafeAssetUrl(url);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await fsp.writeFile(absPath, buf);
        out.content = `${out.content}\n\n[saved locally: ${relPath} — cite this path in downstream gens, NOT the CDN url above (CDN urls expire)]`;
        inlineTransition('ready', { localPath: relPath });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        console.warn(`[pika-mcp] ad-hoc download failed:`, msg);
        const target = autoLocalRel ?? 'assets/refs/auto/';
        out.content = `${out.content}\n\n[warning: could not save to ${target} — ${msg}]`;
        inlineTransition('error', { errorMessage: `download failed: ${msg}` });
      }
    } else if (url && !out.error) {
      // Ad-hoc gen that wasn't an image (audio, etc.) — no download path,
      // but the gen itself succeeded. Mark ready.
      inlineTransition('ready', { remoteUrl: url });
    }

    out.content = `${out.content}\n\n[gen_id: ${liveGen.id}]`;
  }
  return out;
}

/**
 * Tier 1 background runner. Spawns the gen, polls if needed, finishes
 * the LiveGen (broadcasts SSE), then hands off to autoBindGenToScene.
 * Mirrors the inline pipeline above 1:1, but runs asynchronously so
 * the agent's tool call can return `[queued]` immediately and end its
 * turn. The user sees every step through the existing SSE channels
 * (pika-live-gen running → done, timeline-changed, asset-added).
 */
interface AutoBindTarget {
  sceneId: string | null;
  tileId: string | null;
  localRel: string | null;
}

async function runGenInBackground(
  name: string,
  args: Record<string, unknown>,
  liveGen: LiveGen,
  target: AutoBindTarget,
  run: (n: string, a: Record<string, unknown>, t?: number) => Promise<CallToolResult>,
  pollUntilDone: (taskId: string) => Promise<CallToolResult>,
): Promise<void> {
  const tag = `[bg ${liveGen.id}]`;
  console.log(`${tag} entered runGenInBackground — about to call ${name}`);
  // Resolve companion GenJob (Phase 1). Each transition catches its own
  // error — GenJob bookkeeping must never crash the gen loop.
  const jobId = (liveGen as LiveGen & { jobId?: string }).jobId;
  const transition = (to: Parameters<typeof recordTransition>[1], patch?: Partial<GenJob>): void => {
    if (!jobId) return;
    try { recordTransition(jobId, to, patch ? { patch } : undefined); }
    catch (e) { console.warn(`${tag} GenJob transition ${to} failed:`, (e as Error)?.message ?? e); }
  };
  transition('firing');
  let result: CallToolResult;
  let pikaTaskId: string | null = null;
  try {
    result = await callWithReconnectRetry(() => run(name, args), `${tag} ${name}`);
    console.log(`${tag} ${name} returned`);
    const taskShape = tryParseTaskShape(result);
    if (taskShape?.task_id && !isTerminalStatus(taskShape.status)) {
      pikaTaskId = taskShape.task_id;
      // Persist NOW — before we start polling. If the server dies during
      // the poll loop, boot-time resume picks this up and continues.
      // Without this, a restart loses the task_id and the gen is
      // unrecoverable on our end (Pika still finishes, but we never
      // download the asset).
      recordPending({
        taskId: taskShape.task_id,
        genId: liveGen.id,
        tool: name,
        sceneId: target.sceneId,
        tileId: target.tileId,
        localRel: target.localRel,
        model: liveGen.model,
        startedAt: liveGen.startedAt,
        prompt: liveGen.prompt,
        // Anchor this pending record to the project the gen was fired
        // in. On boot, resumeOnePending will route the download here
        // even if the active project has changed.
        projectDir: liveGen.projectDir,
      });
      transition('running', { pikaTaskId: taskShape.task_id });
      console.log(`${tag} persisted task_id ${taskShape.task_id} for resume-on-restart`);
      console.log(`${tag} polling for completion (up to ${Math.round(POLL_TIMEOUT_MS/60_000)}min)`);
      result = await pollUntilDone(taskShape.task_id);
      console.log(`${tag} polling done`);
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    console.error(`${tag} ${name} FAILED:`, msg);
    if (pikaTaskId) clearPending(pikaTaskId);
    finishLiveGen(liveGen, true, undefined, msg);
    transition('error', { errorMessage: msg });
    await markBindFailure(target, liveGen.id, msg, liveGen.projectDir);
    return;
  }
  // Reach here only on terminal status (success or Pika-side error).
  if (pikaTaskId) clearPending(pikaTaskId);
  const out = formatResult(name, result);
  const url = extractAssetUrl(result);
  console.log(`${tag} result ${out.error ? 'ERROR' : 'OK'} · url=${url ?? 'none'}`);
  finishLiveGen(liveGen, !!out.error, url, out.error ? friendlyErrMsg(out.content) : undefined);
  if (out.error || !url) {
    const dump = out.content.length > 4000 ? out.content.slice(0, 4000) + '…[truncated]' : out.content;
    console.warn(`${tag} no URL to bind — FULL CONTENT (${out.content.length} chars):\n${dump}\n[end content]`);
    const errMsg = out.error
      ? friendlyErrMsg(out.content)
      : `gen returned no asset URL (response: ${out.content.slice(0, 80)})`;
    transition('error', { errorMessage: errMsg, remoteUrl: url ?? undefined });
    await markBindFailure(target, liveGen.id, errMsg, liveGen.projectDir);
    return;
  }

  // Auto-bind: download asset + update scene/tile + workspace.
  // If this throws (CDN 404, disk full, perm denied, PATCH 5xx, etc.),
  // mark BOTH bound targets as failed with the actual error message —
  // no more silently swallowed download failures that leave a tile
  // saying "Generating…" forever while the gen has actually finished
  // and the asset URL is sitting unbound on Pika's CDN.
  transition('downloading', { remoteUrl: url });
  try {
    if (target.sceneId) {
      // Pass the gen's captured projectDir so the download lands in
      // the project the gen was fired in, not the currently-active
      // one. If the user switched projects mid-flight, this is the
      // ONLY guarantee that the asset doesn't leak.
      await autoBindGenToScene(target.sceneId, url, liveGen.id, liveGen.projectDir);
      transition('ready', { localPath: `assets/pika/${target.sceneId}` });
    } else if (target.tileId) {
      await autoBindGenToTile(target.tileId, url, liveGen.id, target.localRel, liveGen.projectDir);
      transition('ready', { localPath: target.localRel ?? undefined });
    } else {
      transition('ready');
    }
  } catch (err: any) {
    const label = target.sceneId ?? target.tileId ?? '?';
    const msg = `auto-bind to ${label} failed: ${err?.message ?? err}`;
    console.warn(`${tag} ${msg}`);
    finishLiveGen(liveGen, true, url, msg);
    transition('error', { errorMessage: msg, remoteUrl: url });
    await markBindFailure(target, liveGen.id, msg, liveGen.projectDir);
  }
}

/**
 * Claim a workspace tile for an in-flight gen so the auto-bind on completion
 * can find it. Called at FIRE time from the fire-and-forget branch.
 *
 * Matching priority:
 *   1. (Image gens) Exact `id === tileId` match — the agent wrote the tile
 *      with this id and explicitly told the server about it.
 *   2. (Video gens) Exact `sceneId === sceneId` match — agent set sceneId
 *      on the tile.
 *   3. Fallback: first tile with `pending: true`, no `src`, no `sceneId`,
 *      no `taskId`. The agent wrote a placeholder; we claim it. This is
 *      what saves us when the agent's tile.id doesn't match the scene id.
 *
 * On match, we set `sceneId` (for video) or keep `id` (for image) AND set
 * `taskId` to the live gen id. Auto-bind on completion matches by either.
 *
 * Non-fatal: if no tile matches, we just log and continue. The gen still
 * runs, the scene/asset still lands; only the workspace tile won't auto-
 * update (which is the pre-claim baseline).
 */
async function claimWorkspaceTile(
  genId: string,
  sceneId: string | null,
  tileId: string | null,
): Promise<void> {
  const { mutateWorkspace } = await import('../state.js');
  await mutateWorkspace((cur: any) => {
    const items = cur?.primary?.items as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(items) || items.length === 0) {
      return { next: cur, result: undefined };
    }
    const isUnboundPending = (it: Record<string, unknown>): boolean =>
      it.pending === true
      && !it.src
      && !it.sceneId
      && !it.taskId;

    let claimedIdx = -1;
    // Priority 1: exact id match (image gen w/ tileId).
    if (tileId) {
      claimedIdx = items.findIndex((it) => it && it.id === tileId);
    }
    // Priority 2: exact sceneId match (video gen).
    if (claimedIdx < 0 && sceneId) {
      claimedIdx = items.findIndex((it) => it && it.sceneId === sceneId);
    }
    // Priority 3: first unbound pending tile.
    if (claimedIdx < 0) {
      claimedIdx = items.findIndex((it) => it && isUnboundPending(it));
    }
    if (claimedIdx < 0) {
      console.log(`[pika-mcp] claim: no matching tile for gen=${genId} sceneId=${sceneId ?? '-'} tileId=${tileId ?? '-'}`);
      return { next: cur, result: undefined };
    }
    const nextItems = items.map((it, i) => {
      if (i !== claimedIdx) return it;
      const updated: Record<string, unknown> = { ...it, taskId: genId };
      if (sceneId && !updated.sceneId) updated.sceneId = sceneId;
      // Re-claiming a previously-failed tile must clear `failed` +
      // `errorMessage` so the UI flips out of the red "Generation
      // Failed" state and shows the spinner again. Without this, the
      // user sees the failed card persist for the full 30-60s retry
      // window and reads it as "the retry isn't happening." Mirror
      // of the clearing in toolProduceWorkspaceImage.
      delete updated.failed;
      delete updated.errorMessage;
      return updated;
    });
    console.log(`[pika-mcp] claim: tile[${claimedIdx}] ← gen=${genId} sceneId=${sceneId ?? '-'} tileId=${tileId ?? '-'}`);
    return {
      next: { ...cur, primary: { ...cur.primary, items: nextItems } },
      result: undefined,
    };
  });
}

/** Workspace-tile auto-bind. Mirrors autoBindGenToScene but the
 *  target is a workspace.json tile (matched by `id`) instead of a
 *  timeline scene. Used for image gens — character refs, storyboard
 *  frames, hero shots — anything that lands as a tile in the
 *  Workspace view but doesn't have a corresponding timeline scene.
 *
 *  Download path defaults to `assets/refs/<tileId>.<ext>`; the agent
 *  can override via `__localRel` for tile sets that live elsewhere
 *  (e.g. `assets/refs/storyboard/sb_03.png`). */
async function autoBindGenToTile(tileId: string, url: string, genId: string, localRel: string | null, projectDir?: string): Promise<void> {
  const fsMod = await import('node:fs');
  const { promises: fsp } = fsMod;
  const path = await import('node:path');
  const { mutateWorkspace } = await import('../state.js');

  // Anchor the download to the project this gen was fired in. The
  // caller passes `projectDir` snapshotted from the LiveGen at fire
  // time; if the user has switched projects since, the asset still
  // lands in the ORIGINAL project's assets/ — no leak. Falls back to
  // the current project for older code paths that haven't been
  // threaded yet.
  const targetProject = projectDir ?? paths.project;
  const m = url.match(/\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav)\b/i);
  const ext = (m?.[1] ?? 'png').toLowerCase();
  const relPath = localRel ?? `assets/refs/${tileId}.${ext}`;
  // Sandbox containment + project anchoring. We can't reuse
  // safeProjectAbs here because it's bound to the active project,
  // and we want to land the asset in the gen's CAPTURED project
  // even if the user has switched. Inline the same guard against
  // traversal / absolute paths instead.
  const normRel = path.normalize(relPath);
  if (path.isAbsolute(normRel) || normRel.startsWith('..')) {
    throw new Error(`refusing to write outside the project sandbox: ${relPath}`);
  }
  const absPath = path.join(targetProject, normRel);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });

  console.log(`[pika-mcp] auto-bind tile ${tileId} ← ${url} → ${relPath} (project: ${path.basename(targetProject)})`);
  assertSafeAssetUrl(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(absPath, buf);

  // Workspace mutation is bound to whichever project is ACTIVE. If
  // the user has switched away from the gen's project, the actor
  // would write the tile update into the wrong workspace.json. Skip
  // the actor write in that case — the asset is safely on disk; the
  // scan-on-init pass picks it up when they switch back.
  if (targetProject !== paths.project) {
    console.warn(`[pika-mcp] tile ${tileId} bind skipped workspace write: gen was fired in ${path.basename(targetProject)} but user is now in ${path.basename(paths.project)}. Asset saved at ${relPath} in original project.`);
    return;
  }

  // Update the workspace tile through the actor (race-safe). The actor's
  // mutate fn re-reads the latest workspace inside the lock, so parallel
  // auto-binds for different tiles can't lose each other's updates.
  await mutateWorkspace((cur: any) => {
    const items = cur?.primary?.items as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(items)) return { next: cur, result: undefined };
    let touched = false;
    const nextItems = items.map((it) => {
      if (it && typeof it === 'object' && (it.id === tileId || it.taskId === genId)) {
        touched = true;
        const updated = { ...it, src: relPath };
        delete (updated as any).pending;
        return updated;
      }
      return it;
    });
    if (!touched) return { next: cur, result: undefined };
    const next = { ...cur, primary: { ...cur.primary, items: nextItems } };
    console.log(`[pika-mcp] auto-bind tile ${tileId} ✓`);
    return { next, result: undefined };
  });
}

/** Download `url` to `assets/pika/<sceneId>.<ext>` and PATCH the scene
 *  to ready+videoSrc. Runs in the background after the gen tool returns;
 *  the agent does NOT have to await this. Errors are logged but don't
 *  propagate — the scene stays pending so the user can retry. */
async function autoBindGenToScene(sceneId: string, url: string, genId: string, projectDir?: string): Promise<void> {
  // Lazy-import to avoid pulling in fs/path into the MCP module's hot
  // path when no __sceneId is set.
  const fsMod = await import('node:fs');
  const { promises: fsp } = fsMod;
  const path = await import('node:path');

  // Anchor the download path to the project the gen was fired in. If
  // the user has switched projects since, the .mp4 still lands in the
  // ORIGINAL project's assets/pika/ instead of polluting the new
  // project's directory.
  const targetProject = projectDir ?? paths.project;
  const m = url.match(/\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav)\b/i);
  const ext = (m?.[1] ?? 'mp4').toLowerCase();
  const relPath = `assets/pika/${sceneId}.${ext}`;
  // Same sandbox guard as autoBindGenToTile — applied against the
  // captured project root, not the active one.
  const normRel = path.normalize(relPath);
  if (path.isAbsolute(normRel) || normRel.startsWith('..')) {
    throw new Error(`refusing to write outside the project sandbox: ${relPath}`);
  }
  const absPath = path.join(targetProject, normRel);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });

  console.log(`[pika-mcp] auto-bind ${sceneId} ← ${url} → ${relPath} (project: ${path.basename(targetProject)})`);
  assertSafeAssetUrl(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(absPath, buf);

  // The scene PATCH and audio-extract/scene-cut hooks live behind the
  // /scenes/:id HTTP route, which operates on the ACTIVE project's
  // timeline.json. If the user has switched projects since fire time,
  // we MUST skip the PATCH — sending it would either 404 (best case,
  // wasted attempt) or worse, mutate the wrong project's timeline.
  // The video file is safely on disk in the right project. When the
  // user switches back, the scan-on-init reconciler will detect
  // `assets/pika/<sceneId>.<ext>` next to a pending scene and bind
  // it automatically.
  if (targetProject !== paths.project) {
    console.warn(`[pika-mcp] scene ${sceneId} bind: skipped PATCH because gen was fired in ${path.basename(targetProject)} but user is now in ${path.basename(paths.project)}. Asset saved at ${relPath} in original project; will reconcile on switch-back.`);
    return;
  }

  // PATCH the scene through the existing HTTP route so the audio-extract
  // + scene-cut detection hooks fire. The PATCH handler is now actor-
  // serialized, so parallel auto-binds for different scenes can't lose
  // each other's updates.
  //
  // Bug fix: the original regex `/\.(mp4|mov|webm)$/i.test(ext)` REQUIRED
  // a leading dot but `ext` here is just the bare extension ("mp4"). The
  // test ALWAYS returned false, so videoSrc was never sent. The scene
  // flipped to ready with no videoSrc and the mp4 was orphaned on disk.
  // This was the exact source of "sc_47/49/50 have status=ready but
  // videoSrc=null" from the May 20 incident.
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  const isVideo = ['mp4', 'mov', 'webm'].includes(ext);
  const patchBody: Record<string, unknown> = { status: 'ready' };
  if (isVideo) patchBody.videoSrc = relPath;
  const patchRes = await fetch(`http://127.0.0.1:${port}/scenes/${encodeURIComponent(sceneId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patchBody),
  });
  if (!patchRes.ok) {
    const detail = await patchRes.text().catch(() => '');
    throw new Error(`PATCH /scenes/${sceneId} → ${patchRes.status}: ${detail.slice(0, 200)}`);
  }

  // Finalize the workspace tile for this gen through the actor. Match by
  // sceneId (the new key, agent-writable up front) OR by taskId (legacy,
  // when the agent has plumbed the gen id back into the tile). Doing it
  // through the actor means parallel auto-binds queue cleanly.
  try {
    await mutateWorkspace((cur: any) => {
      const items = cur?.primary?.items as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(items)) return { next: cur, result: undefined };
      let touched = false;
      const nextItems = items.map((it) => {
        if (it && typeof it === 'object' && (it.sceneId === sceneId || it.taskId === genId)) {
          touched = true;
          const updated = { ...it, src: relPath };
          delete (updated as any).pending;
          return updated;
        }
        return it;
      });
      if (!touched) return { next: cur, result: undefined };
      const next = { ...cur, primary: { ...cur.primary, items: nextItems } };
      console.log(`[pika-mcp] auto-bind ${sceneId} workspace tile updated ✓`);
      return { next, result: undefined };
    });
  } catch (err: any) {
    console.warn(`[pika-mcp] workspace tile update failed for ${sceneId}:`, err?.message ?? err);
  }

  console.log(`[pika-mcp] auto-bind ${sceneId} ready ✓`);
}

/** Verify that the bind targets the agent supplied actually exist on
 *  disk before we fire the gen. Reads both timeline.json (for scene)
 *  and workspace.json (for tile) in parallel via the actor — cheap
 *  (<10ms typical), race-safe. Missing files (or empty arrays) report
 *  the target as not-found. */
async function validateBindTarget(
  sceneId: string | null,
  tileId: string | null,
): Promise<{ existsOnDisk: { scene: boolean; tile: boolean } }> {
  const { paths } = await import('../state.js');
  const { existsSync, readFileSync } = await import('node:fs');
  const path = await import('node:path');

  const out = { existsOnDisk: { scene: !sceneId, tile: !tileId } };

  if (sceneId) {
    try {
      const file = path.join(paths.project, 'timeline.json');
      if (existsSync(file)) {
        const tl = JSON.parse(readFileSync(file, 'utf8'));
        const scenes = Array.isArray(tl?.scenes) ? tl.scenes : [];
        out.existsOnDisk.scene = scenes.some((s: any) => s?.id === sceneId);
      }
    } catch { /* treat as not-found */ }
  }
  if (tileId) {
    try {
      const file = path.join(paths.project, 'workspace.json');
      if (existsSync(file)) {
        const ws = JSON.parse(readFileSync(file, 'utf8'));
        const items = Array.isArray(ws?.primary?.items) ? ws.primary.items : [];
        out.existsOnDisk.tile = items.some((it: any) => it?.id === tileId);
      }
    } catch { /* treat as not-found */ }
  }
  return out;
}

/** Retry an async operation up to N times with a fixed backoff. Use for
 *  best-effort bookkeeping (scene/tile PATCH on failure) where we'd
 *  rather try a few times than silently lose error state. Throws the
 *  last attempt's error if every retry fails — callers decide whether
 *  to propagate or accept eventual-consistency. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, backoffMs = 1000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

/** Mark a gen as failed across BOTH the timeline scene and the workspace
 *  tile so the UI surfaces the same error on every surface. Either side
 *  retries up to 3× before giving up — and even if one side gives up,
 *  the other still gets marked. Used by every auto-bind failure / poll
 *  timeout / disk-write error path in `runGenInBackground`. Replaces
 *  the old pattern of `.catch(() => /* best-effort *​/)` which left
 *  scenes stuck in `pending` and tiles stuck in `pending: true` after
 *  any error in the bind step. */
async function markBindFailure(
  target: { sceneId: string | null; tileId: string | null },
  genId: string,
  errMsg: string,
  projectDir?: string,
): Promise<void> {
  // If the gen was fired in a project the user has since left, the
  // scene PATCH (HTTP) and tile mutate (actor) would both operate on
  // the WRONG project — they're bound to the currently-active
  // project. Skip the writes in that case; the gen-jobs.jsonl entry
  // is already correct, and the reconciler-on-init pass picks up the
  // failed state when the user switches back.
  if (projectDir && projectDir !== paths.project) {
    const path = await import('node:path');
    console.warn(`[pika-mcp] markBindFailure skipped for gen ${genId}: fired in ${path.basename(projectDir)} but user is now in ${path.basename(paths.project)}. Failure recorded in gen-jobs only.`);
    return;
  }
  await Promise.allSettled([
    target.sceneId
      ? withRetry(() => patchSceneError(target.sceneId!, errMsg))
          .catch((e) => console.warn(`[pika-mcp] markBindFailure: scene PATCH for ${target.sceneId} gave up after retries:`, (e as Error)?.message ?? e))
      : Promise.resolve(),
    markTileFailed(target.tileId, genId, errMsg)
      .catch((e) => console.warn(`[pika-mcp] markBindFailure: tile mutate for gen ${genId} gave up:`, (e as Error)?.message ?? e)),
  ]);
}

/** Persist `failed: true` + `errorMessage` on the workspace tile so the
 *  UI shows a red failed state EVEN after the in-memory LiveGen entry
 *  expires (8s post-finish) or after a page refresh. Without this the
 *  failure was only visible via the live-gen SSE — refresh the tab and
 *  the error message disappears, leaving an orphaned `pending: true`
 *  tile that drifts into the stuck-banner heuristic instead of showing
 *  what actually went wrong. */
async function markTileFailed(tileId: string | null, genId: string, errMsg: string): Promise<void> {
  const { mutateWorkspace } = await import('../state.js');
  await mutateWorkspace((cur: any) => {
    const items = cur?.primary?.items as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(items)) return { next: cur, result: undefined };
    let touched = false;
    const nextItems = items.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const matches = (tileId && it.id === tileId) || it.taskId === genId;
      if (!matches) return it;
      touched = true;
      const updated: Record<string, unknown> = { ...it, failed: true, errorMessage: errMsg.slice(0, 240) };
      delete updated.pending;
      return updated;
    });
    if (!touched) return { next: cur, result: undefined };
    console.log(`[pika-mcp] tile failed (gen=${genId}): ${errMsg.slice(0, 80)}`);
    return { next: { ...cur, primary: { ...cur.primary, items: nextItems } }, result: undefined };
  });
}

/** PATCH a scene to `status: 'generating'` at fire time so the timeline
 *  reflects the in-flight state in the persisted timeline.json — not
 *  just in the volatile LiveGen / SSE channel. Survives server restarts
 *  AND page refreshes: a tab opened mid-gen sees the clip as actively
 *  generating, not as a stale `pending`. Best-effort; the broadcast
 *  is informational only. */
/** Boil a raw Pika MCP tool error response down to a one-line message
 *  the user can act on. Pika returns a JSON envelope with shape:
 *    { ok: false, error: { code, message, retryable?, ... } }
 *  Storing the full envelope on a workspace tile or scene shows a wall
 *  of `\n`-escaped JSON instead of the actual problem (the
 *  "agent_not_configured" wall of text the user saw). This helper
 *  extracts the most useful single-line summary: the human `message`
 *  field if present, otherwise the `code`, otherwise the first short
 *  chunk of raw text. Falls back to the original truncation behavior
 *  for non-JSON content. Capped at 240 chars to fit on a tile. */
function friendlyErrMsg(raw: string): string {
  if (!raw) return 'gen failed';
  // Find the first balanced JSON object in the text (some errors have a
  // status line prefix before the JSON).
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      // Common shape: { ok: false, error: { code, message } }
      const err = parsed?.error ?? parsed;
      if (err && typeof err === 'object') {
        const code = typeof err.code === 'string' ? err.code : undefined;
        const msg = typeof err.message === 'string' ? err.message : undefined;
        if (msg) {
          // Strip markdown headings and collapse whitespace into a
          // single readable line. Multi-line setup guides (`# Pika
          // agent setup required\n\nYou are...`) become "Pika agent
          // setup required — You are…".
          const cleaned = msg
            .replace(/^#+\s*/gm, '')
            .replace(/\n+/g, ' — ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          const prefix = code ? `[${code}] ` : '';
          return (prefix + cleaned).slice(0, 240);
        }
        if (code) return `[${code}] gen failed`.slice(0, 240);
      }
    } catch { /* not JSON — fall through */ }
  }
  // Non-JSON: collapse whitespace and truncate.
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function patchSceneGenerating(sceneId: string): Promise<void> {
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  const res = await fetch(`http://127.0.0.1:${port}/scenes/${encodeURIComponent(sceneId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    // Clear errorMessage too — if the scene was previously marked
    // as failed (orphan, prior preflight fail, etc.) and we're now
    // firing a fresh attempt, the user should see "generating" with
    // no stale error text.
    body: JSON.stringify({ status: 'generating', errorMessage: null }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`PATCH /scenes/${sceneId} (generating) → ${res.status}: ${detail.slice(0, 200)}`);
  }
}

/** PATCH a scene to status:'error' so the timeline V1 clip flips out of
 *  "Generating…" into a "Failed" state with the error message. Hits the
 *  same /scenes/:id HTTP route the success path uses — keeps the actor
 *  serialization + watcher SSE consistent. Callers wrap this in
 *  `withRetry` to harden against transient HTTP / actor-lock blips. */
async function patchSceneError(sceneId: string, errorMessage: string): Promise<void> {
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  const patchRes = await fetch(`http://127.0.0.1:${port}/scenes/${encodeURIComponent(sceneId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'error', errorMessage: errorMessage.slice(0, 1000) }),
  });
  if (!patchRes.ok) {
    const detail = await patchRes.text().catch(() => '');
    throw new Error(`PATCH /scenes/${sceneId} (error) → ${patchRes.status}: ${detail.slice(0, 200)}`);
  }
  console.log(`[pika-mcp] PATCH ${sceneId} → error: "${errorMessage.slice(0, 80)}"`);
}

/**
 * HEAD-probe every http(s) URL appearing in a tool's args. Returns the
 * list of URLs that returned non-2xx (or threw / timed out). Walks one
 * level deep: top-level string fields and arrays of strings. Doesn't
 * recurse into nested objects — Pika tool args are flat in practice.
 *
 * Why HEAD: cheap, doesn't transfer the body, won't trigger Pika's CDN
 * billing if any. 5s per-URL timeout caps the worst-case impact.
 *
 * Why parallelize: a kling-omni call has up to 6 reference_images; doing
 * them sequentially could add a second per ref. Parallel keeps total
 * preflight cost ≈ slowest single HEAD (~100ms typically).
 *
 * Skips URLs that don't look like http(s) (e.g. data: URIs, file:// paths,
 * arbitrary strings the agent passed as prompts).
 */
/** Walk top-level args + array-of-string args; for any string that
 *  looks like a local file path (not http/https/data/file) AND
 *  resolves to a real file under the project directory, upload it to
 *  Pika's CDN via upload_asset + presigned PUT and mutate the arg in
 *  place to the resulting public URL. Returns a list of upload
 *  failures (with the field name + local path) so the caller can
 *  short-circuit the gen with a clear error. An empty array means
 *  every local-looking ref was either left as-is (already a URL, or
 *  not pointing at a file) or successfully promoted to a CDN URL.
 *
 *  Idempotent across calls within one MCP message: a tiny in-process
 *  cache (mtime-keyed) avoids re-uploading the same file when the
 *  agent passes the same ref to several gens in a single turn.
 */
type UploadFailure = { field: string; localPath: string; message: string };
const localUploadCache = new Map<string, { mtimeMs: number; sizeBytes: number; publicUrl: string }>();
async function autoUploadLocalRefs(args: Record<string, unknown>): Promise<UploadFailure[]> {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const { paths } = await import('../state.js');

  // Resolve a candidate string to an absolute project-scoped file
  // path if (and only if) it looks like a local path AND the file
  // exists. Returns null for URLs, data: URIs, non-files, and any
  // attempt to escape the project root.
  const resolveLocal = (raw: string): string | null => {
    const s = raw.trim();
    if (!s) return null;
    if (/^(https?:|data:|file:)/i.test(s)) return null;
    // Must look like a path with an image/video-ish extension. Skips
    // arbitrary prompt strings, JSON snippets, etc.
    if (!/\.(png|jpe?g|webp|gif|bmp|tiff|mp4|mov|webm|wav|mp3|m4a|ogg|flac)$/i.test(s)) return null;
    const abs = pathMod.isAbsolute(s) ? s : pathMod.join(paths.project, s);
    const rel = pathMod.relative(paths.project, abs);
    if (rel.startsWith('..') || pathMod.isAbsolute(rel)) return null;
    try {
      const st = fsMod.statSync(abs);
      if (!st.isFile()) return null;
      return abs;
    } catch { return null; }
  };

  // Collect every (key, index|null, absPath) the upload needs to touch.
  type Target = { field: string; absPath: string; apply: (publicUrl: string) => void };
  const targets: Target[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === 'string') {
      const abs = resolveLocal(val);
      if (abs) targets.push({ field: key, absPath: abs, apply: (url) => { (args as any)[key] = url; } });
    } else if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (typeof v !== 'string') return;
        const abs = resolveLocal(v);
        if (abs) targets.push({ field: `${key}[${i}]`, absPath: abs, apply: (url) => { (val as any[])[i] = url; } });
      });
    }
  }
  if (targets.length === 0) return [];

  // Upload in parallel. Each failure is collected with its field name
  // so the agent can see exactly which ref couldn't be promoted.
  const failures: UploadFailure[] = [];
  await Promise.all(targets.map(async (t) => {
    try {
      const st = fsMod.statSync(t.absPath);
      const cacheKey = t.absPath;
      const cached = localUploadCache.get(cacheKey);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.sizeBytes === st.size) {
        t.apply(cached.publicUrl);
        return;
      }
      const publicUrl = await uploadFileToPikaCdn(t.absPath, st.size);
      localUploadCache.set(cacheKey, { mtimeMs: st.mtimeMs, sizeBytes: st.size, publicUrl });
      console.log(`[pika-mcp] auto-uploaded ${pathMod.relative(paths.project, t.absPath)} → ${publicUrl.slice(0, 80)}…`);
      t.apply(publicUrl);
    } catch (err) {
      failures.push({ field: t.field, localPath: pathMod.relative(paths.project, t.absPath), message: (err as Error)?.message ?? String(err) });
    }
  }));
  return failures;
}

/** Single-file upload to Pika's CDN. Mirrors uploadToPikaCdn in
 *  routes/captions.ts but reimplemented here so the agent module
 *  doesn't import a route module. Pika's upload_asset returns a
 *  presigned PUT URL + the eventual public URL; we PUT the file body
 *  ourselves and return the public URL. */
function mimeForFile(absPath: string): string {
  const ext = absPath.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'bmp': return 'image/bmp';
    case 'tiff': return 'image/tiff';
    case 'mp4': return 'video/mp4';
    case 'mov': return 'video/quicktime';
    case 'webm': return 'video/webm';
    case 'wav': return 'audio/wav';
    case 'mp3': return 'audio/mpeg';
    case 'm4a': return 'audio/mp4';
    case 'ogg': return 'audio/ogg';
    case 'flac': return 'audio/flac';
    default: return 'application/octet-stream';
  }
}
async function uploadFileToPikaCdn(absPath: string, sizeBytes: number): Promise<string> {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const filename = pathMod.basename(absPath);
  const mime = mimeForFile(absPath);
  // Route through callPikaTool so the upload picks up the same
  // ensureConnected / auth / retry behavior as every other Pika call.
  // upload_asset is not a generation tool, so the bind-target gate
  // and the auto-upload step itself are no-ops on this nested call —
  // no recursion hazard.
  const upload = await callPikaTool('upload_asset', { filename, mime_type: mime, size_bytes: sizeBytes });
  if (upload.error) throw new Error(`upload_asset failed: ${upload.content.slice(0, 200)}`);
  let parsed: { presigned_url?: string; public_url?: string } = {};
  try { parsed = JSON.parse(upload.content); }
  catch { throw new Error(`upload_asset returned non-JSON: ${upload.content.slice(0, 200)}`); }
  if (!parsed.presigned_url || !parsed.public_url) {
    throw new Error(`upload_asset missing urls: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  const body = fsMod.readFileSync(absPath);
  const put = await fetch(parsed.presigned_url, { method: 'PUT', headers: { 'content-type': mime }, body });
  if (!put.ok) {
    const txt = await put.text().catch(() => '');
    throw new Error(`presigned PUT ${put.status}: ${txt.slice(0, 200)}`);
  }
  return parsed.public_url;
}

type PreflightFailure = { field: string; url: string; status: number | string };
async function preflightUrlArgs(args: Record<string, unknown>): Promise<PreflightFailure[]> {
  const targets: Array<{ field: string; url: string }> = [];
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === 'string' && /^https?:\/\//i.test(val)) {
      targets.push({ field: key, url: val });
    } else if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
          targets.push({ field: `${key}[${i}]`, url: v });
        }
      });
    }
  }
  if (targets.length === 0) return [];
  const results = await Promise.all(targets.map(async (t): Promise<PreflightFailure | null> => {
    try {
      // SSRF guard: never probe loopback / private / link-local hosts that
      // a model-supplied reference URL might point at. Report as unfetchable.
      assertSafeAssetUrl(t.url);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(t.url, { method: 'HEAD', signal: ctl.signal });
      clearTimeout(timer);
      if (res.status >= 200 && res.status < 400) return null;
      return { field: t.field, url: t.url, status: res.status };
    } catch (err: any) {
      return { field: t.field, url: t.url, status: err?.name === 'AbortError' ? 'timeout' : `fetch error: ${String(err?.message ?? err).slice(0, 80)}` };
    }
  }));
  return results.filter((r): r is PreflightFailure => r !== null);
}

/**
 * Tracks the bind target (scene/tile) per gen_id so finishLiveGen can record
 * a friendly label into the gen-events buffer. Populated when a gen fires
 * with __sceneId or __tileId; cleared after the event is recorded.
 *
 * Memory-bounded by the gen lifecycle: entries land on fire, delete on
 * finish. No GC needed unless a gen literally never finishes (in which
 * case the in-flight liveGens map already retains it via pending-gens).
 */
const genIdToTarget = new Map<string, { sceneId: string | null; tileId: string | null }>();
export function recordGenTarget(genId: string, sceneId: string | null, tileId: string | null): void {
  genIdToTarget.set(genId, { sceneId, tileId });
}

function finishLiveGen(gen: LiveGen, errored: boolean, resultPreview: string | undefined, errorMessage: string | undefined): void {
  const finished: LiveGen = {
    ...gen,
    status: errored ? 'error' : 'done',
    endedAt: Date.now(),
    resultPreview,
    errorMessage,
    // Flip the estimated bar to 100% only on real success; leave the
    // last running pct on error so the failed state shows where it
    // stalled out instead of a misleading 100%.
    progressPct: errored ? gen.progressPct : 100,
  };
  liveGens.set(gen.id, finished);
  events.broadcast({ type: 'pika-live-gen', gen: finished });
  // Refresh the cached credit balance shortly after the gen lands so
  // the topbar pill ticks down without the user (or agent) asking.
  scheduleCreditsRefreshAfterGen();

  // Push into the agent-facing gen-events buffer so the next user turn
  // sees what happened "while you were away." Look up label from disk
  // (timeline.scenes[].labels[0] or workspace tile.label) when possible
  // so the agent reads "Option B · sc_083" instead of an opaque gen id.
  const target = genIdToTarget.get(gen.id);
  const sceneId = target?.sceneId ?? null;
  const tileId = target?.tileId ?? null;
  let label: string | null = null;
  try {
    if (sceneId) {
      // Lazy file read — cheap, no actor lock; tolerates the read happening
      // a few ms after the actor's write. Best-effort label lookup.
      const fs = require('node:fs') as typeof import('node:fs');
      const path = require('node:path') as typeof import('node:path');
      const { paths } = require('../state.js') as typeof import('../state.js');
      const tlPath = path.join(paths.project, 'timeline.json');
      if (fs.existsSync(tlPath)) {
        const tl = JSON.parse(fs.readFileSync(tlPath, 'utf8'));
        const sc = (tl?.scenes ?? []).find((s: any) => s?.id === sceneId);
        if (sc?.labels?.[0]) label = String(sc.labels[0]);
      }
    } else if (tileId) {
      const fs = require('node:fs') as typeof import('node:fs');
      const path = require('node:path') as typeof import('node:path');
      const { paths } = require('../state.js') as typeof import('../state.js');
      const wsPath = path.join(paths.project, 'workspace.json');
      if (fs.existsSync(wsPath)) {
        const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
        const it = (ws?.primary?.items ?? []).find((x: any) => x?.id === tileId);
        if (it?.label) label = String(it.label);
      }
    }
  } catch { /* label lookup is best-effort; fall through */ }

  recordGenEvent({
    genId: gen.id,
    sceneId,
    tileId,
    label,
    tool: gen.tool,
    status: errored ? 'error' : 'done',
    errorMessage,
  });
  genIdToTarget.delete(gen.id);

  // Keep the entry around briefly so the UI can fade it out gracefully
  setTimeout(() => { liveGens.delete(gen.id); }, LIVE_GEN_KEEP_AFTER_DONE_MS);
}

function looksLikeAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /401|unauthor|forbid|invalid.*token|expired/i.test(msg);
}

/** Transient transport failures (server-side timeout, network blip,
 *  Streamable HTTP session expired). The streamable-http MCP transport
 *  reports these as `MCP error -32000: Connection closed`. They're
 *  fixable by disconnecting + reconnecting + retrying once. Distinct
 *  from auth errors (which need token refresh) and from genuine tool
 *  errors (which are content issues we shouldn't retry).
 *
 *  -32001 is `RequestTimeout` from the SDK itself — Pika held the
 *  connection longer than CALL_TIMEOUT_MS without sending progress
 *  notifications that would have bumped resetTimeoutOnProgress. Rare
 *  with the 15min ceiling, but when it does happen a reconnect +
 *  retry is the right move (the gen may still be queued Pika-side;
 *  Pika dedupes by idempotency on re-fire). */
function looksLikeTransportError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /-32000|-32001|connection closed|request timed out|fetch failed|socket hang up|econnreset|enotfound/i.test(msg);
}

/** Run an async fn; if it throws a recoverable error (auth or
 *  transport), disconnect + retry ONCE. Two attempts max. */
async function callWithReconnectRetry<T>(fn: () => Promise<T>, attemptLabel: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const recoverable = looksLikeAuthError(err) || looksLikeTransportError(err);
    if (!recoverable) throw err;
    console.warn(`[pika-mcp] ${attemptLabel} recoverable error, reconnecting + retrying:`, (err as Error)?.message ?? err);
    disconnect();
    return await fn();
  }
}

function formatError(err: unknown): { content: string; error: true } {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: `pika MCP error: ${msg}`, error: true };
}

function formatResult(toolName: string, result: CallToolResult): { content: string; error?: boolean; preview?: string } {
  // Concatenate all text blocks; describe any non-text blocks.
  const parts: string[] = [];
  const imageRefs: string[] = [];
  for (const block of result.content ?? []) {
    if ((block as { type?: string }).type === 'text') {
      parts.push(String((block as { text?: string }).text ?? ''));
    } else if ((block as { type?: string }).type === 'image') {
      const b = block as { mimeType?: string };
      imageRefs.push(`[image · ${b.mimeType ?? 'image/*'}]`);
    } else {
      parts.push(`[${(block as { type?: string }).type ?? 'unknown'} block]`);
    }
  }
  const content = [...parts, ...imageRefs].join('\n').trim() || '(empty response)';
  const isErr = !!result.isError;
  const preview = previewFor(toolName, content, isErr);
  return { content, error: isErr || undefined, preview };
}

/**
 * Pull the asset URL out of an MCP CallToolResult.
 *
 * Pika's response shape (verified empirically against `task_status`):
 *   - result.structuredContent.result.structuredContent.url  ← canonical
 *   - result.structuredContent.url                            ← initial gens
 *   - result.content[0].text — Markdown like `✅ [Watch](https://...mp4)`
 *
 * Old regex `\S+` slurped the closing `)` of the Markdown link, then the
 * extension test (`\.mp4(\?|$|#)`) failed because the next char was `)`.
 * Fix excludes `()` from URL chars and prefers structuredContent fields.
 */
export function extractAssetUrl(result: CallToolResult): string | undefined {
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  const nested = walkForUrl(sc);
  if (nested) return nested;

  if (!Array.isArray(result?.content)) return undefined;
  for (const b of result.content) {
    if ((b as { type?: string }).type !== 'text') continue;
    const text = String((b as { text?: string }).text ?? '').replace(/\\\//g, '/');
    const candidates = text.match(/https?:\/\/[^\s"'<>()]+/gi) ?? [];
    for (const c of candidates) {
      if (/\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav)(\?|$|#)/i.test(c)) return c;
    }
  }
  return undefined;
}

/** Walk structuredContent recursively for a string `url` field. */
function walkForUrl(node: unknown, depth = 0): string | undefined {
  if (depth > 5 || !node || typeof node !== 'object') return undefined;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'url' && typeof v === 'string' && /^https?:\/\//.test(v)) return v;
    if (typeof v === 'object' && v !== null) {
      const r = walkForUrl(v, depth + 1);
      if (r) return r;
    }
  }
  return undefined;
}

/** True for any "terminal" status Pika reports. Pika's `task_status`
 *  uses `"completed"` for success (NOT `"done"`) — matching only on
 *  `"done"` was why pollUntilDone exited early treating the completed
 *  response as a no-envelope terminal. We accept every word the docs
 *  + observed responses use. */
const TERMINAL_STATUSES = new Set(['done', 'completed', 'failed', 'cancelled', 'canceled', 'error', 'errored']);
export function isTerminalStatus(status: string | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status.toLowerCase());
}

/** Detect a Pika task envelope. Pika exposes the task_id + status in
 *  TWO places depending on the call:
 *   - `result.structuredContent.taskId` / `.status`  — task_status replies
 *   - `result.content[0].text` as a JSON-stringified `{task_id, status}` — initial long-running gens
 *  Old impl only looked at the text block, missed the structured shape,
 *  and parsed with a fragile non-greedy regex. This version tries the
 *  structured field first, then falls back to JSON-in-text. */
function tryParseTaskShape(result: CallToolResult): { task_id?: string; status?: string } | null {
  // Path 1: structuredContent.taskId / task_id
  const sc = (result as { structuredContent?: unknown }).structuredContent as Record<string, unknown> | undefined;
  if (sc && typeof sc === 'object') {
    const tid = typeof sc.taskId === 'string' ? sc.taskId
              : typeof sc.task_id === 'string' ? sc.task_id : undefined;
    if (tid) {
      const st = typeof sc.status === 'string' ? sc.status : undefined;
      return { task_id: tid, status: st };
    }
  }

  // Path 2: JSON in a text content block (initial-call envelope).
  if (!Array.isArray(result?.content)) return null;
  for (const b of result.content) {
    if ((b as { type?: string }).type !== 'text') continue;
    const text = String((b as { text?: string }).text ?? '').trim();
    if (!text.startsWith('{')) continue;
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object' && (typeof obj.task_id === 'string' || typeof obj.taskId === 'string')) {
        return {
          task_id: obj.task_id ?? obj.taskId,
          status: typeof obj.status === 'string' ? obj.status : undefined,
        };
      }
    } catch { /* try next block */ }
  }
  return null;
}

function previewFor(toolName: string, content: string, isErr: boolean): string {
  if (isErr) return `pika · ${toolName} failed`;
  // Pika returns URLs commonly — surface the last URL as the preview if present
  const urls = content.match(/https?:\/\/\S+/g);
  if (urls && urls.length > 0) {
    const last = urls[urls.length - 1];
    const file = last.split('/').pop() ?? last;
    return `pika · ${toolName} · ${file.length > 40 ? file.slice(0, 40) + '…' : file}`;
  }
  const firstLine = content.split('\n').find((l) => l.trim()) ?? '';
  return `pika · ${toolName} · ${firstLine.length > 50 ? firstLine.slice(0, 50) + '…' : firstLine}`;
}
