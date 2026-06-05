/**
 * Voice → Claude delegation runner.
 *
 * Architecture in one paragraph: the voice agent (gpt-realtime) is a
 * fast voice front-end but it's measurably dumber than Claude Opus 4.7.
 * For substantive tasks — character generation, scene planning, "design
 * me a thing" — the voice agent calls the `delegate_to_claude` tool
 * with a brief. The brief flows into this runner, which executes a full
 * Claude agentic loop server-side against the SAME conversation memory
 * the text chat uses. Claude has its real toolbelt (file ops, editor
 * API, every pika_* generation tool) and produces real outputs (clips
 * land in the timeline, files write to assets/). The runner returns
 * the assistant's final text + a short summary of tools fired; the
 * voice agent reads that summary back to the user.
 *
 * Crucially: this is one-way. Claude never sees the delegate tool in
 * its OWN toolbelt (chat.ts filters it out), so there's no recursion.
 * Text-chat behaviour is unchanged.
 */
import Anthropic from '@anthropic-ai/sdk';
import { paths } from '../state.js';
import { TOOL_DEFS, executeTool, type ToolResult } from './tools.js';
import { loadConv, appendMessages } from './memory.js';
import { getSkillIndexBlock, getDemoPreloadBlock } from './skills.js';
import { isAuthenticated } from './pika-auth.js';
import { getPikaToolDefs, callPikaTool, isPikaTool } from './pika-mcp.js';
import { getPersona, type Persona } from './pika-identity.js';
import { getModel, AVAILABLE_MODELS } from './config.js';
import { events } from '../events.js';

const MAX_TOKENS = 32000;
const MAX_TURNS = 20;

type ConvMessage = Anthropic.MessageParam;

/** Compact result the voice agent can speak aloud in one breath. */
export interface DelegateResult {
  ok: boolean;
  /** Final assistant text — capped so the voice agent doesn't monologue. */
  summary: string;
  /** Short list of tools fired during the turn — surfaced so the voice
   *  agent can mention "I generated X and added it to V1" honestly. */
  actions: Array<{ name: string; ok: boolean }>;
  error?: string;
}

/** In-memory conversation cache — same map chat.ts uses. We deliberately
 *  import it via the chat.ts pattern (per-project history) so delegated
 *  turns and text turns share one canonical thread. */
const conversations = new Map<string, ConvMessage[]>();
function getConversation(projectDir: string): ConvMessage[] {
  let conv = conversations.get(projectDir);
  if (conv) return conv;
  conv = loadConv(projectDir);
  conversations.set(projectDir, conv);
  return conv;
}

function systemPrompt(projectDir: string, persona: Persona | null): Anthropic.TextBlockParam[] {
  const skillBlock = getSkillIndexBlock();
  const demoBlock = getDemoPreloadBlock();
  const activeModel = getModel();
  const modelLabel = AVAILABLE_MODELS.find((m) => m.id === activeModel)?.label ?? activeModel;
  const personaBlock = persona
    ? [
        `You are **${persona.name}**, this user's personal Pika agent${persona.creature ? ` (a ${persona.creature})` : ''}${persona.emoji ? ` ${persona.emoji}` : ''}.`,
        persona.vibe ? `Vibe: ${persona.vibe}.` : '',
        '',
      ].filter(Boolean).join('\n')
    : 'You are the PikaAgentEditor agent.';
  return [{
    type: 'text',
    text: [
      personaBlock,
      '',
      'You are running INSIDE a delegate-to-claude call from your voice front-end. The user spoke a request that needed real reasoning; the voice agent handed it off to you. Do the work directly: call whatever tools you need, generate whatever assets, update workspace.json, then end with a SHORT final text the voice agent will read aloud (1–2 sentences max).',
      '',
      `Active project: ${projectDir}`,
      `Active model: Claude ${modelLabel} (${activeModel})`,
      '',
      isAuthenticated()
        ? 'Pika MCP is connected — pika_generate_image, pika_generate_video, pika_generate_reference_video, pika_generate_music, pika_create_kling_element, pika_analyze_media, pika_search_music, pika_upload_asset, and the rest are available under the pika_ prefix.'
        : 'Pika MCP is NOT connected — generation tools are unavailable. If the user needs a gen, tell them to connect Pika first.',
      '',
      skillBlock,
      demoBlock ? `\n${demoBlock}` : '',
      '',
      'BREVITY: your final text becomes spoken audio. Make it short — "Generated the character and added it to V1" beats a paragraph. The user can see the timeline update in real time.',
    ].join('\n'),
  }];
}

