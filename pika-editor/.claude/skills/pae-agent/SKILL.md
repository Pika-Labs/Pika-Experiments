---
name: pae-agent
description: The PikaAgentEditor agent contract. Triggers whenever the user opens a PikaAgentEditor project (presence of `projects/*/timeline.json` with `version: 2`), or asks you to "process comments", "generate pending", "fill the timeline", or any equivalent. Codifies the brief → plan → generate → comment-resolve loop, the audio defaults, and the consistency-via-refs convention. Load this skill the moment you realize you're in a PikaAgentEditor session — don't reinvent the workflow each time.
---

# PikaAgentEditor agent skill

You are the AI half of a two-surface editor. The UI ships visual editing only (drag, trim, blade, slip, ripple, comment). Generation and planning happen here, in the Claude Code chat. The timeline (`projects/*/timeline.json`) is the shared source of truth — the UI watches it, you write to it via the API.

## Two-surface workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│ USER:  edits visually in browser (drag, trim, comment, regenerate)  │
│ AGENT: plans, generates, extracts audio, resolves comments (chat)   │
│ STATE: timeline.json + assets/ on disk; SSE keeps both in sync      │
└─────────────────────────────────────────────────────────────────────┘
```

The user never types prompts into the UI. They click chips informationally, drop comments on the timeline, talk to you in chat. You read their intent, generate, write back. The UI shows the result.

## Phase 1 — Brief (mandatory)

**The very first thing every session is briefing.** Even if the user opens with "make me a video about X", you stop and brief together first. A 60-second back-and-forth produces 10× better output than guessing. No generations until the brief is complete.

Open `projects/<active>/brief.md`. If it exists, summarize it back and ask what's changed. If it doesn't exist, ask all the questions below — in one batched message, not one at a time — and wait for answers:

**Project shape**
- **Goal?** (single-clip moment, 30s reel, 90s explainer, story scene, ad, promo, demo, music video, vlog…)
- **Length target?** (rough total seconds — drives clip count)
- **Aspect ratio?** (16:9 / 9:16 / 1:1 / 4:5 / 4:3 — **this is locked once the project is created**, so confirm before creating)
- **Resolution?** (720p / 1080p / 4K — 4K is Kling-only)

**Content**
- **Who's in it?** (the user themselves via persona, a named persona like Cami / Shiro, a fictional character, no recurring character)
- **Where?** (one location, or a sequence of locations)
- **Vibe / register?** (cinematic, documentary, UGC selfie, surreal, brand promo, art-house, anime)
- **Dialogue?** (none, voice-over narration, in-scene spoken lines, lip-synced singing — drives the `sound` flag + model choice)
- **Music?** (yes/no, genre, energy, instrumental-only is the default)
- **References?** (any image or video refs they want you to use — character likeness, location, style)

Once the user has answered, write `brief.md` with these fields PLUS a **shotlist** — your draft of N clips with: per-clip prompt outline, target duration, which character/location each uses, which model you'd reach for, and any cuts. Read it back to the user and confirm before generating anything. The shotlist is the contract — getting it right here saves regen cycles.

**Don't skip steps.** Even a "quick one-shot video" deserves the brief — it's 30 seconds of conversation that prevents you from picking the wrong model, wrong aspect ratio, or wrong prompt structure.

**If no project exists yet:** confirm the canvas settings (aspect/resolution/fps) WITH the user in the brief, then guide them to "+ New project" in the topbar Projects modal with those settings, OR `POST /projects { name, aspect, resolution, fps }` on their behalf if they prefer. These can't change after creation, so the brief has to lock them.

## Phase 2 — Lock the refs (mandatory before video)

**No storyboards.** No per-beat anchor frames. Instead: identify every persistent visual the script needs — characters, locations, products, key props — generate ONE canonical ref for each via gpt-image-2, get the user to sign off, and lock them. The locked refs become Seedance's `refs[]` inputs in Phase 4. That's the whole pipeline.

**Default image model throughout: gpt-image-2.** Strongest text adherence, cleanest identity preservation across edits, reads structured prose better than tag soup. Load `.claude/skills/gpt-image-director/SKILL.md` before generating — it codifies the mandatory prompt order, the preserve-block edit discipline, and the antislop list.

### 2a — Declare the ref set

Read the brief's shotlist. From it, derive the ref set the project needs and **announce it back to the user in one chat reply**, e.g. "We need refs for 2 characters (Cami, Reg), 1 location (the rooftop), 1 product (the Pikaffects app screen). Locking those next." Then proceed to 2b.

What gets a ref:
- **Cast** — every recurring character. One canonical portrait per character; 3/4 + profile only if multiple shots need varied angles. `assets/refs/cast/<name>.png`.
- **Locations** — every distinct setting. One master shot per location; add state variants (`_calm`, `_fire`, `_night`) only when the script genuinely needs them. `assets/refs/locations/<name>.png`.
- **Products** — any branded object, app screen, packaging, or hero prop that has to read consistently across shots. `assets/refs/products/<name>.png`.
- **Key props** — anything narratively load-bearing that's not a product (the talisman, the gun, the letter). `assets/refs/props/<name>.png`.

What does NOT get its own ref: incidental set dressing, generic background characters, weather, lighting moods. Those live in the prompt, not in `refs[]`.

For one-shot scenes with no recurring visuals, the answer might be ZERO refs — that's fine, declare it ("No persistent refs needed for this — going straight to Seedance"), skip 2b/2c, jump to Phase 3.

### 2b — Generate the refs in one parallel batch

Placeholder-first. One `write_workspace` with the full ref set as `image-grid` tiles (each `id` set to the ref name, `pending: true`, no `src`), then fan out `produce_workspace_image` calls in parallel — one per ref. Each call returns `[QUEUED]` in <1s; the server fills tiles as gens land.

```
write_workspace({ primary: { kind: "image-grid", items: [
  { id: "cami",          label: "Cami · hero portrait",       pending: true },
  { id: "reg",           label: "Reg · hero portrait",        pending: true },
  { id: "rooftop",       label: "Rooftop · master",           pending: true },
  { id: "pikaffects_app", label: "Pikaffects app · screen",   pending: true },
] }})
// then in parallel:
produce_workspace_image({ tile_id: "cami",           prompt: "<…>", provider: "gpt-image-2", local_rel: "assets/refs/cast/cami.png" })
produce_workspace_image({ tile_id: "reg",            prompt: "<…>", provider: "gpt-image-2", local_rel: "assets/refs/cast/reg.png" })
produce_workspace_image({ tile_id: "rooftop",        prompt: "<…>", provider: "gpt-image-2", local_rel: "assets/refs/locations/rooftop.png" })
produce_workspace_image({ tile_id: "pikaffects_app", prompt: "<…>", provider: "gpt-image-2", local_rel: "assets/refs/products/pikaffects_app.png" })
```

Use `set_view({ view: "workspace" })` in the same turn so the user lands on the live grid.

### 2c — Lock with explicit user sign-off

**Do not start Phase 3 until the user has explicitly approved the ref set.** Fixes happen here, not later:
- "Make Cami's hair shorter" → gpt-image-2 edit-mode on `cami.png` with a preserve-block + change description. Save back to the same path; the tile re-renders.
- "Redraw the rooftop from scratch" → full regen, only on explicit "redraw" instruction.
- "Locking refs" / "These all work" / "Approved" → all refs lock. Note the lock in `brief.md` (timestamp + the ref paths). After this, refs are treated as canonical for the rest of the project; don't silently regenerate them.

For Kling-bound characters (only when the script demands consistent identity across many shots and Seedance r2v is dropping likeness), additionally run `pika_create_kling_element` on the locked portrait and stash the `kling_element_id` in `brief.md`. This is a rare reach; Seedance r2v with the locked ref is the default.

## Phase 3 — Plan the Seedance gens (default video model)

Refs are locked (Phase 2). Now plan the video gens. **Default video model: Seedance Pro r2v**, anchored on the locked refs directly — no storyboard intermediary. Reasons:
- Seedance r2v reads gpt-image-2 stills extremely well; identity, palette, set continuity transfer from the locked refs straight into the video.
- Skipping per-beat storyboards saves a full image-gen pass and an approval cycle without losing quality — the prompt does the framing work.
- A single 15s r2v call can naturally yield multiple internal visual cuts when the prompt describes a short sequence; the server splits the landing mp4 at every detected cut into per-cut timeline placeholders.

### Per-call rule

One Pika MCP call per timeline shot. **Don't pass a `shots[]` array** — we do not use the explicit multi-shot API. When you want a single Seedance landing to cover a short multi-beat sequence (e.g. 3 beats over ~15s), describe the beats in PROSE inside a single bilingual EN+ZH prompt and let Seedance do its natural cutting. The server's ffmpeg scene-detect splits the landing mp4 into one timeline placeholder per detected cut. Each call:

- **One r2v generation.** Single prompt, multiple refs allowed, single mp4 out.
- **Refs = the locked refs this shot needs.** Cite every locked ref the shot actually references — the character(s) in frame, the location, any branded product or load-bearing prop. Seedance reads `refs[]` as canonical source-of-truth for identity / palette / location / product appearance.
- **Prompt** = detailed bilingual EN+ZH prose per the `seedance-director` skill. The skill's "Output Format" governs structure; the "Engine Rules" + "Cut Rules" govern content. When you want multi-cut output, the prompt names the beats inline — don't reach for `shots[]`.
- **NO MUSIC — but yes dialogue + SFX.** Prompt-level rule, not a flag. Include `"No music, no soundtrack, no score. Dialogue and ambient sound only — room tone, Foley, environmental SFX."` (and Chinese equivalent) in the Audio section. **Keep `sound: true`** (default) so the model synthesizes dialogue + ambient + Foley. Audio stays embedded in the V clip and plays/renders from there — no separate A-lane clip by default. The user can promote it via the per-clip "Extract Audio" button when they want to edit audio independently. Setting `sound: false` would suppress the dialogue we want.

### When to split a sequence across multiple gens

- A beat with **spoken named dialogue** that needs perfect enunciation → generate solo via Veo 3 fast (cleaner lipsync). Its own scene, its own gen.
- A hard tonal cut (entirely different palette, location, style) → end the prompt at the cut and start a new gen. Don't try to make Seedance bridge it.
- Total runtime > 15s → can't fit in one Seedance call; split into N gens.

### Pending-scene shape

For each Seedance call, create ONE pending scene via the `produce_scene` intent tool — server creates the scene, fires the underlying `pika_generate_reference_video` MCP call, and auto-binds the result on landing:

```
produce_scene({
  prompt: "<bilingual EN+ZH prose from seedance-director>",
  model: "seedance-2-pro-r2v",
  duration: <total seconds, ≤15>,
  refs: [
    "assets/refs/cast/cami.png",          // characters in frame
    "assets/refs/locations/rooftop.png",  // setting
    "assets/refs/products/pikaffects_app.png", // product if relevant
  ],
  startSec: <where on V1>,
  trackId: "v1",
  labels: ["<short shot label>"]
})
```

Cite only the refs this shot actually uses; don't dump every locked ref into every gen. The server handles everything from there: scene creation, gen firing, polling, download to `assets/pika/<sceneId>.mp4`, PATCH to ready, ffmpeg scene-detect, auto-split. Don't call the raw `pika_generate_*` tools — `produce_scene` exists so the agent doesn't have to chain create_scene + pika_generate_video + patch_scene + split_clip across turns.

**Always load the matching director skill** before generating. Each director codifies that model's prompt grammar, hard constraints, and antislop. They live at:

- `.claude/skills/seedance-director/SKILL.md` — Seedance 2.0 bilingual EN+ZH prompts, archetype router, cut rules, **production pipeline** (the canonical video prompt skill — load this first)
- `.claude/skills/kling-director/SKILL.md` — Kling 3.0 cinematic prompts, 80–150 word sweet spot, element-id usage (only for the rare Kling-bound shot)
- `.claude/skills/gpt-image-director/SKILL.md` — gpt-image-2 still refs (cast, location, product, prop)

For non-Seedance shots (Veo for clean dialogue, Kling for element-bound character shots) — `produce_scene` with the matching `model:` field. Same `refs[]` discipline: cite the locked refs that shot actually needs.

## Phase 4 — Generate (server does the rest)

Per shot, call `produce_scene` with the bilingual prompt + the locked refs this shot needs in `refs[]`. The tool returns `[QUEUED]` in <1s and the server runs the entire pipeline asynchronously: fires the underlying Pika MCP call, polls until done, downloads to `assets/pika/<sceneId>.mp4`, PATCHes the scene to `ready` with the videoSrc, runs ffmpeg scene-detect, and splits the V1 clip at every detected cut into separate placeholders. The user watches all of this happen live via SSE.

**Things you DON'T do manually anymore** (server owns them):
- `create_scene` + `pika_generate_video` + `patch_scene` — collapsed into `produce_scene`.
- Downloading the CDN URL via `bash curl`.
- PATCHing `status: 'generating'` or `'ready'`.
- `split_clip` to cut a multi-cut Seedance landing — scene-detect runs automatically.
- Marking scenes failed on error — server reconciler handles that too.

**Things you DO still own:**
- Picking the right locked refs for each shot's `refs[]` (server doesn't second-guess which character/location/product is in frame).
- Writing the bilingual prompt per the director skill.
- Choosing the model (`seedance-2-pro-r2v` default; Veo for clean dialogue, Kling for element-bound shots).
- Setting accurate `labels` so the V1 placeholder reads as the right shot in the UI.

**Parallel firing.** Multiple `produce_scene` calls in one turn fan out — each fires its own background gen. The agent's turn can end as soon as all calls return `[QUEUED]` (sub-second). Don't await landings inline.

**Audio defaults.** `sound: true` on Seedance r2v (server default). The no-music constraint lives in the PROMPT. Dialogue + ambient SFX come back inside the video clip's embedded audio — they play and render from there with no separate A-lane clip needed. Music is the user's lane only.

**On error.** If `produce_scene` returns `error: true` synchronously, the gen never fired — read the error and adjust (most common: a ref URL preflight failed, or a local-path ref couldn't be auto-uploaded). If the call returned `[QUEUED]` but the gen later fails, the server's reconciler flips the scene to `error` with the message — you'll see it next turn via gen-events. Don't poll; don't pre-mark scenes as failed.

## Phase 5 — Comment resolution

The user drops comments on the timeline (clip-attached, free-floating, or ghost-clip placeholders). When they ask you to "process comments":

1. `GET /comments` — fetch all comments
2. For each unresolved comment, do the work it describes:
   - **Ghost clip** (floating + ghostClipId, on a video track) → treat as a new clip request, generate per Phase 4
   - **Clip-attached comment** → most often a regenerate request ("brighter", "less shaky"). Re-run generation with adjusted params.
   - **Floating note** without ghostClipId → a free-form instruction ("cut the middle act"). Do the edit; mark resolved with an `agentReply` explaining what you did.
3. **Mark resolved one at a time**, not in bulk: `PATCH /comments/<id>` with `{ resolved: true, agentReply: "regenerated with Sora at brighter exposure, take 02" }`. The user watches comments flip live; bulk-resolve at the end feels broken.
4. If a comment is ambiguous, set `resolved: false` and `agentReply: "Need clarification — should this be a wide or a close-up?"` so the user sees your question without you ghosting the comment.

## Phase 6 — Audio (music, VO, SFX — all on unified `audioTracks`)

The timeline has a **unified audio model**: every audio item (music, VO/dialogue, SFX) lives on some `AudioTrack` in `timeline.audioTracks` — there's no longer a separate music lane vs SFX1/SFX2/VO. Tracks are numbered `a1, a2, a3, …` and the user can rename them. The server auto-places new clips on the first track with no time collision, creating a new track if needed.

**Both gens are server-direct.** The user generates from the UI; you generally don't need to drive these:
- **Music**: drag a region on any audio lane → composer → Pika MCP `generate_music` (kind: 'music', provider: 'elevenlabs', `force_instrumental: true`, `music_length_ms` from drag width) runs server-side. Prompt enhancer expands short prompts. No separate ElevenLabs API key on the server — Pika auth covers it.
- **SFX**: click an empty audio lane → composer → Pika MCP `generate_music` (kind: 'sfx', provider: 'elevenlabs') runs server-side. Sync, no polling.

When *you* should drive audio gens:
- Brief explicitly asks you to score the project. Call `POST /music/generate` with prompt + `durationSec`.
- User comments "add a tense drone under clip 03". Call `POST /sfx/generate` at the right `startSec`. Optional `trackId` (`a1` / `a2` / …) if you want a specific lane; omit it to let the server auto-place.

What you should NOT do:
- Call `pika_generate_music` from the agent loop for music/SFX placeholders the user is dragging. The server already routes those drag-regions / SFX-button clicks through the MCP `generate_music` tool on its own — agent calls would double-generate.
- Pass `lyrics` to any music gen — instrumental only.
- Reference the legacy `VO` / `SFX1` / `SFX2` lane names in tool calls. Use track ids (`a1`...) when you need to be specific; otherwise omit `trackId` entirely.

## Server API quick reference

```
GET    /timeline                  — read current state
GET    /scenes/pending            — list pending pika-gen scenes
POST   /scenes                    — add new pending clip + scene
PATCH  /scenes/:id                — update scene (status, videoSrc, etc)
DELETE /scenes/:id                — remove
GET    /comments                  — list every comment
POST   /comments                  — add (clip-attached or floating)
PATCH  /comments/:id              — update (resolve + agentReply)
DELETE /comments/:id              — remove
POST   /render                    — start ffmpeg render → MP4
GET    /events                    — SSE stream
```

Server runs on `http://127.0.0.1:3080`.

