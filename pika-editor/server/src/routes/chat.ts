/**
 * /chat/stream — in-app agent chat backed by the Anthropic SDK.
 *
 * Manual agentic loop:
 *   1. Call client.messages.stream with the full conversation + tools
 *   2. Stream text deltas back as SSE 'text_delta' events
 *   3. When stop_reason === 'tool_use', execute each tool block, stream
 *      'tool_start' + 'tool_end' SSE events, append tool_result blocks to
 *      the conversation, and loop.
 *   4. Exit on 'end_turn' or after MAX_TURNS to prevent runaway loops.
 *
 * Conversation state lives in-memory per server boot keyed by project. The
 * jsonl-on-disk persistence and skill-loader system prompt land in the next
 * phase.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { paths } from '../state.js';
import { TOOL_DEFS, executeTool } from '../agent/tools.js';
import { loadConv, appendMessages, resetConv, estimateConvTokens, compactConv } from '../agent/memory.js';
import { getSkillIndexBlock, getDemoPreloadBlock } from '../agent/skills.js';
import { maybeMigrateClaudeMemory } from '../agent/migrate.js';
import { isAuthenticated } from '../agent/pika-auth.js';
import { getPikaToolDefs, callPikaTool, isPikaTool, refreshTools as refreshPikaTools, disconnect as disconnectPikaMCP } from '../agent/pika-mcp.js';
import { drainGenEvents, formatGenEventsForAgent } from '../agent/gen-events.js';
import { getPersona, type Persona } from '../agent/pika-identity.js';
import { getModel, hasApiKey, hasOpenAIKey, setApiKey, clearApiKey, setOpenAIKey, clearOpenAIKey, setModel, AVAILABLE_MODELS } from '../agent/config.js';

const PostBody = z.object({
  message: z.string().min(1),
  /** Set when this is a /btw interrupt — server preserves the partial turn
   *  it just aborted instead of rolling it back, so the agent can resume
   *  aware of the work in progress. */
  interrupt: z.boolean().optional(),
});

const MAX_TOKENS = 32000;
const MAX_TURNS = 30;

type ConvMessage = Anthropic.MessageParam;
const conversations = new Map<string, ConvMessage[]>();
const migratedNotes = new Map<string, string>();
/** Last `input_tokens` reported by the API on a successful stream, per
 *  project. The CHAR estimator is unavoidably imprecise (it can't see
 *  exactly what the tokenizer does with our messages, and the system
 *  prompt + tools schema vary by Pika auth state). When we have a real
 *  number from the API, use it; the estimator is the fallback for
 *  fresh projects or post-compact state. */
const lastApiUsage = new Map<string, number>();

/** Exposed for voice mode — the realtime session replays this history
 *  at "call open" so the voice agent picks up exactly where text left
 *  off. Mutating the returned array WILL bleed back into the live
 *  conversation; voice mode reads it as a snapshot only. */
export function getConversationSnapshot(projectDir: string): ConvMessage[] {
  return getConversation(projectDir);
}

/** Append a voice-call transcript summary into the Claude conversation
 *  so the text agent stays aware of what happened on the call. Called
 *  from /voice/sync at hang-up. */
export function appendVoiceTranscript(projectDir: string, transcript: string): void {
  if (!transcript.trim()) return;
  const conv = getConversation(projectDir);
  const block = `[voice call transcript]\n${transcript.trim()}\n[end voice call]`;
  conv.push({ role: 'user', content: block });
  appendMessages(projectDir, [{ role: 'user', content: block }]);
}

function getConversation(projectDir: string): ConvMessage[] {
  let conv = conversations.get(projectDir);
  if (conv) return conv;
  // First request for this project this server boot — hydrate from disk and
  // run the one-time Claude Code memory migration.
  conv = loadConv(projectDir);
  const mig = maybeMigrateClaudeMemory(projectDir);
  if (mig.migrated) migratedNotes.set(projectDir, mig.summary);
  conversations.set(projectDir, conv);
  return conv;
}

