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
5. **READMEs are mandatory.** Every top-level folder has a README following the shape of `generative-ui/README.md`: tagline → prerequisites → setup → env vars table → "how it works" → troubleshooting → license link.

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

| Folder | Public name | Status | Stack | Maintainer notes |
|---|---|---|---|---|
| `generative-ui/` | **Generative UI** | ✅ live on `main` | Node 18+, browser, OpenAI Realtime, Pika MCP, optional Google OAuth | Built by the Pika team. Apache-2.0 like the other Pika-Labs repos. Upstream is `rus-jpg/voice-stage-pika`. See "Sync log" below. |

## Sync log — `generative-ui/`

> Folder was named `voice-stage-pika/` on 2026-05-25; renamed to `generative-ui/` on 2026-05-26 when the product naming finalized. Upstream repo at `rus-jpg/voice-stage-pika` keeps its name (it's the technical identifier we sync from).

| Date | Upstream commit | Public commit | Summary |
|---|---|---|---|
| 2026-05-25 | `02b6a63` *Polish voice stage experience* | initial | First public push. README, SECURITY, LICENSE, AGENTS.md, scrubbed env files. |
| 2026-05-26 | `19950bb` *Refine stage layout system* | `0f5e844` | Stage history (back/forward + animated media transitions), reduced-motion support, theme guidance added to `STAGE_LAYOUT_PROMPT`, minor menu cleanup. UX-only — no new env vars, no new endpoints, no new files, no new deps. |
| 2026-05-26 | *(no upstream change)* | this commit | Rename: `voice-stage-pika/` → `generative-ui/`. Root + subfolder READMEs rewritten with team-approved copy (Lindsay's root tagline, Rus's product description). Hero banner images removed pending a real demo still from Monica. |

**When pulling future upstream commits:**

```bash
# 1) clone upstream into /tmp
git clone https://github.com/rus-jpg/voice-stage-pika.git /tmp/upstream-vsp

# 2) diff against the last upstream commit listed above
(cd /tmp/upstream-vsp && git diff <last-upstream-sha>..HEAD)

# 3) sanity-check for: new env vars, new endpoints, new files, new dependencies,
#    new secret surface. Update generative-ui/.env.example and the README's
#    "Environment" / "Prerequisites" tables if anything is added.

# 4) copy the changed files into the public repo
#    (folder mapping: upstream root  →  generative-ui/)
rsync -av --delete \
  --exclude='.git' --exclude='.env' --exclude='.pika-token.json' \
  --exclude='.google-token.json' --exclude='IDENTITY.md' --exclude='node_modules' \
  /tmp/upstream-vsp/ /home/ke/pika-experiments/generative-ui/

# 5) re-run the pre-push checklist (below). If clean, append a row to the
#    sync log table and commit.
```

## Conventions

- **Folder names**: lowercase, hyphenated. Match the **public product name**, not the upstream repo name (which can differ — `voice-stage-pika` is publicly **Generative UI**).
- **No build steps unless necessary.** Prototypes are easier to read if they're plain HTML/JS/Node. Reach for a bundler only when you actually need it.
- **No shared dependencies between folders.** Each experiment must run from its own directory after a clone.
- **Commit messages**: conventional (`feat:`, `fix:`, `docs:`, `chore:`). Scope by folder when it helps: `feat(generative-ui): add stop-on-silence`.
- **Branch model**: direct push to `main` is currently allowed (no branch protection). If you'd prefer PR-only workflow, enable branch protection on `main` first.

## Working with multiple agents on this repo

Claude Code and Codex CLI may both edit this tree. To avoid stomping each other:

- **Claim work in the table above** (or in a GitHub issue) before starting on a folder. Update `Status` to `in-progress (claude)` / `in-progress (codex)` while you're working.
- **Each experiment folder is the unit of ownership.** Two agents editing the same folder simultaneously will conflict. Two agents editing different folders won't.
- **Run the pre-push checklist below** before every push, regardless of which agent wrote the code.

## Pre-push checklist

Run from the repo root:

```bash
# 1. No secrets in tracked files
git grep -nE '(s)k-[A-Za-z0-9_-]{20,}|(A)Iza[0-9A-Za-z_-]{20,}|(G)OCSPX-|(d)k_[A-Za-z0-9]{20,}|(g)hp_[A-Za-z0-9]{20,}' || echo "  ✅ no obvious key prefixes"

# 2. No .env / token files
git ls-files | grep -E '(^|/)\.env$|\.pika-token\.json$|\.google-token\.json$|IDENTITY\.md$' && echo "❌ secret file is tracked" || echo "  ✅ no secret files tracked"

# 3. No personal identifiers
git grep -niE '[k]ewang|[k]e@pika|[a-z]+-[j]pg' | grep -v 'support@pika\.art' || echo "  ✅ no personal markers"

# 4. Every top-level folder has a README
for d in */; do test -f "$d/README.md" || echo "❌ missing README in $d"; done

# 5. Apache-2.0 LICENSE present at root
test -f LICENSE && head -2 LICENSE | grep -qi 'apache' && echo "  ✅ LICENSE present" || echo "❌ LICENSE missing"
```

If any of those fail, **do not push**.

## Outstanding work — open invitations for the next agent

Pick one, mark `in-progress (codex|claude)` next to it before starting, and remove when done.

- [ ] **Real demo still as hero image.** Monica is preparing a still from the latest Generative UI demo cut. When it arrives, drop it at `.github/assets/generative-ui-hero.jpg` (or similar) and re-add an `<img>` tag near the top of both `README.md` (root) and `generative-ui/README.md`. **Note:** GitHub doesn't auto-play video in README, so keep it to a still until that changes.
- [ ] **Avatar placeholder.** `generative-ui/public/index.html` hardcodes `R` as the avatar initial. Change to a neutral fallback (e.g. `A` for "Agent") or pull dynamically from the connected Pika identity.
- [ ] **`CONTRIBUTING.md`.** Right now the contributing notes live inline in the root README. If the section grows, extract it.
- [ ] **GitHub Actions pre-push workflow.** Wire the pre-push checklist above into `.github/workflows/checklist.yml` so PRs auto-fail on a regression.
- [ ] **Branch protection.** If we want PR-only on `main`, enable required status checks once the GHA workflow exists.
- [ ] **Next experiment folder.** When a sibling prototype is ready, add it as a sibling top-level folder with its own README; append a row to the "Current experiments" table.

## How to push

```bash
cd /home/ke/pika-experiments
# run the pre-push checklist above
git add -A
git commit -m "<conventional commit message>"
git push origin main
```

Repo is already created at `https://github.com/Pika-Labs/Pika-Experiments`; `gh auth status` confirms the active token has push rights to the org.