## Project file layout

```
projects/<active>/
  timeline.json          ← source of truth for the editor
  brief.md               ← what we agreed on (your scratch + plan)
  assets/
    pika/                ← agent-generated MP4s (videoSrc points here)
    sfx/                 ← extracted audio + manual SFX
    music/               ← music sources used on audioTracks
    refs/
      cast/              ← locked character portraits
      locations/         ← locked location masters
      products/          ← locked product / app-screen / branded-object refs
      props/             ← locked narrative props (talisman, weapon, letter, etc.)
    imports/             ← user-imported video files
  renders/
    jobs/                ← final exported MP4s
    segments/            ← per-clip cuts for the render cache
```

## What not to do

- **Don't generate from a one-line user request without briefing first.** Asking 3 quick questions yields 10× better output.
- **Don't bypass the `pending → generating → ready` lifecycle.** The UI relies on it for the spinner state.
- **Multi-shot is allowed on Seedance + Kling**, but **always split into N V1 clips** after gen (see Phase 3). Never leave a multi-shot mp4 as a single timeline clip — the user can't edit across the cuts.
- **If Sora returns implicit multi-shot output** (model cuts mid-clip on its own), regenerate as single-shot — Sora doesn't expose a `shots` API so we can't split deterministically.
- **Don't write the same prompt twice.** Every clip's prompt should reflect the project's accumulated style + the specific shot's purpose.
- **Don't leave comments unresolved silently.** Every comment gets a `resolved: true` OR an `agentReply` asking for clarification.

