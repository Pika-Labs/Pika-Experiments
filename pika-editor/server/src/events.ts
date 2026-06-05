import type { FastifyReply } from 'fastify';

export type Event =
  | { type: 'timeline-changed'; sha: string }
  | { type: 'comments-changed' }
  | { type: 'beats-changed' }
  | { type: 'asset-added'; relPath: string }
  | { type: 'render-progress'; jobId: string; pct: number; etaSec: number }
  | { type: 'render-done'; jobId: string; outRel: string; savedTo?: string | null }
  | { type: 'render-error'; jobId: string; message: string }
  | { type: 'pika-gen-progress'; sceneId: string; status: string }
  | { type: 'pika-live-gen'; gen: LiveGen }
  /** Canonical gen lifecycle record — the GenJob projection. Fires on
   *  every state transition AND every progress heartbeat. Workspace
   *  + timeline V1 clip should read this. The legacy `pika-live-gen`
   *  event is still emitted in parallel for backwards compat. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { type: 'gen-job'; job: any }
  /** Reconciler health summary, fired once per 10s tick. UI uses it to
   *  render a top-bar indicator (green when no drift, amber on auto-
   *  heal, red on persistent warnings). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { type: 'reconciler-health'; summary: any }
  /** Pika wallet balance refresh — fires on every fetch (success or
   *  failure). Lets the topbar credit pill stay current without polling
   *  the API from the client. Carries the full PikaCredits shape. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { type: 'pika-credits'; credits: any }
  | { type: 'sfx-ready'; placeholderId: string; relPath: string; duration: number; prompt: string }
  | { type: 'sfx-error'; placeholderId: string; status?: number; message: string }
  | { type: 'project-changed'; dir: string; name: string }
  | { type: 'agent-action'; action: AgentAction }
  | { type: 'pika-auth-changed'; authenticated: boolean }
  | { type: 'persona-loaded' }
  // Delegated-turn lifecycle — fired by the voice→Claude delegate
  // runner so the chat UI can show what the brain is doing in real
  // time (tool calls, finishes). Same surface the text-chat SSE uses,
  // just for the delegate path.
  | { type: 'chat-tool-event'; phase: 'start'; id: string; name: string; input: unknown }
  | { type: 'chat-tool-event'; phase: 'end'; id: string; name: string; ok: boolean; preview: string | null };

/**
 * In-flight Pika generation. Emitted as a SSE event when a pika_generate_*
 * tool starts, updates (e.g. status change), and completes. The UI shows
 * a live strip of these so the user can see what's cooking without
 * watching the chat tool log.
 */
/** GenJob broadcast — the canonical lifecycle record. SSE consumers
 *  (workspace, timeline V1 clip) should prefer this over LiveGen for
 *  any production UI; LiveGen stays around for legacy code paths that
 *  haven't migrated yet. The full GenJob is included so the client can
 *  derive its UI state without a follow-up fetch. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GenJobEvent = { type: 'gen-job'; job: any };

export interface LiveGen {
  id: string;                  // run id, stable across start/end
  tool: string;                // friendly name, e.g. "generate_image"
  model?: string;              // actual model arg passed to the tool (e.g. "kling-v3-omni")
  prompt?: string;             // first ~80 chars of prompt arg for context
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  resultPreview?: string;      // URL of the resulting asset (image/video) if any
  errorMessage?: string;
  /** Companion GenJob id (Phase 1). The GenJob carries the durable
   *  lifecycle record; LiveGen stays in parallel for backwards-
   *  compatible UI subscriptions. */
  jobId?: string;
  // Bind targets set at fire-and-forget time so the client can look up
  // which scene/tile this LiveGen belongs to without parsing genId →
  // target on its own. Lets the timeline V1 clip render progress.
  sceneId?: string;
  tileId?: string;
  /** Absolute path to the project this gen belongs to, captured at
   *  fire time. Used by the background runner to anchor all
   *  downstream filesystem writes (downloads, log appends, scene/tile
   *  PATCHes) to the ORIGINAL project even if the user switches
   *  projects mid-flight. Without this, an in-flight gen completing
   *  after a project switch leaks the asset into the new project's
   *  assets/ dir. */
  projectDir?: string;
  // Progress fields driven by MCP notifications/progress while the gen runs.
  // `progress` + `total` lets the UI render a precise percent when Pika
  // gives us a denominator; some tools only report `progress` (1, 2, 3…),
  // others report 0–100, others nothing at all. `progressPct` is the
  // already-normalised 0–100 number the UI renders directly so client
  // code doesn't have to re-do the math. Never injected into the agent
  // context — these stay on the SSE channel only.
  progress?: number;
  progressTotal?: number;
  progressMessage?: string;
  progressPct?: number;
}

/**
 * Commands the in-app agent emits to drive the UI directly. The client
 * subscribes in App.tsx and dispatches each one to the Zustand store. New
 * commands should be additive — the client ignores unknown kinds.
 */
export type AgentAction =
  | { kind: 'set_view'; view: 'timeline' | 'workspace' }
  | { kind: 'select_clip'; ids: string[] }
  | { kind: 'set_playhead'; t: number }
  | { kind: 'play_pause'; play?: boolean }
  | { kind: 'set_zoom'; px: number }
  | { kind: 'set_tool'; tool: 'select' | 'blade' | 'slip' | 'ripple' | 'stretch' | 'comment' }
  | { kind: 'open_modal'; modal: 'projects' | null };

class EventBus {
  private clients = new Set<FastifyReply>();

  attach(reply: FastifyReply): void {
    this.clients.add(reply);
    reply.raw.on('close', () => this.clients.delete(reply));
  }

  broadcast(ev: Event): void {
    const payload = `data: ${JSON.stringify(ev)}\n\n`;
    for (const client of this.clients) {
      try {
        client.raw.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  count(): number {
    return this.clients.size;
  }
}

export const events = new EventBus();