/** Filter out `delegate_to_claude` itself so this loop can't recurse. */
function toolDefsForDelegate(): Anthropic.Tool[] {
  return TOOL_DEFS.filter((d) => d.name !== 'delegate_to_claude') as Anthropic.Tool[];
}

async function executeAnyTool(name: string, input: unknown): Promise<ToolResult> {
  if (isPikaTool(name)) {
    const r = await callPikaTool(name, input);
    return r.error
      ? { content: r.content, error: true }
      : { content: r.content, preview: r.preview };
  }
  return executeTool(name, input);
}

export async function runDelegatedTurn(brief: string): Promise<DelegateResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, summary: '', actions: [], error: 'no ANTHROPIC_API_KEY' };
  if (!brief.trim()) return { ok: false, summary: '', actions: [], error: 'empty brief' };

  const projectDir = paths.project;
  const conv = getConversation(projectDir);
  const startIdx = conv.length;

  // Insert the delegated brief as a user turn — visible in the chat
  // history with a `[voice delegated]` marker so it's obvious where it
  // came from when the user reads back later.
  conv.push({ role: 'user', content: `[voice delegated]\n${brief}` });

  const client = new Anthropic({ apiKey });
  const persona = await getPersona().catch(() => null);
  const tools = [...toolDefsForDelegate(), ...(await getPikaToolDefs())];
  const actions: Array<{ name: string; ok: boolean }> = [];
  let finalText = '';

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const resp = await client.messages.create({
        model: getModel(),
        max_tokens: MAX_TOKENS,
        system: systemPrompt(projectDir, persona),
        messages: conv,
        tools,
        thinking: { type: 'adaptive', display: 'summarized' },
        // Output_config is unrecognized by some account/model combinations;
        // omit it here to keep delegation robust. Effort is "high" by
        // default for opus-4-7 anyway.
      } as any);

      conv.push({ role: 'assistant', content: resp.content });

      // Collect text + record tool calls for the voice summary.
      for (const block of resp.content) {
        if (block.type === 'text') finalText += block.text;
        else if (block.type === 'tool_use') {
          // Surface each tool the brain fires to the editor UI in real
          // time — broadcasting agent-action keeps the timeline + chat
          // streaming preview in sync with what's happening.
          events.broadcast({
            type: 'chat-tool-event',
            phase: 'start',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'refusal' || resp.stop_reason === 'stop_sequence') break;

      if (resp.stop_reason === 'tool_use') {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of resp.content) {
          if (block.type !== 'tool_use') continue;
          const r = await executeAnyTool(block.name, block.input);
          actions.push({ name: block.name, ok: !r.error });
          events.broadcast({
            type: 'chat-tool-event',
            phase: 'end',
            id: block.id,
            name: block.name,
            ok: !r.error,
            preview: r.preview ?? null,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: r.content,
            is_error: r.error ? true : undefined,
          });
        }
        conv.push({ role: 'user', content: toolResults });
        continue;
      }

      // Any other stop reason → bail out
      break;
    }

    appendMessages(projectDir, conv.slice(startIdx));
    return {
      ok: true,
      summary: (finalText || 'Done.').trim().slice(0, 600),
      actions,
    };
  } catch (e: any) {
    // Roll back the turn so we don't poison the conversation memory.
    conv.length = startIdx;
    return { ok: false, summary: '', actions, error: e?.message ?? 'delegation failed' };
  }
}