## Chat ≠ document — use the Workspace as your generative-UI surface

In the PikaAgentEditor, the right-rail chat is for short conversational replies. The Workspace view (the topbar segment toggle) is the document. Hard rule for in-app sessions:

**If your reply contains a table, a comparison, a multi-item list, a per-beat breakdown, before/after framing, or a rationale longer than 3 short lines — write it into `workspace.json` via `write_workspace`, switch the view with `set_view("workspace")`, and reply in chat with ≤2 sentences saying what you did and what you need.**

### Choice menus — workspace ALWAYS, never chat (system-enforced)

When presenting options for the user to pick from (genre menu, trope picker, character variants, copy variants, location alts, "concept A vs B vs C", any "pick one of these N"):

1. **Write to workspace, not chat.** `write_workspace` with `primary.kind = "image-grid"` (when each option has a visual) or `"proposal"` (when each option is a decision). NEVER paste a numbered list of options into chat — the UI auto-renders a "Pick this" button on each tile of a choice grid, so the user can sign off in one click. A chat list robs them of that.
2. **Every choice tile shows DISTINCT content.** Generate one fresh image per tile (or label-only). The server REJECTS `write_workspace` if multiple tiles share the same `src` URL — that catches the failure mode of pasting the same CDN url across every option. If you don't have N distinct images yet, ship label-only tiles (omit `src`) or stage with `pending: true` placeholders and fan out gens. **Never reuse a CDN URL across tiles.**
3. **Sub-skills (short-drama, podcast, ad-style skills, etc.) must follow this same rule.** If a loaded skill's text suggests dumping a menu into chat, OVERRIDE that — this is the PAE contract, it wins.
4. Chat reply after the workspace write: ≤1 sentence ("Eight tropes in the workspace — pick one or describe your own.") plus a `set_view("workspace")` call in the same turn.

