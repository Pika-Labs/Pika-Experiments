/**
 * Pika persona loader.
 *
 * Every Pika user has a personalised agent persona (Raccoon 2.0, etc.) —
 * name, creature, vibe, emoji, voice, avatar. We pull it on first chat
 * boot per server, cache it in-memory, and inject the salient bits into
 * the system prompt so the agent self-references correctly and feels
 * familiar to any Pika user dropping into PikaAgentEditor.
 *
 * The persona is fetched via the local Pika MCP client (`identity_persona_read`),
 * which means it requires the user to have authorized Pika first. If they
 * haven't, we silently skip the persona block.
 */
import { isAuthenticated } from './pika-auth.js';
import { callPikaTool } from './pika-mcp.js';

export interface Persona {
  name: string;          // e.g. "Raccoon 2.0"
  creature?: string;     // e.g. "raccoon"
  vibe?: string;         // e.g. "chill raccoon vibes, super sharp wit, laid back but clever"
  emoji?: string;        // e.g. "🦝"
  avatarUrl?: string;    // CDN URL from pika_identity_avatar_url
  // Raw blob in case the agent wants to read fields we didn't pluck out
  raw?: unknown;
}

let cached: Persona | null = null;
let lastFetchedAt = 0;
const TTL_MS = 10 * 60 * 1000;

/** Get the cached persona, or null if Pika isn't connected / fetch failed.
 *  Refreshes after TTL or when explicitly invalidated. */
export async function getPersona(): Promise<Persona | null> {
  if (!isAuthenticated()) return null;
  if (cached && Date.now() - lastFetchedAt < TTL_MS) return cached;
  try {
    const [personaResult, avatarResult] = await Promise.all([
      callPikaTool('pika_identity_persona_read', {}),
      callPikaTool('pika_identity_avatar_url', {}),
    ]);
    if (personaResult.error) return cached;
    const parsed = parsePersona(personaResult.content);
    if (parsed) {
      if (!avatarResult.error) parsed.avatarUrl = extractUrl(avatarResult.content);
      cached = parsed;
      lastFetchedAt = Date.now();
    }
    return cached;
  } catch {
    return cached;
  }
}

function extractUrl(content: string): string | undefined {
  // The tool sometimes returns a bare URL, sometimes JSON. Pull the first https URL.
  const m = content.match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : undefined;
}

export function invalidatePersona(): void {
  cached = null;
  lastFetchedAt = 0;
}

/** Best-effort parse of whatever shape identity_persona_read returns.
 *  Pika tends to return text blocks containing JSON or labeled lines —
 *  we accept both. */
function parsePersona(content: string): Persona | null {
  if (!content) return null;
  // Try JSON first
  const jsonMatch = content.match(/\{[\s\S]+\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const persona: Persona = {
        name: pick(obj, ['name', 'displayName', 'persona_name']) ?? 'Agent',
        creature: pick(obj, ['creature', 'animal']),
        vibe: pick(obj, ['vibe', 'personality', 'description']),
        emoji: pick(obj, ['emoji', 'icon']),
        raw: obj,
      };
      if (persona.name) return persona;
    } catch { /* fall through to text parse */ }
  }
  // Markdown parse — pika_identity_persona_read returns IDENTITY.md style:
  //
  //   - **Name:**
  //       Raccoon 2.0
  //   - **Creature:**
  //       raccoon
  //
  // Value is on the line AFTER the **Bold:** label. We accept both the
  // next-line form and the same-line form, in that order. Bold markers
  // are matched explicitly to avoid greedy regexes capturing the trailing
  // `**` as the "value".
  const grab = (key: string): string | undefined => {
    const tries: RegExp[] = [
      // **Name:**\n   Raccoon 2.0
      new RegExp(`\\*\\*${key}:\\*\\*\\s*\\n+\\s*([^\\n]+)`, 'i'),
      // **Name:** Raccoon 2.0  (same line, value after)
      new RegExp(`\\*\\*${key}:\\*\\*[ \\t]+(\\S[^\\n]*)`, 'i'),
      // - Name: Raccoon 2.0  (plain markdown list)
      new RegExp(`(?:^|\\n)\\s*[-*]?\\s*${key}\\s*:\\s*(\\S[^\\n]*)`, 'i'),
    ];
    for (const re of tries) {
      const m = content.match(re);
      if (!m) continue;
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      // Skip placeholder "_(...)_" lines used in the IDENTITY.md template
      if (v && !v.startsWith('_(')) return v;
    }
    return undefined;
  };
  const name = grab('name') ?? grab('persona') ?? 'Agent';
  return {
    name,
    creature: grab('creature') ?? grab('animal'),
    vibe: grab('vibe') ?? grab('personality') ?? grab('description'),
    emoji: grab('emoji') ?? grab('icon'),
    raw: content,
  };
}

function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