function systemPrompt(projectDir: string, persona: Persona | null): Anthropic.TextBlockParam[] {
  const skillBlock = getSkillIndexBlock();
  const demoBlock = getDemoPreloadBlock();
  const migNote = migratedNotes.get(projectDir);
  const activeModel = getModel();
  const modelLabel = AVAILABLE_MODELS.find((m) => m.id === activeModel)?.label ?? activeModel;
  const personaBlock = persona
    ? [
        `You are **${persona.name}**, this user's personal Pika agent${persona.creature ? ` (a ${persona.creature})` : ''}${persona.emoji ? ` ${persona.emoji}` : ''}.`,
        persona.vibe ? `Vibe: ${persona.vibe}.` : '',
        `When the user opens PikaAgentEditor, you appear in the right-rail chat as ${persona.name}. Self-reference in the first person; the user knows you as ${persona.name}.`,
        '',
      ].filter(Boolean).join('\n')
    : 'You are the PikaAgentEditor agent. (Pika is not yet connected — your persona will load once the user authorizes.)';
  const lines = [
    personaBlock,
    '',
    'Right now you are running inside PikaAgentEditor — a video editor where the user edits visually and you handle planning, generation, and file work. The user sees your replies in a chat panel on the right side; the rest of the editor shows the timeline / preview / workspace document you can drive directly.',
    '',
    `Active project directory: ${projectDir}`,
    `Active model: Claude ${modelLabel} (${activeModel}). The user picked this in the top-right model selector; if they ask which model is running, answer with this exact identifier.`,
    '',
    'Tools:',
    '- File system (sandboxed to project + .claude/skills/ + brand-kit/ + tmp/): read_file, write_file, edit_file, list_dir, glob, grep, bash',
    '- Editor API: read_timeline, create_scene, patch_scene, split_clip (chops a V1 clip + its linked audio at a master-time, each half gets its own linkId — use this AFTER a 15s Seedance batch lands to cut into per-beat sub-clips), list_comments, patch_comment, add_comment, start_render, save_version, update_plan, generate_sfx, generate_music',
    '- Generative UI: write_workspace (the Workspace view in the browser auto-refreshes)',
    '- UI control: set_view, select_clip, set_playhead, play_pause, set_zoom, set_tool, open_modal',
    isAuthenticated()
      ? '- Pika MCP (connected, prefixed with `pika_`): pika_generate_image, pika_generate_video, pika_generate_reference_video, pika_generate_music, pika_generate_keyframes_video, pika_generate_lipsync, pika_generate_speech, pika_task_status, pika_create_kling_element, pika_analyze_media, pika_extract_frame, pika_search_music, pika_upload_asset, and others. Call them directly — every Pika MCP tool is exposed under the pika_ prefix in this editor. Tokens stay local; you call Pika directly, results stream back through here.'
      : '- Pika MCP NOT connected — generation tools (pika_generate_image, pika_generate_video, pika_generate_music) are not available. If the user asks to generate, ask them to click "Connect Pika" in the chat panel first.',
    '',
    skillBlock,
    demoBlock ? `\n${demoBlock}` : '',
    '',
    'CHAT STYLE (hard rules — these define the experience):',
    '',
    'You speak briefly, plainly, and with intent. Optimise for the user being able to scan your reply in 2 seconds and know what to do next. Long replies are a bug.',
    '',
    'Length:',
    '- Default: 1–2 short sentences per turn. ONE paragraph max.',
    '- If you have more to say, put it in the workspace via write_workspace and chat a one-liner pointing there.',
    '- Tables, multi-item lists, per-beat breakdowns, before/after framings, multi-paragraph rationales: NEVER in chat. Always in workspace.',
    '',
    'Tone:',
    '- Plain sentence-case prose. No headings (## ...), no bullet lists, no bold-heavy markup in chat.',
    '- Active voice. Short sentences. Subject-verb-object.',
    '- No preamble ("Let me…", "I\'ll…", "Sure!", "Got it!", "Great question!").',
    '- No restating the user\'s request.',
    '- No filler qualifiers ("might", "could", "perhaps") unless you genuinely don\'t know.',
    '- Match the user\'s tone — if they\'re terse, be terser. If they\'re casual, be casual.',
    '',
    'Yes/no questions: answer yes or no first, then one optional clarifying sentence. Not a paragraph.',
    '',
    'When you call write_workspace, also call set_view("workspace"). Then in chat: "Drafted X — see the workspace. Sign off or call out specifics?" That\'s it.',
    '',
    'Comments: mark resolved one at a time as you ship each, not in bulk.',
    '',
    'EXAMPLES of acceptable chat replies:',
    '- "Drafted the 5 revisions in the workspace. Approve all, or call out specifics?"',
    '- "Done — beat 7 v3 is up."',
    '- "Need one thing: should the cat speak or stay silent in beat 8?"',
    '- "Pika isn\'t connected yet — click Connect Pika in the panel."',
    '',
    'USER ATTACHMENTS (chip system — the user can attach files to their chat message):',
    '',
    'When the user attaches refs from the left rail, History grid, or a Workspace tile, their message arrives prefixed with a header that looks like:',
    '  [Attached file]',
    '  - assets/refs/uploads/character_v3.png  (image)',
    '  ',
    '  {their actual text — sometimes empty if they just wanted you to look}',
    '',
    'Behavior on attachments:',
    '- ALWAYS look at the file(s) before replying. For images: pika_analyze_media (or read the file via read_file if you need exact bytes). For video: pika_analyze_media. For audio: pika_transcribe_audio. For text/json/markdown: read_file.',
    '- The attached paths are project-relative — read_file accepts them as-is.',
    '- When the user attaches a file with no caption, default to "I see X — what would you like to do with it?" or run the obvious next step (e.g. use it as a ref in the next generation, replace a scene\'s videoSrc, drop it into plan.json cast).',
    '- Don\'t echo the [Attached file] header back in your reply. Refer to the file by what it IS ("the peacock portrait", "your reference photo") not by path.',
    '',
    'EXAMPLES of UNACCEPTABLE chat replies (everything below either goes to workspace or gets cut to 1 sentence):',
    '- "Here are 9 beats with the dialogue, action, and camera notes for each…" → write_workspace(kind=image-grid).',
    '- "Beat 1: keep. Beat 2: change framing because X. Beat 5: regen with Y…" → write_workspace(kind=proposal).',
    '- "Both good notes. Let me push back on myself and reframe…" + multi-paragraph reasoning → write_workspace + one-line chat.',
    '- "I\'ll start by checking the project structure, then look at the timeline, then…" → drop the preamble; just do it.',
    '',
    'Generative-UI moves (via write_workspace; pick the kind that matches the move):',
    '- kind="proposal" — decisions for the user to sign off (keep / change / regen / new / drop per item). Item: id, label, disposition, summary, optional fromSrc/toSrc, optional fromNote/toNote, optional rationale (collapsed).',
    '- kind="compare" — from/to pairs. Item: {label, fromSrc, toSrc, note?}.',
    '- kind="image-grid" — storyboard / shotlist. Item: {label, action, dialogue: [{who, line}], caption, optional pending: true when this slot is mid-generation}.',
    '- kind="video-grid" — generated clips.',
    '- kind="single" / "video-player" — single asset focus.',
    '',
    'PRODUCTION GENERATION TOOLS (use these by default — they are the contract):',
    '',
    'For any user-visible gen (a scene clip, a workspace tile image, a cast/location ref), prefer these intent-only tools over calling pika_generate_* directly. The server handles ALL UI state — scene creation, tile placeholders, gen lifecycle, downloading, PATCHing, error states — in one atomic operation. You declare the intent and end the turn.',
    '',
    '- produce_scene({prompt, model, duration, refs?, sound?, labels?}) → creates scene + V1 clip + workspace tile placeholder + fires gen + downloads to assets/pika/<sceneId>.mp4 + PATCHes timeline. Returns scene_id. Use this for every video clip on V1/V2.',
    '- produce_workspace_image({tile_id, prompt, provider?, refs?, aspect_ratio?, label?, local_rel?}) → creates the workspace tile (or claims existing) + fires gen + downloads to assets/refs/<tile_id>.<ext> (or `local_rel` if provided) + updates tile. Returns tile_id. Use this for EVERY image gen — locked refs (cast/location/product/prop), storyboards, ad concepts, hero shots, choice menus. Pass `local_rel: "assets/refs/cast/cami.png"` (or `locations/`, `products/`, `props/`) to land at a canonical Phase 2 path. Every image gen has a visible workspace tile — there is no headless ref-gen path.',
    '- gen_status({gen_job_id}) → optional. Server publishes lifecycle via SSE; you almost never need to poll.',
    '',
    'For multi-asset batches (N storyboards, N alt concepts), call write_workspace ONCE with all N tiles (pending:true, no src), set_view("workspace"), then call produce_workspace_image ×N in parallel (each with a distinct tile_id matching the workspace tile). The tile placeholders form immediately, and each fills in as its gen completes.',
    '',
    'Example for a 9-frame storyboard:',
    '  Turn 1, in order:',
    '    write_workspace({phase, headline, primary:{kind:"image-grid", items:[{id:"sb_1", label:"Beat 1", action:..., pending:true}, ...×9]}})',
    '    set_view({view:"workspace"})',
    '    produce_workspace_image({tile_id:"sb_1", prompt: beat1, ...})  ← all 9 fire in parallel',
    '    produce_workspace_image({tile_id:"sb_2", prompt: beat2, ...})',
    '    ... (×9 total)',
    '  Chat reply: ≤2 sentences ("9 storyboards in the workspace — they\'ll fill in as each gen lands.")',
    '',
    'DO NOT call pika_generate_image / pika_generate_video / pika_generate_reference_video directly anymore unless the produce_ tools cannot express what you need (rare). The produce_ tools enforce: bind-target existence, placeholder-first, retry-on-fail, persistent error state. Skipping them re-introduces every stuck-gen failure mode we fixed.',
    '',
    migNote ? `Inherited context (one-time, from previous Claude Code session): ${migNote} Read .agent/inherited-memory.md for the full contents — it has the user's role, project history, and accumulated feedback.` : '',
  ].filter(Boolean);
  return [{
    type: 'text',
    text: lines.join('\n'),
    cache_control: { type: 'ephemeral' },
  }];
}