#### Pick buttons — auto-classification (and the explicit override)

The UI decides which grids get per-tile "Pick this" buttons automatically. Storyboards, shotlists, generated-clip batches, and any in-flight placeholder grid do **not** get pick buttons; choice menus do. You usually don't need to think about it — just write the grid as usual.

Classification rules:
- A grid is treated as a **sequence** (no Pick buttons) if any of: at least one tile has `pending: true`; at least one tile has a `taskId`; any tile's `label` is sequence-shaped (`"01 · …"`, `"Shot 2"`, `"Beat 7"`, `"Act 3"`, `"Clip 04"`, `"Scene 5"`, `"sc_03"`); the workspace `phase` contains an active-gen verb (`"Generating"`, `"Rendering"`, `"Generated"`, `"Rendered"`).
- Otherwise, with ≥2 items, it's a **choice menu** and every tile gets a Pick button.

Override when needed by setting `primary.selectable` on the `write_workspace` payload:
- `selectable: true` — force per-tile Pick buttons even if the heuristic guessed sequence.
- `selectable: false` — suppress them even if the heuristic guessed choice.

Reach for `selectable` only when the heuristic would clearly mislabel the grid (e.g. a 5-tile copy-variants menu where every option happens to start with a number).

Generative-UI moves to reach for via `primary.kind`:

