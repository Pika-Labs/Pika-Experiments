# PikaAgentEditor

Agent-first video editor for Pika MCP generations. Forked from PikaCut with HyperFrames/HTML-animation stripped. Designed so the user edits visually in the browser while the agent (this Claude Code chat) plans, generates, and resolves feedback via files.

## Defaults

- **Image model: `gpt-image-2`** — cast portraits, location masters, product shots, hero props. Load `gpt-image-director` before generating. No storyboards in the default workflow.
- **Video model: Seedance Pro `r2v`** — every video clip is reference-to-video, anchored on the **locked refs** (cast / location / product / prop) directly. Load `seedance-director` before generating.
- **Audio: embedded** — `sound: true` on Seedance r2v; dialogue + ambient + Foley come back inside the clip. Music is the user's lane; never write lyrics.

Full rationale + prompt grammar lives in `.claude/skills/pae-agent/SKILL.md` (Phases 1–3). Don't reach for other providers without naming the reason.

## Architecture in one diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│ USER (browser at :3081)                                              │
│   – topbar: project / aspect / resolution / versions / render        │
│   – library: informational model reference (no generation surface)   │
│   – preview: <video> muted; Web Audio engine plays music + SFX       │
│   – timeline: V1 / V2 / Music / SFX / Cmt — drag, trim, blade, slip  │
│   – chat panel: in-app Claude Opus 4.7 agent (right rail)            │
│                       ▲                                              │
│                       │ HTTP + SSE                                   │
│                       ▼                                              │
│ SERVER (fastify at :3080)                                            │
│   – routes/: project, projects, timeline, scenes, comments,          │
│              upload, sfx, music, render, version, beats, asset,      │
│              chat (in-app agent SSE)                                 │
│   – agent/: tools (file + editor API), sandbox, memory, skills, ...  │
│   – workers/: render-job (ffmpeg), audio-extract (ffmpeg)            │
│   – watcher: chokidar → SSE                                          │
│                       ▲                                              │
│                       │ filesystem + Anthropic API                   │
│                       ▼                                              │
│ PROJECT DIR (projects/<active>/)                                     │
│   – timeline.json     ← source of truth                              │
│   – workspace.json    ← the agent's "what's next" pitch slide        │
│   – brief.md          ← agent's running plan                         │
│   – .agent/           ← per-project memory.jsonl + inherited-memory  │
│   – assets/{pika,imports,sfx,music,refs}/                            │
│   – renders/{jobs,segments}/                                         │
│   – .git/             ← named-save history                           │
│                       ▲                                              │
│                       │ Anthropic Messages API                       │
│                       ▼                                              │
│ AGENT (in-app, claude-opus-4-7 + adaptive thinking)                  │
│   – streams via /chat/stream, reads .claude/skills/*/SKILL.md        │
│   – local tools: read_file/write_file/edit_file/bash/grep/glob       │
│   – editor tools: read_timeline / create_scene / patch_scene /       │
│     list_comments / patch_comment / write_workspace                  │
│   – Pika MCP generation still runs in the external Claude Code chat  │
│     for now (auth not wired) — pending scenes flow remains unchanged │
└──────────────────────────────────────────────────────────────────────┘
```

## Boot

```bash
npm install
npm run dev   # client :3081 + server :3080
```

Override the active project: `PIKA_EDITOR_PROJECT=/abs/path npm run dev`.

## Key files

| Path | Owns |
|---|---|
| `server/src/state.ts` | Project paths singleton (mutates on switch), atomic timeline writes |
| `server/src/schema.ts` | Zod schema for timeline.json — single source of truth |
| `server/src/watcher.ts` | Chokidar → SSE broadcasts (`timeline-changed`, etc.) |
| `server/src/workers/render-job.ts` | ffmpeg trim → concat → audio-mix → MP4 |
| `server/src/workers/audio-extract.ts` | ffprobe + ffmpeg pull audio off generated videos onto SFX |
| `client/src/store.ts` | Zustand store + undo/redo + autosave + edit actions |
| `client/src/edit.ts` | Pure timeline math — move/trim/slip/ripple/split. Heavily commented. |
| `client/src/audio.ts` | Web Audio engine for music + SFX preview playback |
| `client/src/components/Timeline.tsx` | Lane stack, ruler, ghost clips, music drag-select, SFX click-to-gen |
| `client/src/components/AudioClipBox.tsx` | Drag/trim/blade for music + SFX clips |
| `client/src/components/Clip.tsx` | Drag/trim/blade/slip/ripple for video clips on V1/V2 |
| `.claude/skills/pae-agent/SKILL.md` | The agent contract — read this before generating |

## The agent contract (load this every session)

The agent skill at `.claude/skills/pae-agent/SKILL.md` is the load-bearing document for how generation works. Briefly:

1. **Brief together** — talk to the user, write `projects/<active>/brief.md` with the shotlist, cast, locations, products, key props.
2. **Lock the refs** — declare the ref set the script needs (characters / locations / products / key props), generate them with gpt-image-2 via `produce_workspace_image` (placeholder-first into the workspace), get explicit user sign-off, lock. **No storyboards.** Locked refs become the `refs[]` inputs for video gens.
3. **Generate videos** — `produce_scene` per shot, citing the locked refs this shot actually uses in `refs[]`. Server fires the underlying Pika MCP call, downloads to `assets/pika/<sceneId>.mp4`, PATCHes the scene to `ready`, runs scene-detect, auto-splits any internal cuts. Don't call the raw `pika_generate_*` tools or PATCH scenes yourself.
4. **Resolve comments** — `GET /comments`, do the work for each unresolved one, `PATCH /comments/:id { resolved: true, agentReply: '...' }`. Live, not bulk.
5. **Music + SFX** — both server-direct via the Pika MCP `generate_music` tool. SFX = `kind: 'sfx'` + `provider: 'elevenlabs'` (sync, no polling). Music = `kind: 'music'` + `provider: 'elevenlabs'` (always `force_instrumental: true`). Agent doesn't drive either — the SFX button + music drag-region in the UI fire the server route, which calls Pika directly. No separate ElevenLabs API key on the server.

**Defaults to remember:**
- `sound: true` on Seedance r2v gens (default). Dialogue + ambient + Foley come back embedded in the mp4; the V clip plays/renders from there. Promote to an A-lane clip only via the per-clip "Extract Audio" button.
- Never pass `lyrics` to music gen.
- One Pika MCP call per `produce_scene`. Don't pass a `shots[]` array asking for explicit multi-shot. Seedance r2v naturally produces internal visual cuts in some gens — the server detects them via ffmpeg scene-detect and auto-splits the resulting mp4 into per-cut timeline placeholders. That pipeline is correct as-is; don't manually `split_clip` after a Seedance landing.
- Mark each comment resolved as it ships, not in bulk.

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /timeline` | Read current state |
| `PUT /timeline` | Write (etag-guarded) |
| `GET /scenes/pending` | List pending pika-gen scenes for the agent |
| `POST /scenes` | Create new pending scene + clip |
| `PATCH /scenes/:id` | Update (status, videoSrc, etc — server auto-extracts audio) |
| `GET /comments` | List clip + floating comments |
| `POST /comments` | Add (clip-attached or floating) |
| `PATCH /comments/:id` | Update (resolve + agentReply) |
| `POST /sfx/generate` | Server-direct SFX gen via Pika MCP `generate_music` (kind: sfx, provider: elevenlabs) |
| `POST /music/generate` | Create pending music clip (agent fills) |
| `GET /music/pending` | List pending music clips for the agent |
| `PATCH /music/:id` | Agent writes back the generated MP3 |
| `POST /upload/import` | Drag-imported video files |
| `POST /render` | Start ffmpeg render |
| `POST /reveal` | macOS `open -R` |
| `POST /versions` | Named git-wrapped save |
| `GET /versions` | List saves |
| `POST /versions/:sha/restore` | Restore an older save |
| `POST /beats` | librosa beat detection on current music |
| `GET /events` | SSE stream |

## Conventions

- **Brand:** Pika design language (Telka Extended display, Telka body, cream surfaces, lavender accent `#836ce0` / `#806eca`). Never black for active states. Tokens in `client/src/styles.css`.
- **Ports:** 3080 server / 3081 client. PikaCut runs on 3070/3071; both can run side-by-side.
- **No HTML scenes.** Everything is MP4 video. The `_scenes/` directory doesn't exist here.
- **No explicit multi-shot API.** Agent makes one Pika MCP call per `produce_scene`; don't pass `shots[]`. When Seedance r2v lands an mp4 with natural visual cuts, ffmpeg scene-detect on the server splits it into per-cut timeline placeholders automatically — see `server/src/workers/scene-detect.ts`. Don't fight that pipeline; don't `split_clip` after a Seedance landing.
- **No lyrics in music.** Server enforces; agent skill enforces.

## What's deliberately not in this app

- Cast / locations panel (agent maintains refs invisibly in `assets/refs/`)
- Explicit `shots[]` multi-shot API (we accept Seedance's internal cuts and auto-split server-side)
- Captions / text overlay
- Cross-clip transitions (clip-level fade in/out only)
- Real-time collaborative editing

## In-app agent

The right rail is a chat with `claude-opus-4-7` (adaptive thinking, effort high).
The server reads `ANTHROPIC_API_KEY` from `server/.env`; the Max plan's $200/mo
credit pool meters at API rates against a key from console.anthropic.com.

Surface entry points:
- `server/src/routes/chat.ts` — POST `/chat/stream` (SSE) + POST `/chat/reset`
- `server/src/agent/tools.ts` — tool definitions + executors
- `server/src/agent/sandbox.ts` — path scoping (project + skills + brand-kit + tmp)
- `server/src/agent/memory.ts` — `projects/<active>/.agent/memory.jsonl`
- `server/src/agent/skills.ts` — skill-index loader for the system prompt
- `server/src/agent/migrate.ts` — one-time copy of ~/.claude memory on first boot

What it CAN do today: read/write project files, run bash (scoped + filtered),
edit `timeline.json` via the editor API, add/resolve comments, rewrite
`workspace.json` for the Workspace view. Skills are loaded as an index;
the agent reads the full `SKILL.md` on demand via `read_file`.

UI control — the agent can drive the editor directly via `agent-action` SSE
events the client App dispatches to the Zustand store:
- `set_view` (timeline ↔ workspace)
- `select_clip` (highlight clips)
- `set_playhead` / `play_pause` (transport)
- `set_zoom`, `set_tool` (select / blade / slip / ripple / stretch / comment)
- `open_modal` (projects switcher)
- `add_comment`, `start_render`, `save_version`
- `generate_sfx`, `generate_music`

To extend: add the new kind to `AgentAction` in both `server/src/events.ts`
and `client/src/types.ts`, then a tool + executor in
`server/src/agent/tools.ts`, then a case in `applyAgentAction` in
`client/src/App.tsx`.

What it still defers to Claude Code: Pika MCP generation calls. The pika MCP
server (`https://mcp.pika.me/api/mcp`) requires bearer auth that isn't yet
plumbed into the editor server — for now, pending scenes the in-app agent
creates are filled by running Claude Code as before.
