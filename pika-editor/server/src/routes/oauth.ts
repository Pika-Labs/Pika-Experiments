/**
 * OAuth callback routes. Currently just for Pika MCP.
 *
 *   GET  /oauth/pika/status      → { authenticated, expiresInSec? }
 *   POST /oauth/pika/start       → { authorizeUrl }   (client opens it in a tab)
 *   GET  /oauth/pika/callback    → HTML page (auto-close + success)
 *   POST /oauth/pika/disconnect  → { ok: true }
 *
 * The callback is GET because that's where OAuth redirects users with code + state.
 */
import type { FastifyInstance } from 'fastify';
import { startFlow, completeFlow, disconnect, statusSnapshot, isAuthenticated } from '../agent/pika-auth.js';
import { refreshTools as refreshPikaTools, disconnect as disconnectPikaMCP, getActiveLiveGens, callPikaTool } from '../agent/pika-mcp.js';
import { listAllJobs, listActiveJobs, getJob } from '../agent/gen-jobs.js';
import { peekLastTickSummary } from '../agent/reconciler.js';
import { getCachedCredits } from '../agent/pika-credits.js';
import { listPresets } from '../agent/presets.js';
import { getPersona, invalidatePersona } from '../agent/pika-identity.js';
import { events } from '../events.js';

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/oauth/pika/status', async () => statusSnapshot());

  app.get('/agent/persona', async () => {
    const p = await getPersona();
    if (!p) return { persona: null };
    return { persona: { name: p.name, creature: p.creature, vibe: p.vibe, emoji: p.emoji, avatarUrl: p.avatarUrl } };
  });

  app.get('/agent/pika-gens', async () => ({ gens: getActiveLiveGens() }));

  /**
   * GET /agent/gen-jobs?active=1 — read the canonical GenJob lifecycle log.
   * Default returns ALL jobs (including terminal) so the UI can show
   * recent history; `?active=1` filters to in-flight only (queued /
   * firing / running / downloading). Single-job lookup via `?id=gj_…`.
   */
  app.get('/agent/gen-jobs', async (req) => {
    const q = req.query as { active?: string; id?: string } | undefined;
    if (q?.id) {
      const j = getJob(q.id);
      return { job: j ?? null };
    }
    return { jobs: q?.active === '1' ? listActiveJobs() : listAllJobs() };
  });

  /** GET /agent/reconciler-health — last reconciler tick summary. */
  app.get('/agent/reconciler-health', async () => ({ summary: peekLastTickSummary() }));

  /** GET /pika/credits — cached Pika wallet balance. Server polls
   *  identity_balance every 60s + opportunistically after each gen,
   *  so this returns immediately with a value that's typically <60s
   *  old. The client also subscribes to the `pika-credits` SSE so the
   *  topbar pill updates live without polling. */
  app.get('/pika/credits', async () => ({ credits: getCachedCredits() }));

  /** GET /presets — curated landing-page presets the launcher renders
   *  on a fresh project. Server-owned (the agent does not influence
   *  the list); the launcher fetches once on mount. */
  app.get('/presets', async () => ({ presets: listPresets() }));

  /**
   * GET /pika/account — surface the connected Pika identity in the topbar.
   *
   * The MCP currently exposes `identity_whoami` but NO credits / balance /
   * subscription tool. So we can't show a real credit count yet — instead
   * the Topbar pill becomes a "connected as ***5102" indicator. If Pika
   * ships a credits endpoint later this is where we'd add the field.
   */
  app.get('/pika/account', async (_req, reply) => {
    if (!isAuthenticated()) { reply.code(200); return { connected: false }; }
    try {
      const res = await callPikaTool('identity_whoami', {});
      if (res.error) return { connected: false };
      // identity_whoami's response shape varies by MCP server version.
      // Seen in the wild:
      //   1. Plain string "***5102"                       — just the display
      //   2. JSON `{"display":"***5102","phone":"...","agent_id":"..."}`
      //   3. JSON wrapped in code fences ```json … ```
      // Handle all three.
      const cleaned = res.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
      let display: string | null = null;
      let phone: string | null = null;
      try {
        const obj = JSON.parse(cleaned);
        display = typeof obj.display === 'string' ? obj.display : null;
        phone = typeof obj.phone === 'string' ? obj.phone : null;
      } catch {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const obj = JSON.parse(m[0]);
            display = typeof obj.display === 'string' ? obj.display : null;
            phone = typeof obj.phone === 'string' ? obj.phone : null;
          } catch { /* fall through */ }
        }
        if (!display) {
          // Plain-string response — treat the whole content as the display.
          // Strip surrounding quotes if any.
          display = cleaned.replace(/^"|"$/g, '');
        }
      }
      return {
        connected: true,
        display,
        phone,
        // Placeholder for future Pika MCP credit/balance tool; null today.
        credits: null as number | null,
      };
    } catch (err: any) {
      app.log.warn({ err: String(err?.message ?? err) }, '/pika/account failed');
      return { connected: false };
    }
  });

  app.post('/oauth/pika/start', async (_req, reply) => {
    try {
      return await startFlow();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { error: msg };
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/oauth/pika/callback',
    async (req, reply) => {
      const { code, state, error, error_description } = req.query;
      reply.type('text/html');
      if (error) {
        return renderHtml(`Pika connection failed: ${error_description ?? error}`, false);
      }
      if (!code || !state) {
        return renderHtml('Missing code or state parameter.', false);
      }
      const result = await completeFlow(code, state);
      if (!result.ok) return renderHtml(result.error, false);
      // Warm the MCP client + tool list + persona so the first chat turn
      // doesn't pay the connect cost, then broadcast persona-loaded so the
      // UI refetches the header. Race-free: no timeout dependency.
      refreshPikaTools()
        .then(() => getPersona())
        .then((p) => { if (p) events.broadcast({ type: 'persona-loaded' } as never); })
        .catch(() => { /* surface lazily */ });
      events.broadcast({ type: 'pika-auth-changed', authenticated: true } as never);
      return renderHtml('Pika connected. You can close this tab.', true);
    },
  );

  app.post('/oauth/pika/disconnect', async () => {
    disconnect();
    disconnectPikaMCP();
    invalidatePersona();
    events.broadcast({ type: 'pika-auth-changed', authenticated: false } as never);
    return { ok: true };
  });
}

function renderHtml(message: string, success: boolean): string {
  const accent = success ? '#836ce0' : '#ff4c62';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pika · ${success ? 'connected' : 'connect error'}</title>
<style>
  html,body { margin:0; height:100%; display:grid; place-items:center; background:#fdf7ef; color:#0d0d0d; font-family:system-ui,-apple-system,sans-serif; }
  .card { background:#fff; padding:28px 36px; border-radius:18px; box-shadow:0 12px 40px -10px #0d0d0d22; text-align:center; max-width:420px; }
  h1 { margin:0 0 8px; font-size:14px; letter-spacing:0.08em; text-transform:uppercase; color:${accent}; }
  p { margin:0 0 14px; font-size:15px; line-height:1.5; }
  button { background:#0d0d0d; color:#fff; border:none; padding:9px 18px; border-radius:999px; font-size:11px; letter-spacing:0.05em; text-transform:uppercase; cursor:pointer; }
</style>
</head><body><div class="card">
<h1>Pika · ${success ? 'connected' : 'failed'}</h1>
<p>${escapeHtml(message)}</p>
<button onclick="window.close()">Close</button>
</div>
<script>setTimeout(() => { try { window.close(); } catch {} }, ${success ? 2000 : 8000});</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