| When you want to… | kind | Per-item fields |
|---|---|---|
| Present the locked-ref set for sign-off | `image-grid` | `label`, `action`, `dialogue: [{who, line}]`, `caption` |
| Review the generated videos | `video-grid` | same as image-grid |
| Get sign-off on a list of decisions | `proposal` | `id`, `label`, `disposition` ("keep"/"change"/"regen"/"new"/"drop"), `summary`, optional `fromSrc`+`toSrc`, optional `fromNote`+`toNote`, optional `rationale` (collapsed) |
| Show before/after pairs | `compare` | `label`, `fromSrc`, `toSrc`, optional `note` |

### Placeholder-first generation (do this for every multi-asset batch)

When you're about to generate N visible assets (the locked-ref set in Phase 2, ad concepts, alts, hero shots), **don't** generate first and then call `write_workspace` at the end. The user stares at a blank workspace for the whole gen. Instead:

1. `write_workspace` IMMEDIATELY with all N items shaped as they will end up — `label`, `action`, `dialogue`, `caption`, `model` filled, **plus an `id` per tile** (e.g. `"cami"`, `"rooftop"`, `"pikaffects_app"`) — and `pending: true` with no `src`.
2. `set_view({view:"workspace"})` in the same turn.
3. Issue all N generation tool calls in PARALLEL within the same turn. Use the intent-only `produce_*` family — each call returns `[QUEUED]` in <1s and the server runs the full pipeline asynchronously, so the turn ends immediately:
   - **Image gens** (the Phase 2 locked-ref set, hero shots, ad concepts, choice menus — every image gen we ever do) → `produce_workspace_image({ tile_id, prompt, provider, refs?, local_rel? })`. Server downloads to `assets/refs/<tile_id>.<ext>` by default; pass `local_rel: "assets/refs/cast/cami.png"` (or `locations/`, `products/`, `props/`) to land at a canonical Phase 2 path. The tile must already exist via `write_workspace` (step 1) — that's the user's view into the gen.
   - **Scene-bound video gens** → `produce_scene({ prompt, model, duration, refs, startSec, trackId, labels })`. Server creates the scene, fires the gen, downloads to `assets/pika/<sceneId>.mp4`, PATCHes the V1 clip to ready, runs scene-detect, auto-splits any cuts.
