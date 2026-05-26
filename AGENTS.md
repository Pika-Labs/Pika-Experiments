# AGENTS.md

Shared instructions for any AI coding agent (Claude Code, OpenAI Codex CLI, Cursor, etc.) that opens this repository.

## What this repo is

**Pika-Experiments** is a public, Apache-2.0 monorepo of small standalone prototypes from [Pika Labs](https://www.pika.me/). Each top-level folder is one experiment, self-contained, with its own README and own runtime.

Sibling repos in the org:
- [`Pika-Labs/Pika-Plugins`](https://github.com/Pika-Labs/Pika-Plugins) — supported, versioned Claude Code / Codex / Cursor plugin (skills + MCP wiring).
- [`Pika-Labs/Pika-Skills`](https://github.com/Pika-Labs/Pika-Skills) — supported, versioned skills powered by the Pika Developer API.

This repo (`Pika-Experiments`) sits **below** those in terms of polish. Things here are intentionally rough. Don't push code here that would belong in the supported repos — promote it instead.

## Public-facing repo — non-negotiable rules

Anything that lands on `main` is world-readable. Before any commit:

1. **No secrets, ever.**
   - No `OPENAI_API_KEY`, no `GOOGLE_CLIENT_SECRET`, no `dk_*` Pika developer keys.
   - No `.env`, no `.pika-token.json`, no `.google-token.json` — the root `.gitignore` covers these but double-check.
   - No real bearer tokens or session IDs in test data or fixtures.
2. **No PII.**
   - No personal email addresses other than the public `support@pika.art` contact alias.
   - No real personal names, GitHub handles, or internal usernames anywhere in code, comments, or docs.
   - Avatar/persona placeholders should be neutral (`A`, `Agent`, etc.), not initials of real people.
3. **No internal URLs.**
   - Public endpoints (`mcp.pika.me`, `api.openai.com`, `googleapis.com`) are fine. Anything else needs justification.
4. **License header check.** Code files don't need a per-file header, but a new top-level folder should either inherit the root Apache-2.0 LICENSE or include its own OSI-compatible LICENSE.
5. **READMEs are mandatory.** Every top-level folder has a README following the shape of `voice-stage-pika/README.md`: one-line pitch → prerequisites → setup → env vars table → "how it works" → troubleshooting → license link.

## Repo layout

```
Pika-Experiments/
├── README.md           # root README — adds each experiment to the table
├── SECURITY.md         # disclosure policy
├── LICENSE             # Apache-2.0
├── AGENTS.md           # this file
├── .gitignore          # covers .env, tokens, node_modules, etc.
└── <experiment-name>/  # one folder per experiment
    ├── README.md
    ├── .env.example
    ├── .gitignore
    └── ...source...
```

## Current experiments

| Folder | Status | Stack | Maintainer notes |
|---|---|---|---|
| `voice-stage-pika/` | ✅ live on `main` | Node 18+, browser, OpenAI Realtime, Pika MCP, optional Google OAuth | Built by the Pika team. Apache-2.0 like the other Pika-Labs repos. Synced from upstream `rus-jpg/voice-stage-pika`; see "Sync log" below for last fetch. |

## Sync log — `voice-stage-pika/`

| Date | Upstream commit | Public commit | Summary |
|---|---|---|---|
| 2026-05-25 | `02b6a63` *Polish voice stage experience* | initial | First public push. README, SECURITY, LICENSE, AGENTS.md, scrubbed env files. |
| 2026-05-26 | `19950bb` *Refine stage layout system* | this commit | Stage history (back/forward + animated media transitions), reduced-motion support, theme guidance added to `STAGE_LAYOUT_PROMPT`, minor menu cleanup. UX-only — no new env vars, no new endpoints, no new files, no new deps. |

When pulling future upstream commits: diff against the last `upstream commit` row, sanity-check for new env vars / endpoints / dependencies / secrets, update the public README if anything is user-facing, append a new row here, push.

## Conventions

- **Folder names**: lowercase, hyphenated, prefixed with a domain hint when useful (`voice-stage-pika`, `webcam-director`, `multiplayer-canvas`).
- **No build steps unless necessary.** Prototypes are easier to read if they're plain HTML/JS/Node. Reach for a bundler only when you actually need it.
- **No shared dependencies between folders.** Each experiment must run from its own directory after a clone.
- **Commit messages**: conventional (`feat:`, `fix:`, `docs:`, `chore:`). Scope by folder when it helps: `feat(voice-stage-pika): add stop-on-silence`.
- **Branch model**: PRs into `main`. Squash-merge.

## Working with multiple agents on this repo

Claude Code and Codex CLI may both edit this tree. To avoid stomping each other:

- **Claim work in the table above** (or in a GitHub issue once the repo is pushed) before starting on a folder. Update `Status` to `in-progress (claude)` / `in-progress (codex)` while you're working.
- **Each experiment folder is the unit of ownership.** Two agents editing the same folder simultaneously will conflict. Two agents editing different folders won't.
- **Run the pre-push checklist below** before every push, regardless of which agent wrote the code.

## Pre-push checklist

Run from the repo root:

```bash
# 1. No secrets in tracked files
git grep -nE '(s)k-[A-Za-z0-9_-]{20,}|(A)Iza[0-9A-Za-z_-]{20,}|(G)OCSPX-|(d)k_[A-Za-z0-9]{20,}|(g)hp_[A-Za-z0-9]{20,}' || echo "  ✅ no obvious key prefixes"

# 2. No .env / token files
git ls-files | grep -E '(^|/)\.env$|\.pika-token\.json$|\.google-token\.json$|IDENTITY\.md$' && echo "❌ secret file is tracked" || echo "  ✅ no secret files tracked"

# 3. No upstream-personal identifiers
git grep -niE '[k]ewang|[k]e@pika|[a-z]+-[j]pg' | grep -v 'security@pika\.art\|support@pika\.art' || echo "  ✅ no upstream personal markers"

# 4. Every top-level folder has a README
for d in */; do test -f "$d/README.md" || echo "❌ missing README in $d"; done

# 5. Apache-2.0 LICENSE present at root
test -f LICENSE && head -2 LICENSE | grep -qi 'apache' && echo "  ✅ LICENSE present" || echo "❌ LICENSE missing"
```

If any of those fail, **do not push**.

## Outstanding work

Nice-to-haves for after the first push:

- [ ] (Optional) Add a `CONTRIBUTING.md` if the root-README contributing section grows beyond a few bullets.
- [ ] (Optional) Add a GitHub Actions workflow that runs the pre-push checklist on every PR.
- [ ] (Optional) Change the Stage's hardcoded avatar placeholder `R` in `voice-stage-pika/public/index.html` to a neutral default (`A` for "Agent").
- [ ] Stage the next experiment folder when one is ready.

## First push

When the user gives the go-ahead:

```bash
cd /home/ke/pika-experiments
git init -b main
git add .
git commit -m "feat: initial Pika-Experiments repo with voice-stage-pika"

# Create the repo on GitHub (requires `gh auth login` with org access)
gh repo create Pika-Labs/Pika-Experiments \
  --public \
  --description "A workshop of public prototypes from Pika Labs." \
  --source=. \
  --remote=origin \
  --push
```

Do **not** push without explicit user confirmation. The user said: *"have a version here before push in home."* That's a deliberate gate.
