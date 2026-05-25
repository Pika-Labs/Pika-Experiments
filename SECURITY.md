# Security policy

## Reporting a vulnerability

If you discover a security issue in **Pika Experiments** — credential exposure, an unsafe default in any experiment folder, a way to escape the localhost sandbox, anything that could harm someone running this code — please email **support@pika.art** with subject line starting `[security]` rather than opening a public issue or PR.

We aim to:

- Acknowledge within 2 business days
- Provide a fix or mitigation timeline within 7 days for high-severity issues
- Coordinate public disclosure once a fix is shipped

## Threat model for this repo

This repo ships **experimental prototypes**, not production software. Each subfolder is a small standalone app intended for **local development on a trusted machine**. The threat model assumes:

- The user runs the experiment on `localhost` or behind their own access controls.
- The user provides their own provider credentials (OpenAI, Google, etc.) via local environment files.
- Tokens and refresh tokens live in local files (`.env`, `.pika-token.json`, `.google-token.json`) that are git-ignored.

The experiments are **not hardened for public hosting**. Exposing them to the open internet without your own auth, rate limiting, and isolation is out of scope and unsafe.

## What's in scope

Issues we want to know about:

- Hardcoded secrets, tokens, or PII committed to this repository
- Defaults that would cause a user's credentials to leak (e.g., logging an API key, writing a token to a world-readable path)
- Path traversal, SSRF, or command injection in any experiment's server code
- An experiment instructing the agent in a way that could exfiltrate user data through the MCP server
- CORS / auth misconfigurations that would let a third-party site take over a running local instance

## What's out of scope (forwarded upstream)

- Issues with the upstream **Pika MCP server** (`mcp.pika.me`) → `support@pika.art` with subject `MCP server: ...`
- Provider-side issues (OpenAI Realtime, Google APIs) → those providers directly
- "I exposed this to the internet without auth and got pwned" → that's a usage issue, see the threat model above
- Bugs that don't have a security impact → open a normal GitHub issue

## Disclosure

Once a fix lands, we'll credit the reporter (if desired) in the commit message and any related advisory. If the issue affects an upstream repo (`Pika-Plugins`, `Pika-Skills`, or `pika-mcp-server`), we'll coordinate disclosure across the relevant repos.

Last updated: 2026-05-25.
