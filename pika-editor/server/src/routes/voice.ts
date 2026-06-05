/**
 * /voice/* — live audio call mode (OpenAI realtime API).
 *
 * This entire surface is additive — text chat is untouched. If we
 * delete this file and unregister the route from index.ts, the rest of
 * the editor behaves exactly like it did before.
 *
 * Architecture:
 *   1. Browser asks for an ephemeral session key  → POST /voice/session
 *      Server creates a realtime session with OpenAI (server-side
 *      OPENAI_API_KEY), returns the short-lived `client_secret`. The
 *      real key never leaves the server.
 *   2. Browser opens a WebRTC connection straight to OpenAI using that
 *      ephemeral key. Audio in / audio out flow direct — no proxy.
 *   3. Browser fetches /voice/context to get the Claude conversation
 *      history + live editor state snapshot, then injects that into
 *      the realtime session as the initial assistant context.
 *   4. When the realtime model calls a tool, browser proxies the call
 *      to POST /voice/tool → reuses executeTool() so voice mode has
 *      the EXACT same toolbelt as the text agent (read_file, set_view,
 *      set_playhead, play_pause, select_clip, pika_*, all of it).
 *   5. On hang-up, browser POSTs /voice/sync with the call transcript;
 *      we append it into the Claude conversation so text mode picks
 *      up where voice mode left off.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasOpenAIKey } from '../agent/config.js';
import { TOOL_DEFS, executeTool } from '../agent/tools.js';
import { paths, readTimeline } from '../state.js';
import { getConversationSnapshot, appendVoiceTranscript } from './chat.js';
import { isPikaTool } from '../agent/pika-mcp.js';
import { getPersona } from '../agent/pika-identity.js';

/** Model used for the realtime session. Stable identifier — swap here
 *  if OpenAI ships a newer realtime model the user wants to try. */
const REALTIME_MODEL = 'gpt-realtime';

/** Default voice. OpenAI realtime accepts: alloy, ash, ballad, coral,
 *  echo, sage, shimmer, verse. `alloy` is a safe default — neutral. */
const DEFAULT_VOICE = 'alloy';

/** Translate Anthropic-style Tool defs into OpenAI realtime tool defs.
 *  Realtime API uses the function-calling shape: `{ type: 'function',
 *  name, description, parameters }`. We feed the same input_schema as
 *  the parameters JSON-Schema — but OpenAI realtime is stricter than
 *  Anthropic about JSON Schema, so we sanitize first:
 *    - `type: ['string', 'null']`  →  `type: 'string'`  (drop the null
 *      union; OpenAI rejects type tuples in realtime tool defs)
 *    - tuple-typed parameters (e.g. `[{type:number},{type:number}]` on
 *      pika_analyze_clip_highlights) → drop the whole tool so the
 *      session mint doesn't fail with `invalid_function_parameters`
 *  This keeps the voice toolbelt structurally valid without changing
 *  the Anthropic-side schemas the text agent depends on. */
