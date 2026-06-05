/**
 * Pika MCP OAuth client.
 *
 * Pika MCP lives at https://mcp.pika.me/api/mcp and requires a Bearer token
 * issued by the Supabase auth server discovered via
 * `/.well-known/oauth-authorization-server`. The flow we run:
 *
 *   1. Dynamic Client Registration (RFC 7591) on first connect — we don't
 *      ship a pre-shared client_id. The Supabase auth server issues us one
 *      and we cache it alongside the tokens.
 *   2. Authorization Code + PKCE (S256). We open the user's browser to the
 *      authorize URL; on success Supabase redirects to our localhost
 *      callback with `?code=...&state=...`.
 *   3. Token exchange at the token endpoint. We persist
 *      access_token + refresh_token + expires_at.
 *   4. On every Pika MCP call (via the Anthropic Messages API's mcp_servers
 *      parameter) we hand over the current access_token. If it's expired
 *      or near expiry we refresh inline.
 *
 * Token storage: ~/.config/pikaagenteditor/pika.json (chmod 0600). User-scoped,
 * not project-scoped — the same Pika account works across all projects.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';

const RESOURCE_URL = 'https://mcp.pika.me/api/mcp';
const RESOURCE_METADATA_URL = 'https://mcp.pika.me/.well-known/oauth-protected-resource';

const REDIRECT_URI = `http://127.0.0.1:${process.env.PIKA_EDITOR_PORT ?? '3080'}/oauth/pika/callback`;
const CLIENT_NAME = 'PikaAgentEditor';

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

interface StoredCredentials {
  client_id: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

interface PendingFlow {
  state: string;
  code_verifier: string;
  client_id: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  createdAt: number;
}

const CRED_DIR = path.join(homedir(), '.config', 'pikaagenteditor');
const CRED_FILE = path.join(CRED_DIR, 'pika.json');

const pendingFlows = new Map<string, PendingFlow>();

export function isAuthenticated(): boolean {
  const c = load();
  return !!(c?.refresh_token && c?.access_token);
}

export function statusSnapshot(): { authenticated: boolean; expiresInSec?: number } {
  const c = load();
  if (!c?.access_token) return { authenticated: false };
  const now = Math.floor(Date.now() / 1000);
  const expiresInSec = c.expires_at ? c.expires_at - now : undefined;
  return { authenticated: true, expiresInSec };
}

/**
 * Get a fresh access token for use as `authorization_token` on
 * `mcp_servers[]`. Refreshes silently if the current token is within 60s of
 * expiry. Returns null if the user has not connected.
 */
export async function getAccessToken(): Promise<string | null> {
  const c = load();
  if (!c?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!c.expires_at || c.expires_at - now > 60) return c.access_token;
  // Refresh
  if (!c.refresh_token) return null;
  const refreshed = await refresh(c);
  if (!refreshed) return null;
  return refreshed.access_token!;
}

/**
 * Begin the OAuth Auth Code + PKCE flow. Returns the URL we should open in
 * the user's browser. Stashes the verifier + state in `pendingFlows` keyed
 * by `state` for the callback to retrieve.
 */
export async function startFlow(): Promise<{ authorizeUrl: string }> {
  const metadata = await discoverMetadata();
  let creds = load() ?? {
    client_id: '',
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    registration_endpoint: metadata.registration_endpoint,
  };
  // Refresh endpoints from discovery in case they've changed
  creds.authorization_endpoint = metadata.authorization_endpoint;
  creds.token_endpoint = metadata.token_endpoint;
  creds.registration_endpoint = metadata.registration_endpoint;

  if (!creds.client_id) {
    if (!metadata.registration_endpoint) throw new Error('auth server does not support dynamic registration');
    creds.client_id = await dynamicRegister(metadata.registration_endpoint);
    save(creds);
  }

  const state = randomBytes(16).toString('base64url');
  const code_verifier = randomBytes(32).toString('base64url');
  const code_challenge = createHash('sha256').update(code_verifier).digest('base64url');

  pendingFlows.set(state, {
    state,
    code_verifier,
    client_id: creds.client_id,
    authorization_endpoint: creds.authorization_endpoint,
    token_endpoint: creds.token_endpoint,
    registration_endpoint: creds.registration_endpoint,
    createdAt: Date.now(),
  });

  const url = new URL(creds.authorization_endpoint);
  url.searchParams.set('client_id', creds.client_id);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', code_challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { authorizeUrl: url.toString() };
}

