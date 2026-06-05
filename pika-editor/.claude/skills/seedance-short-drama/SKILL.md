---
name: seedance-short-drama
description: >-
  Produce vertical short-drama episodes in the ReelShort / DramaBox / 红果短剧 / 抖音微短剧
  register using Seedance 2.0 via Pika — 60-90s episodes of 6 × 15s acts, with a series
  bible + Episode 1 as the canonical first deliverable. Triggers on: "make a short drama",
  "短剧", "vertical drama", "ReelShort-style", "DramaBox-style", "make a CEO romance",
  "Mafia Luna", "werewolf drama", "reincarnation villainess", "fated mates",
  "billionaire husband", "微短剧", "soap-opera vertical", or any request for a
  cliffhanger-driven 9:16 narrative serial. Uses Seedance 2.0's native dialogue +
  phoneme-level lipsync. Original characters only — for real-person likeness route to
  Kling v3-omni instead. Bundles a hard storyboard gate before any video generation
  to catch aesthetic drift early.
argument-hint: <premise or trope, or empty for menu>
---

# seedance-short-drama

Industrial short-drama generator. Produces a series bible + the cinematic 90-second Episode 1 (the format's "ad") on the first run; Episode 2 ships on a separate confirmation. Built around an 8-trope genre menu, a per-run CN-vs-Western register switch, and a hard storyboard gate before any video call fires.

The skill assumes the format's hard constraints — 6 × 15s acts, hook detonation at 0:00-0:03 (freeze-frame intelligible to a stranger), cliffhanger button at 0:80-0:90, 2-3 reversals per episode — are non-negotiable. Genre menu choices lock the aesthetic (palette + lighting + wardrobe + hook templates) automatically; user can still type free-form to override.

## Prerequisites

- **Pika MCP** — `generate_video` (provider: seedance), `generate_image`, `edit_concat`, `search_music`, `edit_audio_mix`, optionally `add_captions`, `upload_asset`.
- **Sub-skills** — `gpt-image-director` for cast + location refs, `storyboards` for the pre-vis gate. Reach via Skill tool, not by inlining their prompts.
- **Working folder** — `~/Downloads/<series-slug>-drama/` for assets, bible, scripts, refs, storyboards, per-act mp4s, final ep1.mp4. Bundles default to `~/Downloads` per the convention in [[feedback-video-asset-bundles-location]].

## Stage 0 — Intake (empty-args menu)

If `$ARGUMENTS` is empty or whitespace-only, print this menu verbatim and stop — do not call any tool.

> **Let's build your short drama.** Pick one path and answer in any format:
>
> **1. Pick a trope** (auto-loads palette / lighting / wardrobe / hook templates):
>   - **CEO Romance / 霸总** — penthouse glass-and-marble, teal-and-orange, high-key window light
>   - **Mafia Luna / Werewolf Alpha** — wet pine forest, teal moon-key + bonfire fill, leather + henley
>   - **Reincarnated Villainess / 重生** — candle-lit Victorian or 古装 interiors, crimson + ochre + black
>   - **Hidden Heir / 赘婿** — mocked janitor / live-in son-in-law reveal arc, dual-register (mocked vs powerful)
>   - **Contract Marriage / 契约婚** — corner office, signed-paper inserts, cold tailoring
>   - **Revenge Wife / 复仇** — public face-slap (打脸) build-up, post-revenge cool grade
>   - **Vampiric Husband** — gothic interiors, single-candle key, fangs reveal at Ep1 button
>   - **Fated Mates Rejection** — pack ritual interrupted, moon-rim on betrayal, primal sound design
>
> **2. Or describe your own premise** — one sentence, present tense, contains the wound + the reveal hook.
>
> **3. Tell me the register** — CN 短剧 (louder color, faster cuts, more reversals) or Western ReelShort (CW-pilot energy, slightly more naturalistic). Default: Western if dialogue is English, CN if Mandarin.
>
> **4. Cast photos (optional but recommended)** — paste 1-3 reference images per main character. Without them I'll generate originals via gpt-image-2. Real-person likeness for named dialogue routes to Kling-omni instead of Seedance, see [[reference-nba-cutaway-engine]].
>
> **5. Aspect** — 9:16 default (locked for the genre). Override to 16:9 / 1:1 only if you have a specific reason.

Save inputs as `state.trope`, `state.premise`, `state.register` (cn | western), `state.cast_refs[]`, `state.aspect`. Proceed to Stage 1.

## Stage 1 — Series bible

Write `<series-slug>/bible.md` with these sections, in this order:

1. **Title** — < 7 words, contains the genre marker (CEO / Luna / Reborn / etc.).
2. **Tagline / hook line** — 7-12 words, present tense, names the betrayal or reveal. This line is the Ep 1 cold-open spoken hook (load-bearing).
3. **Logline** — `When [protagonist with wound] is [inciting betrayal], she [first action] — only to discover [hidden truth that powers the series].`
4. **Genre + register** — `state.trope` + `state.register`.
5. **Comps** — one CN show + one Western show ("X meets Y").
6. **World rules** — bulleted: identity rules, power rules, marriage rules, money rules. Trope-specific (werewolf pack hierarchy, reincarnation memory carry, CEO public-vs-private dual identity).
7. **Cast (3-5)** — for each: archetype, wound, want, secret, arc across 5 blocks. Include the trope's required archetypes from the table below.
8. **Season spine (80 ep default)** — one line per episode, each ending in a cliffhanger phrase. Split into 5 blocks.
9. **Paywall map** — tier-1 cliffhanger at Ep 10 (identity reveal class), tier-2 at Ep 30 (midpoint reversal), tier-3 at Ep 60 (darkest hour). [[reference-short-drama-paywall-structure]] — Ep 8-12 is the conversion zone.

Required archetypes by trope (Ep-1 jobs they each must do):

| Archetype | Ep-1 job |
|---|---|
| Scorned Heroine / 大女主 | Get publicly betrayed in first 30s; end Ep 1 with first flicker of agency |
| Cold CEO / 霸总 | Enter as savior/buyer/husband; one cold line; hint at hidden status |
| Scheming Mistress / 白莲花 | Smirk on camera once; deliver the cruel line that earns audience hatred |
| Supportive Bestie | Validate heroine, supply exposition, survive whole season |
| Evil Mother-in-Law | Cast public doubt on heroine; slap, money-on-table, "you'll never be one of us" |
| Mysterious Benefactor / Hidden Alpha | Appear at heroine's lowest moment, refuse to explain |

Save bible path as `state.bible_path`. Ask the user to approve before proceeding to Stage 2.

## Stage 2 — Episode 1 script (6 × 15s beat sheet)

Episode 1 IS the ad — it front-loads the entire pitch and ends on the biggest hook of Block 1. No subplot, no B-story, no decompression. Every beat is the headline.

Write `<series-slug>/ep1-script.md` with the canonical 6-act beat sheet:

| Act | Window | Beat | Required content |
|---|---|---|---|
| 1 | 0:00–0:15 | Hook detonation | Cold open mid-action. Freeze-frame at 0:03 readable by a stranger. Spoken hook line (from bible). Inciting betrayal lands on camera by 0:10. |
| 2 | 0:15–0:30 | Public humiliation | Antagonist delivers cruel line. Heroine socially destroyed. End: heroine alone, broken, in frame. |
| 3 | 0:30–0:45 | Secret-identity male lead enters | Cold CEO / Hidden Alpha / Benefactor enters. One cold line. Hint at hidden status (luxury watch, deferential bow from stranger, half-second of real face). |
| 4 | 0:45–0:60 | The transaction | Contract / marriage offer / pack-mark proposed and accepted under duress. Heroine signs. Antagonist witnesses, smirks. |
| 5 | 0:60–0:75 | Mini-reveal turn | Heroine learns one small thing about him she shouldn't (name / scar / photo). Antagonist starts to suspect. |
| 6 | 0:75–0:90 | Cliffhanger button | Someone calls him "Mr. Chairman" / "Alpha" / "Your Highness". Freeze-frame 0:85-0:88 on heroine's stunned face OR antagonist's terrified face. Cut to black before the line lands. |

For each act write:
- **Dialogue** — 6-10 lines per act, average 5-10 words, declarative present-tense. Use the inline `<<<voice_1>>>line</voice_1>>>` / `<<<voice_2>>>line</voice_2>>>` token format (same grammar as `pika:podcast`). Native dialogue + lipsync land per [[reference-seedance-2-native-audio]] — no separate VO chain needed for original characters.
- **Action / blocking** — 3 time-coded sub-shots inside the 15s (e.g. `0-5s: ECU hand sliding contract; 5-10s: MCU heroine reading; 10-15s: OTS over CEO's shoulder, push-in on his eyes`). Three sub-shots per act because a single sustained 15s clip frozen-clips on Seedance — pattern proven in `founder-product-video`.
- **Register-specific cues** — pull from §"Register diff" below. CN register: louder stinger, faster cuts, brighter saturation. Western: longer holds, more naturalistic blocking.

Save path as `state.ep1_script_path`. Ask the user to approve before proceeding.

## Stage 3 — Character + location reference images

Reach for the `/gpt-image-director` skill to generate locked references — DO NOT default to `mcp__pika__generate_image` without routing it through the director first (provider routing differs).

Per main character, generate a **character pack**: front portrait, 3/4 turn, full-body, and 3-4 expressions (calm / shocked / scoffing / tearful). Lock wardrobe + hair + age implicitly via the image itself, not via verbose text descriptions — text-described features drift, per [[feedback-gemini-character-lock]]. Save each image URL to `state.refs.<char>.{front, 3q, full, expr_calm, expr_shocked, ...}`.

Per location, generate a **location master** at golden hour or the trope's signature lighting (e.g. moonlit forest for Luna, glass-and-marble penthouse for CEO). Save as `state.refs.locations.<name>`.

Negotiation rule: if `state.cast_refs` already contains user-supplied real-person photos AND any character has named dialogue, warn the user that Seedance may 422 on `partner_validation` (per [[feedback-nba-cutaway-engine]]) and offer to (a) stylize the portrait through gpt-image-2 first, or (b) route the named-dialogue acts through Kling v3-omni instead.

## Stage 4 — Storyboard gate (hard)

Reach for the `/storyboards` skill to render a 6-frame storyboard grid for Episode 1, one frame per act, captioned with the act's spoken hook line. Pass it the script from `state.ep1_script_path` and the refs from `state.refs.*`.

Save the grid as `state.storyboard_path` and **ask the user to approve before any Seedance video call fires**. This gate exists because per-act Seedance generation is the cost-heavy stage and aesthetic misses caught here save 6+ regenerations downstream.

If the user rejects the storyboard, loop back to Stage 2 (script revisions) or Stage 3 (ref revisions), not Stage 4 alone.

## Stage 5 — Per-act Seedance generation

For each of the 6 acts, call `mcp__pika__generate_video` with:

```
provider: seedance
mode: image_to_video
image: <storyboard frame for this act, or character-in-location composite>
reference_images: [character refs for everyone in the act, plus location master]
aspect_ratio: 9:16 (from state.aspect)
resolution: 1080p
duration: 15
sound: true
voice_ids: [<cloned voice ids if applicable>]
seed: 101 + act_index  (101, 202, 303, 404, 505, 606 — unique per act to avoid the idempotency-cache trap per reference-pika-mcp-quirks #1)
prompt_adherence: strict
prompt: <see below>
```

Per-act prompt structure (each act = a single prompt, not 6 micro-prompts):

```
[Open] In a setting whose visual style, palette, lighting and materials match @Image_location.
       Same character, consistent wardrobe, unchanged hair — @Image_char1 [, @Image_char2].
[Sub-shot 1, 0-5s] <ECU/MCU framing> + <action beat 1> + <dialogue line 1 if any>.
[Sub-shot 2, 5-10s] Hard cut. <new framing> + <action beat 2> + <dialogue lines>.
[Sub-shot 3, 10-15s] Hard cut. <new framing> + <action beat 3 / button> + <closing dialogue if any>.

Lighting: <trope-specific lighting from §Genre playbook>.
Color grade: <trope-specific grade>.
Camera: <move + lens + DOF>.
Performance: <heightened register cues — single tear, scoff-laugh, wrist-grab, chin-down stare>.
Sound: <trailer-string stab / sub-drop / K-drama piano / lo-fi trap — see §Music> + diegetic stingers.

<<<voice_1>>>line A</voice_1>>>
<<<voice_2>>>line B</voice_2>>>
```

The phrase **"Same character, consistent wardrobe, unchanged hair — @Image_char1"** is load-bearing — without it character identity drifts by act 4 and ~92% of viewers churn on visible character drift (industry stat, source untraceable but widely repeated).

Stagger the 6 act calls by ~200ms to avoid Vercel 403 "Security Checkpoint" on burst. Each call exceeds the 260s inline budget and returns `{task_id, status: "running"}` — tight-loop `task_status` until complete (no Bash sleep, no parallel-claude per [[reference-pika-mcp-quirks]]).

Save each completed mp4 URL as `state.acts[1..6]`. Download each to `~/Downloads/<series-slug>-drama/acts/act_<n>.mp4` per [[feedback-media-display-workflow]].

## Stage 6 — Assembly

1. **Concat** — `edit_concat` of `state.acts[1..6]` in order. Watch the ~50 MB output cap (per [[reference-pika-mcp-quirks]] #6); if it errors, fallback to local ffmpeg: `ffmpeg -f concat -safe 0 -i list.txt -c:v libx264 -crf 23 -c:a aac -ar 44100 -ac 2 -b:a 192k out.mp4` then `upload_asset`.
2. **Music bed (optional)** — `search_music` for "K-drama piano" (tender register) / "trailer strings" (CEO/cliffhanger) / "trap lo-fi" (modern CEO montage) / "epic cinematic stinger" (Luna entrance). Then `edit_audio_mix` at low gain (~0.10-0.15) AFTER concat so the bed spans body + outro.
3. **Captions** — default **skip**. Whisper mistranscribes character names + trope vocabulary (vampire, Luna, alpha, 重生). If the user explicitly wants captions, drop to local `faster-whisper` with `word_timestamps=True` + manual replacement + curly `’` apostrophes before drawtext (straight `'` breaks the ffmpeg filter chain per [[reference-pika-mcp-quirks]] #5).
4. **Deliver** — `<series-slug>/bible.md` + `<series-slug>/ep1.mp4` + the storyboard grid. Show the user the final mp4 path so they can review.

After delivery, offer Episode 2 as a separate run (not auto-executed). Ep 2's beat sheet differs structurally — see §Episode 2 differences below.

## Stage 7 — Episode 2 (separate confirmation)

Only fire after Ep 1 is delivered AND the user explicitly asks for Ep 2. Ep 2 is **decompression + world** — it re-hooks at the front with a 3s flashback of Ep 1's freeze-frame, resolves the held question, then starts introducing the bestie, antagonist's full plan, and one explicit world rule.

| Act | Window | Beat |
|---|---|---|
| 1 | 0:00–0:15 | Recap hook → resolution of Ep 1 button. Quieter spoken hook. |
| 2 | 0:15–0:30 | Decompression / world rule. ONE rule delivered through action ("no one enters the east wing"). |
| 3 | 0:30–0:45 | Bestie / ally introduced. Heroine confides one fear. |
| 4 | 0:45–0:60 | Antagonist's counter-move — smaller scale than Ep 1, but PERSONAL. |
| 5 | 0:60–0:75 | First real two-shot with male lead. He almost reveals something, pulls back. Held glance in Western register; cut on his line in CN register. |
| 6 | 0:75–0:90 | Personal cliffhanger. Smaller stakes than Ep 1, more emotional (text from the dead / photo of him with the antagonist / her own reflection looking different). Cut on the question. |

Re-use the cast + location refs from Stage 3 verbatim — that's the load-bearing continuity device across episodes.

## Genre playbook

Each trope ships a default palette + lighting + wardrobe + sound + hook template. The Stage 0 trope pick selects one of these as the body register; the script and Seedance prompts inherit it.

### CEO Romance / 霸总
- **Palette**: teal-and-orange, skin pushed warm, deep cyan in shadows, glossy soap-opera lift.
- **Lighting**: high-key window key + hard amber rim, cool 5600K daylight bouncing off marble, soft fill.
- **Wardrobe**: tailored charcoal suit no tie (CEO), Patek-style watch, white silk blouse + nude pencil skirt (heroine).
- **Set**: glass-and-marble penthouse office at golden hour or after-hours.
- **Sound**: trailer-string stab on reveal, lo-fi trap under modern montage.
- **Hook template**: "Sign the divorce papers, Mrs. [Lin]" / "She didn't know the man she just married was…"

### Mafia Luna / Werewolf Alpha
- **Palette**: cool teal + warm amber bonfire fill + black leather.
- **Lighting**: moonlit forest, teal moon-key + bonfire warm fill, hard rim through pines, light fog.
- **Wardrobe**: black leather jacket + white henley, exposed clavicle (Alpha); torn dress or pack robe (Luna).
- **Set**: wet pine forest at night, full moon plate, smoke machine atmospheric haze.
- **Sound**: deep sub-bass on Alpha entrance, primal stingers, throaty growl-register VO.
- **Hook template**: "You're my mate, and I will kill anyone who touches you."

### Reincarnated Villainess / 重生
- **Palette**: deep crimson + ochre + black; "oppressive" pre-revenge grade, cool grade post-turn.
- **Lighting**: candle-lit Victorian or Republican-era interior, tungsten 2700K practicals, low ambient, smoke haze.
- **Wardrobe**: Republican-era qipao with mourning veil, silk hanfu, corseted Victorian gown.
- **Set**: lacquer-red interior, candle practicals.
- **Sound**: kick-and-tick suspense pattern with rhythm landing on the twist beat.
- **Hook template**: "She woke up in the body of the villainess — and her execution was tomorrow."

### Hidden Heir / 赘婿 (Live-in Son-in-Law / Janitor Reveal)
- **Palette**: dual-register — desaturated muted for the "mocked" half, high-contrast saturated for the "powerful" reveal.
- **Lighting**: flat institutional fluorescent (mocked) → low-key dramatic with rim (powerful).
- **Wardrobe**: rumpled uniform (mocked) → tailored bespoke under coat (revealed).
- **Hook template**: "They mocked the live-in son-in-law for ten years. They didn't know he was the supreme [title]."
- **Note**: 男频 dominant; localize to ReelShort EN with care — the "live-in god" framing weakens in Western registers.

### Contract Marriage / 契约婚
- **Palette**: cool corporate cyan + warm accent on the contract itself.
- **Lighting**: corner office at dusk, single window key, hard top-light for the signing beat.
- **Wardrobe**: pencil skirt + nude heel + hair up.
- **Set**: glass corner office, contract slid across desk.
- **Hook template**: "Sign the contract, or your father dies."

### Revenge Wife / 复仇
- **Palette**: muted pre-revenge, saturated post-revenge.
- **Lighting**: harsh top-light on betrayal, soft window light on the strategic build, hard rim on the public face-slap.
- **Sound**: silence-to-impact on the slap; trailer stab on the reveal.
- **Hook template**: "She died at his hands. She woke up three years before he killed her."

### Vampiric Husband
- **Palette**: gothic black + deep wine red + candle gold.
- **Lighting**: single candle key, hard shadow drama, blue moon-rim on the fang reveal.
- **Wardrobe**: high-collar dark coat (vampire), nightgown or wedding dress (heroine).
- **Hook template**: "She married a man who never showed his face — until the night she saw his fangs."

### Fated Mates Rejection
- **Palette**: cool blue night + warm pack-fire ember.
- **Lighting**: hard moon-rim on betrayal, fire-flicker on the rejection line, hand-held during chase.
- **Sound**: primal stinger on the mark, deep sub on the pack growl.
- **Hook template**: "He was the Alpha. She was his fated mate. And on the night of the moon, he chose another."

## Register diff (CN 短剧 vs Western ReelShort)

| Dimension | CN 短剧 | Western ReelShort |
|---|---|---|
| Color | Louder saturation push, redder skin, deeper teal night | CW-pilot clean skin tones, less aggressive saturation, more lens-flare/haze |
| Cuts per minute (hook block) | 25-30 (≈2s avg shot) | 18-25 (slightly longer holds) |
| Dialogue delivery | Louder, eyes wider, slap harder — heightened to telenovela | American-soap naturalism — melodrama in writing not voice |
| Sound design stingers | Louder, more obvious, anime-grade whooshes | Subtler trailer-strings, restrained |
| Face-slap density | 2-3× per episode in paywall block | 1 per 3 episodes tolerable |
| Wardrobe | Glossier, sharper CEO suits; ornate 古装 | Rumpled tailored billionaire; "Bridgerton-budget" Victorian |
| Tropes excluded | — | 赘婿 / 战神 / cultivation / 宫斗 don't land in EN |
| Tropes excluded | mafia / vampire / small-town-vs-big-city land weaker | — |

The skill applies the register switch at Stage 2 (script — pace + dialogue delivery cues) and Stage 5 (Seedance prompt — color grade + cut count + stinger callouts).

## Episode 2 differences

Already encoded in Stage 7's beat sheet — calling out the structural diff for reference:

- Ep 1 = the ad. Front-loads the entire pitch, no decompression, biggest hook button.
- Ep 2 = decompression + world. Re-hooks at the front (3s recap flashback), introduces world rules + bestie, smaller-but-more-personal cliffhanger.
- Cast + location refs are reused verbatim — character drift across episodes is the binge-killer.

## Load-bearing phrases

These phrases anchor empirical Seedance behavior. Strip them and quality collapses.

- **"Same character, consistent wardrobe, unchanged hair — @Image_char1"** (Stage 5 prompt opener) — Chinese tutorials' standard character-lock clause; without it identity drifts by act 4. Verbatim ZH equivalent: **"同一角色，服装一致，发型不变"**.
- **"In a setting whose visual style, palette, lighting and materials match @Image_location"** (Stage 5 location grammar) — locks aesthetic without pinning the literal scene, so each act can vary background (wall / window / feature) without re-using the same composition. Per the `founder-product-video` background lesson.
- **"Hard cut."** between sub-shots inside a 15s act — without explicit hard-cut markers Seedance interprets the 15s as a single continuous shot and frozen-clips on the founder.
- **"Cut on the question, not the answer, two seconds earlier than feels safe."** (Stage 2 act-6 spec) — Real-Reel's beat-engine rule; freeze-frame at 0:85-0:88 maximizes paywall conversion.
- **Stage 0 trope-name spoken aloud** (e.g. "Mafia Luna" / "霸总") — the trope label primes the entire register downstream; don't paraphrase it.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Identity drifts visibly by act 4 | Character-lock clause dropped, or different ref image per act | Repeat the verbatim lock line in every act prompt; reuse the SAME `@Image_char1` URL across all 6 acts |
| Heroine "pose-flips" — facing right in act 2, facing left in act 3 (audience disorientation) | Implicit 180° line violation | State facing direction explicitly per shot ("character A frame-left facing right"). Honor `seedance-director`'s 180° rule |
| 15s clip is a single sustained shot, character barely moves ("frozen-founder") | Prompt is one continuous instruction, not 3 time-coded sub-shots | Decompose every act into 3 sub-shots with explicit "Hard cut." markers between them |
| `partner_validation` 422 on a named-character act | Seedance content-policy blocks real-person likeness + named dialogue | Stylize portrait via gpt-image-2 first (Pixar-3D), OR route the act through Kling v3-omni per [[feedback-nba-cutaway-engine]] |
| Two identical act prompts return the same task_id and replay a cached failure (ghost 402 billing error) | Pika MCP idempotency cache hashes identical params | Per-act unique `seed` is mandatory — 101/202/303/404/505/606 pattern |
| `edit_concat` returns 50 MB cap error on 6×15s 1080p | Concat output budget exceeded | Fallback to local ffmpeg `-c:v libx264 -crf 23 -c:a aac -ar 44100 -ac 2 -b:a 192k` then `upload_asset` |
| `ffmpeg concat -c copy` silently drops act 2's dialogue | Different audio sample rate / channel count across acts | Re-encode all inputs to `aac 44100 stereo 192k` before concat; verify with `ffprobe` |
| Captions mistranscribe "Luna", "Mafia", character names | Whisper has no domain prior | Skip captions by default (matches `pika:podcast` precedent); if forced, use `faster-whisper` + manual fix + curly apostrophes |
| Vercel 403 "Security Checkpoint" on burst | All 6 acts fired in tight parallel | Stagger by ~200ms between calls |
| Seedance returns a stylization-drift clip (photo ref → slightly cartoonish output) | Prose includes aesthetic adjectives that fight the reference image | If `@Image_char1` is photoreal, the prose must NOT say "Pixar" / "anime" / "stylized" |
| Storyboard frame doesn't match the script's emotional beat | `gpt-image-director` got too little context | Loop back to Stage 3 and pass the full act-N script line + dialogue + emotional cue, not just the location + character |

## Engine choice: Seedance 2.0 (with caveats)

**Why Seedance**: native joint video + dialogue + lipsync + SFX in one pass for 8+ languages ([[reference-seedance-2-native-audio]]) — collapses the per-act VO+lipsync chain that the older `silent-Seedance` assumption would have forced. Plus multi-shot stitching within a single ≤15s call, plus multi-modal reference (`@Image1`-style binding) for character identity lock. Cinematic motion + lighting register matches the duanju visual grammar; CN trade press 2026 names Seedance + Kling-Omni as the two production-grade short-drama engines.

**When to route elsewhere**:
- **Real-person likeness + named dialogue** → Kling v3-omni. Seedance 422s on `partner_validation` here, per [[feedback-nba-cutaway-engine]]. Pattern: NBA cutaway, parody of public figure, "Trump in a romance drama" — all Kling-omni territory.
- **Pure two-host static talking-head dialogue** → `pika:podcast` skill is already optimized for this and uses Kling-omni's shared-audio-timeline multi-shot.
- **48kHz audio mastering** → Veo 3.1 still edges Seedance on audio fidelity; only matters for music-bed-driven episodes where you don't post-mix in `edit_audio_mix`.

**Per-call hard limits** (don't promise users beyond these):
- Duration cap: 15s per call. 60-90s episodes are batched at 4-6 calls; there is no 60s single-call generation.
- Resolution: 1080p via the Pika MCP enum. Seedance's native 2K is not exposed via Pika as of 2026-06-03 — verify before claiming 2K output.
- Aspect: 9:16 fully supported (no degradation vs 16:9).

## Runtime expectations

Per Episode 1 (Bible + 6 acts + concat + delivery), at production quality:

| Stage | Wall-clock estimate | Notes |
|---|---|---|
| Stage 1 (bible) | 3-5 min | Mostly Claude writing |
| Stage 2 (script) | 4-6 min | Claude writing, sub-shot decomposition |
| Stage 3 (refs) | 6-10 min | ~5-8 gpt-image-2 calls × ~30-60s each, parallelizable |
| Stage 4 (storyboard) | 2-4 min | One `storyboards` skill run |
| Stage 5 (Seedance acts) | 12-25 min | 6 acts × ~3-5 min each (staggered 200ms, polled to completion), parallelizable up to Vercel throttle |
| Stage 6 (assembly) | 2-4 min | Concat + optional music + delivery |
| **Total Ep 1** | **~30-50 min** | First-time runs land at the long end; iteration runs at the short end |

Ep 2 reuses Stage 3 refs, so it lands ~20-35 min. A full series (80 ep) is NOT in scope of one run — this skill ships Ep 1 alone by default, Ep 2 on confirmation.

## What NOT to do

- **Don't generate any Seedance call before the storyboard gate passes.** Aesthetic misses caught at storyboard cost ~$0; the same miss caught after 6 act gens costs ~6 regen cycles.
- **Don't paraphrase the character-lock line.** "Maintain character consistency" doesn't work the way the verbatim "Same character, consistent wardrobe, unchanged hair — @Image_char1" does. Per [[feedback-gemini-character-lock]].
- **Don't describe character features in text** (hair color, age, eye color) — pass the image and let it carry. Text descriptions cause drift.
- **Don't auto-fire Episode 2** after Ep 1 delivery. Wait for explicit user request. Many series fail Ep 1 review; firing Ep 2 burns budget.
- **Don't add Captions by default.** Whisper mistranscribes the genre's vocabulary; the audience can hear the dialogue. Match `pika:podcast`.
- **Don't promise a single-call 60s episode.** Seedance hard-caps at 15s. The pipeline batches.
- **Don't blend CN + Western registers.** The dialect difference is real and viewers in each market can tell. Pick one per series.
- **Don't add brand color from a brand-kit folder.** This skill is brand-agnostic narrative — there is no brand here. (Unrelated to the `pika-design` family.)
- **Don't run all 6 acts in tight parallel.** Vercel 403 throttle hits. Stagger ~200ms.
- **Don't rewrite the seedance-cinematic / seedance-brand-story skills.** They're scoped to single-clip prompt rewriting; this skill is end-to-end multi-act assembly. They coexist.