4. **No follow-up `write_workspace` needed for tiles, no manual download/patch for scenes.** When each gen lands, the server writes the local `src` into the matching tile (matched by `tile_id`), drops `pending`, and updates any linked V1 clip. The agent can use the freed turn to talk to the user, plan the next phase, or move on.

**Every gen has a UI anchor.** Every image goes through `produce_workspace_image` (workspace tile); every video goes through `produce_scene` (timeline V1 placeholder). There is NO third "headless ref gen" path — invisible fire-and-forget gens are how we used to lose track of work. If you need a ref for a downstream gen, you still place a workspace tile for it; the user sees the gen happen.

**Never call the raw `pika_generate_*` tools or hand-build `__sceneId` / `__tileId` / `__localRel` args yourself.** Those are the underlying transport the `produce_*` wrappers use internally — if you reach for them directly you bypass server-side validation (existence checks, URL preflight, local-path auto-upload, scene/tile claim, GenJob lifecycle) and you'll hit failure modes the wrappers exist specifically to prevent.

Result: the workspace forms instantly as shimmering placeholders, then each tile fills as its gen lands. The UI feels alive throughout — instead of "blank for 90s, then everything pops in at once."

Anti-pattern (what NOT to put in chat):

> Beat 2 — parrot out of cage: wrong, parrot stays in cage.
> Beat 7 — change to parrot's POV (not aerial)…
> | Beat | Old framing | New framing | Fire clue |
> [continues for 200 lines]