/**
 * Complete the flow — exchange the auth code for tokens. Returns success or
 * a human-readable error.
 */
export async function completeFlow(code: string, state: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const flow = pendingFlows.get(state);
  if (!flow) return { ok: false, error: 'invalid or expired state — please restart the connect flow' };
  pendingFlows.delete(state);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: flow.client_id,
    code_verifier: flow.code_verifier,
  });
  const res = await fetch(flow.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `token exchange failed (${res.status}): ${text.slice(0, 200)}` };
  }
  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };

  const creds: StoredCredentials = {
    client_id: flow.client_id,
    authorization_endpoint: flow.authorization_endpoint,
    token_endpoint: flow.token_endpoint,
    registration_endpoint: flow.registration_endpoint,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
  };
  save(creds);
  return { ok: true };
}

export function disconnect(): void {
  const c = load();
  if (!c) return;
  // Preserve the client_id + endpoints so reconnect doesn't need to re-register
  save({
    client_id: c.client_id,
    authorization_endpoint: c.authorization_endpoint,
    token_endpoint: c.token_endpoint,
    registration_endpoint: c.registration_endpoint,
  });
}

/* ------- internals ------- */

async function discoverMetadata(): Promise<OAuthMetadata> {
  // Per the protected-resource metadata, find the authorization server and
  // hit its discovery doc.
  const rr = await fetch(RESOURCE_METADATA_URL);
  if (!rr.ok) throw new Error(`pika resource metadata failed: ${rr.status}`);
  const resource = await rr.json() as { authorization_servers: string[] };
  const authServer = resource.authorization_servers?.[0];
  if (!authServer) throw new Error('no authorization server advertised by pika MCP');
  const ar = await fetch(`${authServer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  if (!ar.ok) throw new Error(`auth server metadata failed: ${ar.status}`);
  return await ar.json() as OAuthMetadata;
}

async function dynamicRegister(registrationEndpoint: string): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`dynamic client registration failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { client_id: string };
  if (!data.client_id) throw new Error('registration response missing client_id');
  return data.client_id;
}

async function refresh(creds: StoredCredentials): Promise<StoredCredentials | null> {
  if (!creds.refresh_token) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
    client_id: creds.client_id,
  });
  const res = await fetch(creds.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    // Refresh failed — clear tokens so the user has to reconnect
    save({
      client_id: creds.client_id,
      authorization_endpoint: creds.authorization_endpoint,
      token_endpoint: creds.token_endpoint,
      registration_endpoint: creds.registration_endpoint,
    });
    return null;
  }
  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  const next: StoredCredentials = {
    ...creds,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? creds.refresh_token,
    expires_at: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
  };
  save(next);
  return next;
}

function load(): StoredCredentials | null {
  if (!existsSync(CRED_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CRED_FILE, 'utf8')) as StoredCredentials;
  } catch { return null; }
}

function save(creds: StoredCredentials): void {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2));
  try { chmodSync(CRED_FILE, 0o600); } catch { /* best effort */ }
  // Sanity check perms
  try {
    const s = statSync(CRED_FILE);
    if ((s.mode & 0o077) !== 0) chmodSync(CRED_FILE, 0o600);
  } catch { /* ignore */ }
}

export const _internal = { RESOURCE_URL, REDIRECT_URI, CRED_FILE };