function sanitizeSchemaForRealtime(node: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (node === null || typeof node !== 'object') return { ok: true, value: node };
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      const r = sanitizeSchemaForRealtime(item);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'type' && Array.isArray(v)) {
      // Type union: pick the first non-null primitive, drop the rest.
      const nonNull = v.find((t) => t !== 'null' && t !== null) as string | undefined;
      if (!nonNull) return { ok: false, reason: `unsupported type union: ${JSON.stringify(v)}` };
      out[k] = nonNull;
      continue;
    }
    if (k === 'enum' && Array.isArray(v)) {
      // Strip null/undefined entries from enums — realtime expects
      // all enum members to match the (now non-null) type.
      out[k] = v.filter((x) => x !== null && x !== undefined);
      continue;
    }
    const r = sanitizeSchemaForRealtime(v);
    if (!r.ok) return r;
    out[k] = r.value;
  }
  return { ok: true, value: out };
}
function toRealtimeTools(defs: Array<{ name: string; description?: string; input_schema: unknown }>): unknown[] {
  const out: unknown[] = [];
  for (const d of defs) {
    const r = sanitizeSchemaForRealtime(d.input_schema);
    if (!r.ok) {
      console.warn(`[voice] dropping tool ${d.name} — ${r.reason}`);
      continue;
    }
    out.push({
      type: 'function',
      name: d.name,
      description: d.description ?? '',
      parameters: r.value,
    });
  }
  return out;
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {

  // ----- /voice/session : mint a realtime session ------------------
  app.post('/voice/session', async (_req, reply) => {
    if (!hasOpenAIKey()) {
      reply.code(400);
      return { ok: false, error: 'no OPENAI_API_KEY set — add one via the model pill in the chat header' };
    }
    const apiKey = process.env.OPENAI_API_KEY!;

    // Voice toolbelt is now capability-parity with the text agent —
    // same tools, same execution. The "only mutate on explicit ask"
    // rule lives in the system prompt below (no proactive save,
    // generate, render, comment). We still exclude tools that don't
    // make sense on a voice call:
    //   - bash / write_file / edit_file: low-level file edits that
    //     need visual review.
    //   - auto_caption: long-running, no visible feedback in voice.
    // Pika MCP tools are excluded for now because some have JSON
    // Schema shapes OpenAI realtime rejects (tuple-typed params).
    const VOICE_EXCLUDE = new Set(['bash', 'write_file', 'edit_file', 'auto_caption']);
    const voiceDefs = TOOL_DEFS.filter((d) => !VOICE_EXCLUDE.has(d.name));
    const tools = toRealtimeTools(voiceDefs);

    const persona = await getPersona().catch(() => null);
    const personaName = persona?.name ?? 'the Pika agent';
    const personaCreature = persona?.creature ?? '';
    const personaEmoji = persona?.emoji ?? '';
    const personaVibe = persona?.vibe ?? '';

    // The voice system prompt is intentionally short. Heavy project
    // context goes in via /voice/context (history replay + live state
    // snapshot) once the browser has the session up. Keeping this lean
    // means the realtime model boots fast.
    const instructions = [
      `You are ${personaName}${personaCreature ? `, a ${personaCreature}` : ''}${personaEmoji ? ` ${personaEmoji}` : ''} — the same agent the user has been working with in the text chat panel. You're now on a live voice call with them inside PikaAgentEditor.`,
      personaVibe ? `Vibe: ${personaVibe}.` : '',
      'When to delegate to Claude (call `delegate_to_claude` with a clear brief): ONLY when the user gives a concrete, actionable instruction that requires real work — "generate X", "make a character", "render this", "check on that task", "apply X to all four", "fix the audio mix", "plan the next sequence". Claude has the FULL toolbelt (real Pika MCP including pika_generate_image / pika_generate_video / pika_create_kling_element / pika_analyze_media / pika_task_status / pika_search_music, plus file ops + every editor tool) and runs the work end-to-end. Read Claude\'s returned summary aloud verbatim — do not paraphrase or pad.',
      'When NOT to delegate: brainstorming, opinions, questions about state, "what do you think", "I wonder if", thinking-out-loud. Answer those in voice yourself — don\'t pour every utterance through Claude. Wait for an explicit action verb (make / generate / apply / fix / render / check / show) BEFORE delegating.',
      'You handle directly (no delegate): set_view, set_playhead, play_pause, select_clip, set_zoom, set_tool, open_modal, list_projects, switch_project, create_project, set_track_gain, set_clip_gain, delete_clip, read_timeline, read_file, list_dir, glob, grep, list_comments. Fast tools, no need for Claude.',
      'AUTONOMY — only mutate state when the user explicitly asks. Never proactively save versions, add comments, render, generate, or modify the timeline yourself.',
      'PROJECT TOOLS — two different verbs:\n  • "switch to project X" / "go to project X" / "open the X project" → call list_projects to find the slug, then switch_project with that slug. Do not open the modal first.\n  • "show me my projects" / "open the projects window" / "let me see what projects I have" → just call open_modal with modal="projects". Do NOT switch — the user wants to LOOK at the picker. They will tap a project themselves OR tell you which one to switch to next.\n  • "close the projects window" → call open_modal with modal="close".',
      'SILENCE RULE — for direct UI commands ("play", "pause", "skip", "next cut", "select", "zoom", "switch project X", "go to act 2"), call the tool and produce NO speech at all. Not "okay", not "done", not "playing now". The user can see + hear the result. Speak only for questions, status reports, or readouts of content.',
      'A fresh LIVE STATE block is injected as a system message before every reply. The playhead time + active clip name there are authoritative — use them rather than guessing.',
      'A live STATE block will be injected before each user turn — playhead, active clip under the playhead, what\'s playing, view, selected clips. Use it: refer to where they are by time and clip name without asking.',
      'Talk briefly. Voice calls feel slow if every reply is a paragraph. One or two sentences per turn. Call a tool, then say what you did in 5–10 words.',
    ].filter(Boolean).join('\n\n');

    try {
      // GA Realtime API mints ephemeral keys via /v1/realtime/client_secrets.
      // The older /v1/realtime/sessions endpoint (beta) is deprecated and
      // returns "The Realtime Beta API is no longer supported." Session
      // config lives under a `session: {...}` wrapper now; the response
      // surfaces the ephemeral key as top-level `value`.
      const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: REALTIME_MODEL,
            instructions,
            tools,
            tool_choice: 'auto',
            audio: {
              // Enable transcription of the user's audio. Without this,
              // we never see what the user said — the chat would show
              // only the agent's side of the call. Whisper is the
              // baseline; gpt-4o-mini-transcribe is faster + more
              // accurate for streaming.
              input: { transcription: { model: 'gpt-4o-mini-transcribe' } },
              output: { voice: DEFAULT_VOICE },
            },
          },
        }),
      });
      const j: any = await res.json();
      if (!res.ok) {
        app.log.error({ status: res.status, body: j }, 'realtime client_secret mint failed');
        reply.code(502);
        return { ok: false, error: j?.error?.message ?? `OpenAI ${res.status}` };
      }
      return {
        ok: true,
        sessionId: j.session?.id,
        clientSecret: j.value,
        expiresAt: j.expires_at,
        model: REALTIME_MODEL,
        voice: DEFAULT_VOICE,
      };
    } catch (e: any) {
      app.log.error({ err: e?.message }, 'realtime session mint exception');
      reply.code(502);
      return { ok: false, error: e?.message ?? 'network error' };
    }
  });

  // ----- /voice/context : conversation history + live state --------
  // The browser pulls this once at call-open and pushes the result
  // into the realtime session as a system message. We deliberately
  // truncate to recent turns + skip Claude's giant thinking blocks
  // (realtime models choke on absurdly long context).
  app.get('/voice/context', async () => {
    const projectDir = paths.project;
    const conv = getConversationSnapshot(projectDir);
    let timeline: unknown = null;
    try { timeline = readTimeline().timeline; } catch {/* fresh project */}
    // Keep the last ~12 turns — enough for "we just regenerated Act II"
    // type continuity without dumping the whole project history.
    const recent = conv.slice(-12);
    const flat = recent.map((m) => {
      const role = m.role;
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if ((block as any).type === 'text') text += (block as any).text + '\n';
          else if ((block as any).type === 'tool_use') text += `[called ${(block as any).name}]\n`;
          else if ((block as any).type === 'tool_result') text += `[tool result]\n`;
        }
      }
      // Hard cap per-turn length so realtime context stays manageable.
      if (text.length > 800) text = text.slice(0, 800) + '…';
      return { role, text: text.trim() };
    }).filter((m) => m.text);
    return {
      ok: true,
      history: flat,
      timeline,
    };
  });

  // ----- /voice/tool : execute a tool the realtime model called ----
  // The browser receives `response.function_call_arguments.done` from
  // OpenAI realtime, POSTs here, gets the JSON result, then submits
  // it back as a `function_call_output` event. Same execution path as
  // the text agent — no parallel tool universe, no drift.
  const ToolBody = z.object({
    name: z.string(),
    input: z.unknown(),
  });
  // Mirror the exclusion list from /voice/session — belt-and-
  // suspenders. Same rationale: bash / file mutations / long auto_caption
  // don't belong in a voice call.
  const VOICE_TOOL_EXCLUDE = new Set(['bash', 'write_file', 'edit_file', 'auto_caption']);
  app.post('/voice/tool', async (req, reply) => {
    const parsed = ToolBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'bad request', detail: parsed.error.message };
    }
    const { name, input } = parsed.data;
    if (isPikaTool(name)) {
      return { ok: false, error: `${name} isn't available on voice calls — switch to text chat to run generations.` };
    }
    if (VOICE_TOOL_EXCLUDE.has(name)) {
      return { ok: false, error: `${name} isn't available on voice calls — switch to text chat for that.` };
    }
    try {
      const result = await executeTool(name, input);
      return { ok: true, result };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'tool failed' };
    }
  });

  // ----- /voice/sync : merge call transcript into text chat --------
  const SyncBody = z.object({ transcript: z.string() });
  app.post('/voice/sync', async (req, reply) => {
    const parsed = SyncBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.message };
    }
    appendVoiceTranscript(paths.project, parsed.data.transcript);
    return { ok: true };
  });
}