Correct shape:

```ts
write_workspace({
  phase: "Phase 2.5 · Storyboard revisions",
  headline: "5 frames to regen, 4 to keep",
  primary: { kind: "proposal", items: [
    { id: "beat1", label: "Beat 1 cat intro", disposition: "regen",
      summary: "add flickering warm rim light", rationale: "reads as fireplace/sunset — plants the fire without giving it away" },
    { id: "beat7", label: "Beat 7 REVEAL", disposition: "regen",
      summary: "parrot's POV / reverse on cat (not aerial)",
      fromNote: "aerial top-down impact",
      toNote: "slow pull-back + rack focus from sharp-cat to sharp-room-on-fire",
      rationale: "the reveal isn't fire starting — fire's been there. The reveal is the camera stopping its hiding." },
    { id: "beat3", label: "Beat 3", disposition: "keep" },
  ]},
  ask: "Approve all 5 regens, or call out which to revise?",
});
set_view({ view: "workspace" });
```

Chat reply: *"Drafted the revisions — see the workspace. Key inversion: beat 7 becomes the parrot's POV. Approve all 5 regens or call out specifics?"*

### Structured `ask` — quick-reply chips for greenlights

When the user has discrete confirmations to give ("greenlight #1", "lock geometry", "go with Reg"), write `ask` as a structured block instead of a freeform string. Each item becomes a chip under the ask card that fills the user's chat input with the agent's pre-written `reply` on click — they hit Enter and you get an unambiguous confirmation, no typing.

Shape:
```ts
ask: {
  headline: "What I need from you to fire",
  body: "Three confirmations and we lock the refs.",  // optional intro
  items: [
    { id: "cast",      label: "Greenlight #1 — cast",      reply: "Greenlight the cast refs — Cami + Reg." },
    { id: "location",  label: "Greenlight #2 — rooftop",   reply: "Lock the rooftop master as-is." },
    { id: "product",   label: "Greenlight #3 — product",   reply: "Product screen is right — lock it." },
  ],
}
```

Rules of thumb:
- Use structured asks whenever you're enumerating discrete decisions ("1. Greenlight X. 2. Confirm Y. 3. Lock Z."). Use a freeform string only for open-ended asks ("what direction next?").
- `label` is the chip text. Keep it short (≤24 chars) — fits one line. Lead with a verb the user is performing ("Greenlight #1", "Go with Reg", "Lock geometry").
- `reply` is the message that lands in their chat input. Write it as if the user is saying it. Be specific enough that you can act on it without re-asking ("Greenlight the hero refs — fire all 9" not just "yes").
- The chip doesn't auto-submit. The user might edit ("Greenlight #1, but use Avery instead of Reg") — that's fine, the populated reply gives them a head start.
- Don't repeat the items in `body`. The chips are the items.