function sse(reply: FastifyReply, event: Record<string, unknown>): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sseDone(reply: FastifyReply): void {
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/chat/stream', async (req, reply) => {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad request', detail: parsed.error.message };
    }
    const { message, interrupt = false } = parsed.data;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      sse(reply, { type: 'text_delta', text: 'ANTHROPIC_API_KEY is not set in server/.env — grab a key from console.anthropic.com (your Max subscription includes API credits) and add `ANTHROPIC_API_KEY=sk-ant-...` to `server/.env`, then restart the server.' });
      sse(reply, { type: 'done', stop_reason: 'no_key' });
      sseDone(reply);
      return reply;
    }

    const projectDir = paths.project;
    const conv = getConversation(projectDir);
    // Drain any Pika gen events that landed since the last turn (gens
    // that completed or failed in the background) and prepend a tiny
    // structured FYI block to the user's message. The agent sees it as
    // context — not as a thing to act on. Empty buffer → no prepend.
    // See server/src/agent/gen-events.ts.
    const drained = drainGenEvents();
    const eventsBlock = formatGenEventsForAgent(drained);
    const enrichedMessage = eventsBlock + message;
    const userTurn: ConvMessage = { role: 'user', content: enrichedMessage };
    conv.push(userTurn);
    const turnStartIdx = conv.length - 1;

    const client = new Anthropic({ apiKey });
    let aborted = false;
    // Detect actual client-side disconnect via the RESPONSE socket. The
    // request socket's 'close' fires on normal end-of-body and is not a
    // disconnect signal. The response socket's 'close' only fires when the
    // client drops mid-stream.
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) aborted = true;
    });

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (aborted) break;

        // Pika MCP tools are merged in dynamically. The local MCP client in
        // pika-mcp.ts holds the bearer token; Anthropic only ever sees the
        // resulting tool_result text. No token leaves this machine.
        // `delegate_to_claude` is a voice-only escape hatch — filtering
        // it out here means Claude (the text agent) never sees it,
        // which prevents recursion (Claude → delegate → Claude → …).
        // Zero behavioural change for text chat.
        const tools: Anthropic.Tool[] = [
          ...TOOL_DEFS.filter((d) => d.name !== 'delegate_to_claude'),
          ...(await getPikaToolDefs()),
        ];
        const persona = await getPersona();
        const stream = client.messages.stream({
          model: getModel(),
          max_tokens: MAX_TOKENS,
          system: systemPrompt(projectDir, persona),
          messages: conv,
          tools,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
        }, {
          // Server-side compaction. Without this, long sessions hit the
          // 1M-token context wall and every subsequent request 400s
          // ("prompt is too long"). With it, the API auto-summarizes
          // older context once the conversation crosses ~150K tokens
          // and returns compaction blocks in `final.content` — which
          // we already preserve verbatim on line 283, so subsequent
          // requests stay small. Beta header is the gate; the rest is
          // automatic.
          headers: { 'anthropic-beta': 'compact-2026-01-12' },
        });

        stream.on('text', (delta) => {
          sse(reply, { type: 'text_delta', text: delta });
        });
        // Stream summarized thinking deltas as a separate SSE channel so the
        // UI can render them in a collapsed block.
        stream.on('streamEvent', (ev) => {
          if (ev.type === 'content_block_start') {
            if (ev.content_block.type === 'thinking') sse(reply, { type: 'thinking_start' });
            else if (ev.content_block.type === 'text') sse(reply, { type: 'text_start' });
          } else if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') {
            sse(reply, { type: 'thinking_delta', text: ev.delta.thinking });
          }
        });

        const final = await stream.finalMessage();
        // Record the API's authoritative input_tokens count for this
        // request — used by /chat/stats so the meter reflects what the
        // API actually sees, not just our char estimate.
        if (final.usage?.input_tokens) {
          lastApiUsage.set(paths.project, final.usage.input_tokens);
        }
        conv.push({ role: 'assistant', content: final.content });

        if (final.stop_reason === 'refusal') {
          sse(reply, { type: 'text_delta', text: '\n\n[refused — try rephrasing]' });
          break;
        }
        if (final.stop_reason !== 'tool_use') {
          sse(reply, { type: 'done', stop_reason: final.stop_reason });
          break;
        }

        // Execute every tool_use block CONCURRENTLY. Sequential await-in-loop
        // was the reason a 9-image batch took 9× longer than one image —
        // Promise.all lets independent Pika generations run in parallel.
        // CRITICAL: we MUST emit a tool_result for EVERY tool_use block in
        // the assistant turn, even if the client aborted mid-execution —
        // otherwise the next request 400s with "tool_use ids were found
        // without tool_result blocks immediately after".
        const toolBlocks = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        // Fire all tool_start events synchronously so the UI shows every
        // pending tool immediately; THEN await their completions.
        for (const block of toolBlocks) {
          if (!aborted) sse(reply, { type: 'tool_start', name: block.name, input: block.input });
        }
        const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
          toolBlocks.map(async (block) => {
            if (aborted) {
              return {
                type: 'tool_result' as const,
                tool_use_id: block.id,
                content: 'aborted by user before this tool ran',
                is_error: true,
              };
            }
            const result = await executeTool(block.name, block.input);
            sse(reply, { type: 'tool_end', error: result.error ?? false, preview: result.preview ?? null });
            return {
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: result.content,
              is_error: !!result.error,
            };
          }),
        );
        conv.push({ role: 'user', content: toolResults });
      }
      // On abort: synthesize tool_results we already wrote inside the loop
      // keep the partial assistant + tool_result pair structurally valid.
      // We PRESERVE the partial turn so a /btw follow-up sees what the agent
      // was working on. (Earlier we rolled back on abort; that broke /btw.)
      // Manual Stop is rare enough that preserving is acceptable — the next
      // user message can redirect.
      appendMessages(projectDir, conv.slice(turnStartIdx));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err: msg }, 'chat stream failed');
      sse(reply, { type: 'text_delta', text: `\n\n[server error: ${msg}]` });
      sse(reply, { type: 'done', stop_reason: 'error' });
      // Drop everything we appended this turn so memory doesn't replay a half-finished request
      conv.length = turnStartIdx;
    }

    sseDone(reply);
    return reply;
  });

  // ----- /chat/btw : side-stream Q&A while a main turn is running ---
  // Claude Code's `/btw` pattern. Snapshots the current conversation
  // and fires a fresh Anthropic call WITHOUT tools (pure text Q&A).
  // Doesn't touch the persistent conversation memory — the question +
  // answer never become part of the main thread. The main /chat/stream
  // turn keeps running untouched in parallel.
  const BtwBody = z.object({ question: z.string().min(1) });

  app.post('/chat/btw', async (req, reply) => {
    const parsed = BtwBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad request', detail: parsed.error.message };
    }
    const { question } = parsed.data;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      sse(reply, { type: 'text_delta', text: 'ANTHROPIC_API_KEY is not set.' });
      sse(reply, { type: 'done', stop_reason: 'no_key' });
      sseDone(reply);
      return reply;
    }

    const projectDir = paths.project;
    // SNAPSHOT the conversation. The main turn may be appending to
    // `conv` concurrently — we copy the array (the message objects
    // themselves are immutable enough that a shallow copy is safe).
    const conv = getConversation(projectDir).slice();
    // Append the btw question as a one-shot user message in our local
    // copy only. Persistent memory stays untouched.
    const localConv: ConvMessage[] = [...conv, { role: 'user', content: question }];

    const client = new Anthropic({ apiKey });
    let aborted = false;
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) aborted = true;
    });

    try {
      const persona = await getPersona();
      // Slim system prompt for /btw: tell the model this is a SIDE
      // query, no tool use, brief answer. The main agent persona
      // still loads so the voice stays consistent.
      const sys: Anthropic.TextBlockParam[] = [{
        type: 'text',
        text: [
          persona?.name ? `You are ${persona.name}, this user's Pika agent.` : 'You are the PikaAgentEditor agent.',
          '',
          'This is a SIDE QUERY (the /btw pattern from Claude Code). The user is asking a quick question while a main task is still running. Answer briefly and DO NOT call any tools — even if the question implies one (e.g. "save this", "render that"). Just answer in text. The main task is unaffected; if the user wants action, they\'ll ask after the main task completes.',
          '',
          'Keep replies to 1–3 short sentences. The user is waiting for both this and the main task.',
        ].join('\n'),
      }];

      const stream = client.messages.stream({
        model: getModel(),
        max_tokens: 2048,
        system: sys,
        messages: localConv,
        // NO tools array — pure text Q&A. The model can't trigger
        // side effects from a /btw, by design.
        thinking: { type: 'adaptive', display: 'summarized' },
      }, {
        // /btw inherits the main conversation's `conv`, so it carries
        // the same compaction blocks; we enable the beta here too so
        // the API knows to honour them on this side-stream.
        headers: { 'anthropic-beta': 'compact-2026-01-12' },
      });

      stream.on('text', (delta) => {
        if (aborted) return;
        sse(reply, { type: 'text_delta', text: delta });
      });
      stream.on('streamEvent', (ev) => {
        if (aborted) return;
        if (ev.type === 'content_block_start') {
          if (ev.content_block.type === 'thinking') sse(reply, { type: 'thinking_start' });
          else if (ev.content_block.type === 'text') sse(reply, { type: 'text_start' });
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') {
          sse(reply, { type: 'thinking_delta', text: ev.delta.thinking });
        }
      });

      await stream.finalMessage();
      if (!aborted) sse(reply, { type: 'done', stop_reason: 'end_turn' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err: msg }, '/chat/btw failed');
      sse(reply, { type: 'text_delta', text: `\n\n[btw error: ${msg}]` });
      sse(reply, { type: 'done', stop_reason: 'error' });
    }

    sseDone(reply);
    return reply;
  });

  app.post('/chat/reset', async (_req, _reply) => {
    conversations.delete(paths.project);
    resetConv(paths.project);
    return { ok: true };
  });

  /**
   * GET /chat/history — return the active project's persisted
   * conversation in a UI-renderable shape. ChatPanel hydrates from this
   * on mount AND on every `project-changed` SSE so switching projects
   * surfaces the right chat history immediately. Without this, the UI
   * always started blank even though the agent's memory.jsonl had the
   * whole thread.
   *
   * The on-disk format is `Anthropic.MessageParam[]` (the same shape
   * that goes into the API). We map it into:
   *   { id, role, parts: Array<TextPart|ThinkingPart|ToolUsePart> }
   *
   * Tool-result content blocks (which appear as user-role messages) are
   * NOT shown as a separate UI message — instead they merge into the
   * preceding tool_use part's `resultPreview` field. That matches how
   * the live chat renders them.
   *
   * Capped at the most recent N messages; older messages stay on disk
   * and are still available to the agent via compaction. The cap keeps
   * the wire payload sane for 6-month-old projects with thousands of
   * turns.
   */
  app.get('/chat/history', async () => {
    const conv = getConversation(paths.project);
    const CAP = 200;
    const tail = conv.length > CAP ? conv.slice(-CAP) : conv;

    interface UIPart { type: 'text' | 'thinking' | 'tool_use'; text?: string; name?: string; input?: unknown; status?: 'ok' | 'error'; resultPreview?: string }
    interface UIMessage { id: string; role: 'user' | 'assistant'; parts: UIPart[] }

    // First pass: convert each message to UI parts. We attach an index-
    // tagged id so the React keys are stable across re-renders.
    const result: UIMessage[] = [];
    for (let i = 0; i < tail.length; i++) {
      const m = tail[i];
      const parts: UIPart[] = [];
      if (typeof m.content === 'string') {
        if (m.content.trim()) parts.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          const bt = (b as { type?: string }).type;
          if (bt === 'text') {
            const t = (b as { text?: string }).text ?? '';
            if (t.trim()) parts.push({ type: 'text', text: t });
          } else if (bt === 'thinking') {
            const t = (b as { thinking?: string }).thinking ?? '';
            if (t.trim()) parts.push({ type: 'thinking', text: t });
          } else if (bt === 'tool_use') {
            const tu = b as { name?: string; input?: unknown };
            parts.push({ type: 'tool_use', name: tu.name ?? '', input: tu.input, status: 'ok' });
          } else if (bt === 'tool_result') {
            // Merge into the preceding tool_use part of the most recent
            // assistant message. matches how the live chat appends
            // resultPreview on tool_end.
            const tr = b as { tool_use_id?: string; content?: unknown; is_error?: boolean };
            const preview = typeof tr.content === 'string'
              ? tr.content.slice(0, 240)
              : Array.isArray(tr.content)
                ? (tr.content.find((c) => (c as { type?: string }).type === 'text') as { text?: string } | undefined)?.text?.slice(0, 240) ?? ''
                : '';
            // Walk backwards through `result` to find the matching tool_use
            for (let j = result.length - 1; j >= 0; j--) {
              const prev = result[j];
              if (prev.role !== 'assistant') continue;
              const tu = prev.parts.find((p) => p.type === 'tool_use' && (p.input as { _id?: string } | undefined) === undefined);
              if (tu) {
                tu.status = tr.is_error ? 'error' : 'ok';
                tu.resultPreview = preview;
                break;
              }
              // Quick fast-exit so we don't scan too far back for noise.
              if (j < result.length - 5) break;
            }
            // tool_result messages don't become their own UI message
            continue;
          }
          // Skip images, documents, etc — they're not rendered in the
          // chat thread today.
        }
      }
      if (parts.length === 0) continue;
      result.push({ id: `hist_${i}`, role: m.role, parts });
    }
    return { messages: result, truncated: conv.length > CAP, total: conv.length };
  });



  /**
   * GET /chat/stats — current conversation size for the active project.
   * Returns rough token estimate (char count / 3.8), message count, and
   * a fraction of the 1M context window used. The chat UI polls this
   * to surface a "context X% full" indicator and warn before another
   * "prompt is too long" 400.
   */
  app.get('/chat/stats', async () => {
    const conv = getConversation(paths.project);
    // Prefer the API's last authoritative usage report (set by
    // /chat/stream after a successful call). Falls back to the char
    // estimate when no recent successful call exists — fresh project,
    // post-compact state, or current request keeps 400ing.
    const realTokens = lastApiUsage.get(paths.project);
    const estTokens = estimateConvTokens(conv);
    const tokens = realTokens ?? estTokens;
    return {
      tokens,
      messageCount: conv.length,
      contextLimit: 1_000_000,
      fractionUsed: tokens / 1_000_000,
      source: realTokens ? 'api' : 'estimate',
    };
  });

  /**
   * POST /chat/compact — drop the oldest conversation turns until the
   * buffer is under a safe target. Used when the conv has grown past
   * the API's 1M cap and stream requests are rejected wholesale (the
   * API's built-in compaction can't help because the request can't
   * even be sent). The earliest turns are lost, but recent context
   * stays verbatim — the agent re-reads project files for anything
   * it forgot.
   */
  app.post('/chat/compact', async () => {
    const conv = getConversation(paths.project);
    // Target 600K total tokens (estimator INCLUDES the ~350K fixed
    // request overhead for system + tool defs, so this leaves ~250K
    // for message content — comfortably under the 1M API cap with
    // room for the API's own compaction beta to do its work on top).
    const r = compactConv(paths.project, conv, 600_000);
    // Replace the in-memory map so subsequent requests pick up trimmed
    // state without re-reading from disk.
    conversations.set(paths.project, r.trimmed);
    // Forget the last API-reported usage — it was tied to the
    // pre-compact conv. The next successful /chat/stream will record
    // a fresh real number.
    lastApiUsage.delete(paths.project);
    return {
      ok: true,
      beforeTokens: r.beforeTokens,
      afterTokens: r.afterTokens,
      droppedMessages: r.droppedMessages,
    };
  });

  // ----- Agent runtime config (model + BYOK key) ---------------------
  // GET returns a SAFE view: `hasKey: boolean` (NOT the key itself),
  // the active model, and the list of available models. The client
  // uses this to render the topbar pill (BYOK if !hasKey, model name
  // with chevron otherwise). The key never crosses the network in
  // either direction except on POST when the user is setting it.

  app.get('/agent/config', async () => ({
    hasKey: hasApiKey(),
    hasOpenAIKey: hasOpenAIKey(),
    model: getModel(),
    availableModels: AVAILABLE_MODELS,
  }));

  const ConfigPostBody = z.object({
    apiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
    model: z.string().optional(),
    clearKey: z.boolean().optional(),
    clearOpenAIKey: z.boolean().optional(),
  });

  app.post('/agent/config', async (req, reply) => {
    const parsed = ConfigPostBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'bad request', detail: parsed.error.message };
    }
    const { apiKey, openaiApiKey, model, clearKey, clearOpenAIKey: clearOAI } = parsed.data;
    const errors: string[] = [];

    if (clearKey === true) {
      const r = clearApiKey();
      if (!r.ok) errors.push(`clearKey: ${r.error}`);
    } else if (apiKey !== undefined) {
      const r = setApiKey(apiKey);
      if (!r.ok) errors.push(`apiKey: ${r.error}`);
    }
    if (clearOAI === true) {
      const r = clearOpenAIKey();
      if (!r.ok) errors.push(`clearOpenAIKey: ${r.error}`);
    } else if (openaiApiKey !== undefined) {
      const r = setOpenAIKey(openaiApiKey);
      if (!r.ok) errors.push(`openaiApiKey: ${r.error}`);
    }
    if (model !== undefined) {
      const r = setModel(model);
      if (!r.ok) errors.push(`model: ${r.error}`);
    }

    if (errors.length) {
      reply.code(400);
      return { ok: false, error: errors.join('; ') };
    }
    return { ok: true, hasKey: hasApiKey(), hasOpenAIKey: hasOpenAIKey(), model: getModel() };
  });
}
