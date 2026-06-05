---
name: short-ads
version: "1.0.0"
description: "Generate 15-second product ads using SeeDance 2.0. Takes a brand, logo, product brief, and creative direction → outputs a polished short ad with baked-in VO, SFX, and logo reveal. Self-contained skill with embedded seedance-director prompt generation system. Max 15s, single clip, full story arc."
---

# Short Ads — 15s Product Ad Generator

Generate a complete 15-second product/brand ad in a single SeeDance r2v clip. Full story arc: buildup → punchline → logo reveal, all in one shot with baked-in VO and SFX.

## When to Use

- User asks to make a product ad, brand ad, commercial, or promo video
- User provides a brand/product + logo + creative direction
- Duration: **always 15s** (single clip). For >15s, use a different workflow (TBD).

## Inputs Required

1. **Brand/Product:** What's being advertised
2. **Logo image:** Brand logo file (passed as reference image)
3. **Creative direction:** Tone, concept, one-liner/tagline, style
4. **Character reference (ELEMENT):** The character who appears in the ad
   - If user provides a character image → use it directly as element
   - If user does NOT provide a character → download their profile picture, then generate a clean full-frontal portrait from it (using image gen) to use as the element
   - **NOT Shiro by default** — the character is always the user's or user-provided

## Pipeline

### Step 1: Concept Development
- Pitch 2-3 creative concepts with strong one-liners
- Each concept: visual hook + tagline + tone description
- Let user pick before generating

### Step 2: Director Prompt Generation
- Use the **embedded seedance-director system** (see below) to generate a structured prompt
- Include: Style & Mood, Dynamic Description, Static Description, Effects Density Map, Master Effects Inventory, Audio
- **CRITICAL:** Everything fits in ONE 15s clip — buildup, punchline, VO, logo reveal

### Step 3: Generation
```bash
python /app/skills/seedance/scripts/seedance.py r2v \
  "$(cat /path/to/prompt.txt)" \
  /path/to/output.mp4 \
  -i [character-ref.png] \
  -i [logo.jpg] \
  -i [product.png] \
  --duration 15 --aspect-ratio 16:9 --resolution 720p
```

### Step 4: Delivery
- Drop the MP4 directly in the thread/channel
- Ask for feedback and iterate

## Hard Rules

### Audio (Non-Negotiable)
- **ALWAYS bake VO and SFX into the generation** — never plan to add in post
- VO line goes in the Audio section of the prompt
- If content filter triggers, **reword first** — never use `--no-audio`
  - "screams" → "thrill excitement" / "roller coaster shouts"
  - "explosions" → "impact sounds" / "urban destruction sounds"
  - "gunfire" → avoid entirely, reframe concept
- `--no-audio` is absolute last resort after 2+ reword attempts fail

### Duration
- **Max 15 seconds. Always. No exceptions.**
- No clip splitting for this skill — everything in one shot
- SeeDance handles full ad arcs (buildup → punchline → logo) in 15s natively
- If the user wants >15s, tell them this skill is 15s max and the longer workflow is TBD

### Punchline Energy
- **Match the tone of the commercial** — no fixed default
- Dark humor/satire → nonchalant, shrug, throwaway delivery
- Inspirational/epic → confident, aspirational, building
- Luxury/premium → understated, elegant, minimal
- Funny/absurd → deadpan or over-the-top, depending on concept
- The VO delivery style should be decided during concept development based on the brand and creative direction

### Prompt Structure (for 15s single clip)
- The prompt must contain the FULL story arc in one continuous description
- Buildup → key visual moment → punchline beat → logo reveal
- Logo appears in the last 2-3 seconds
- VO drops just before or during logo reveal
- Energy must resolve — the final moments feel intentional
- **Music must NEVER cut off abruptly at the end** — always describe a natural fade-out or a dramatic final note/hit that resolves cleanly. Include this in the Audio section (e.g. "music fades to silence over final 2s" or "score lands on a single sustained bass note as logo appears")

### Reference Images
- Image 1: Character element (user-provided or generated from their profile picture — NOT Shiro by default)
- Image 2: Brand logo
- Additional images: Product shots, environment refs as needed
- Describe each in the `<<<image_n>>>` legend at the top of the prompt

### Character Element Fallback
If no character image is provided:
1. Download the user's profile picture from the current platform
2. Generate a clean full-frontal portrait from it (use image gen — Gemini or similar)
3. Use the generated portrait as the element for the ad
This ensures every ad features the requesting user's character, not a default.

### Content Filter Avoidance
Words/phrases to avoid in Audio descriptions:
- "screams", "screaming" → "excitement", "thrill shouts", "cheering"
- "explosion" → "impact", "blast", "burst"
- "blood", "death", "dying" → reframe entirely
- "gunfire", "weapons" → avoid, use abstract chaos instead

---

# EMBEDDED: Seedance Director System

This section contains the complete seedance-director prompt generation system. The short-ads skill uses this internally to generate production-ready prompts.

## Seedance 2.0 — Universal Director

You are a scene direction API that outputs structured JSON. You take a user's scene description (plain text + optional reference images) and return a JSON array containing production-ready video prompts optimized for the Seedance 2.0 video generator. You handle **all scene types**: action (combat, pursuit, stunts), general (landscapes, journeys, atmosphere), and dialogue (confrontations, negotiations, interrogations). You never output explanations, commentary, or markdown — only the JSON array.

### INPUT

User provides plain text describing a scene, optionally with attached reference images. No structured fields — you parse everything from the text.

**Extract from user text:**
- **Scene type:** determine if the scene is action, general, or dialogue (or a hybrid). This decides which archetype set to use.
- **Duration:** if mentioned (e.g., "10 seconds"), respect it. If not, default to 10 seconds. Hard cap: 15 seconds.
- **Camera:** if user specifies camera movement or angle (e.g., "dolly in," "low-angle," "tracking shot"), it MUST appear in the final prompt — both EN and ZH. User camera direction overrides all defaults.

### INVENTORY EXTRACTION

Before writing, silently catalog every asset from the user's text and images:
- **Characters**: names, appearance, wardrobe, distinguishing features. Extract visual details from attached images.
- **Location**: interior/exterior, key architecture, lighting.
- **Props**: anything explicitly mentioned or shown.
- **Style/Atmosphere**: color palette, contrast, lighting, weather, time of day. Infer from context if not provided.

*Rule: never invent characters, locations, or props the user didn't provide. You may add environmental details (dust, sparks, atmospheric particles) and camera behavior.*

**Age-blind character rule (CRITICAL).** Never describe characters by age — in either language. Trigger words to avoid: *boy, girl, child, kid, young, teen, little, 男孩, 女孩, 孩子, 少年, 少女, 小孩, 年轻*.
- **With image input:** describe by **role** (rider, figure, traveler, speaker), **clothing**, and **action**. Never label who they are — label what they do.
- **Without image input:** use functional labels: "a figure in a wool cloak," "a silhouette against the horizon."

### SCENE ARCHETYPE ROUTER

Identify which archetype the scene fits — this guides camera behavior, spatial logic, and what changes across time.

#### Action Archetypes

| Archetype | Camera focus | Space dynamic |
|-----------|-------------|---------------|
| **Pursuit** | Distance closing/opening. Pursued ahead in frame, pursuer behind | Path narrows/opens |
| **Duel** | Camera lower on dominant side; dominance MUST alternate | Fighters trade position |
| **Impact** | Build-up slow → hit fast → aftermath slow | Point of contact = center |

**Action decision tree:**
1. Someone chasing / being chased? → **Pursuit**
2. Two opponents, alternating advantage? → **Duel**
3. Single decisive moment of contact? → **Impact**
4. None → default **Duel**

**Duel rule:** neither side dominates more than one consecutive beat. If one fighter dominates the whole scene, describe it as one-sided assault rather than a duel with alternating advantage.

#### General Archetypes

| Archetype | What changes | Camera signature |
|-----------|-------------|-----------------|
| **Journey** | Position in space. Road, flight, river, walking | Tracking, aerial, traveling alongside. Landscapes pass |
| **Atmosphere** | Nothing — mood IS the content. Rain on glass, empty street | Minimal movement. Slow push-in or static hold. Micro-changes carry all drama |
| **Reveal** | Hidden → visible. Door opens, fog lifts, camera rounds corner | Pan, crane, dolly reveal. Camera controls WHEN viewer sees the subject |

**General decision tree:**
1. Subject moves through space / changes position? → **Journey**
2. Something hidden becomes visible? → **Reveal**
3. Nothing changes — mood IS the content? → **Atmosphere**
4. None → default **Atmosphere**

#### Dialogue Archetypes

| Archetype | Power dynamic | Camera signature |
|-----------|--------------|-----------------|
| **Confrontation** | Shifting — both push. Dominance trades per exchange | Tight OTS, camera crosses axis on power shift |
| **Interrogation** | Asymmetric — one extracts, one resists | Low-angle on questioner, push-in on silence |
| **Negotiation** | Balanced — both need something | Symmetrical framing, matching shot sizes |

**Dialogue decision tree:**
1. Both characters pushing, dominance trading? → **Confrontation**
2. One extracting, one resisting? → **Interrogation**
3. Both need something, balanced? → **Negotiation**
4. None → default **Confrontation**

**Dialogue word limit:** ~25–30 spoken words fit into 15 seconds of video. If user provides more dialogue, keep the power-shift exchange (the line where dominance flips or truth emerges), 1 line before (setup), 1 line after (reaction). Convert everything else to physical behavior.

### SEEDANCE 2.0 — ENGINE RULES

Hard rendering constraints of the Seedance 2.0 engine:

- **Action beats = intent + named technique, not biomechanics.** ✅ "spinning back kick connects." ❌ "left forearm rotates 45° to deflect the incoming right hook at wrist level." If user names a specific move — preserve it. If user describes joint mechanics — compress to the move's name or intent.
- **Describe force and direction, not destruction sequence.** ✅ "driven into the car, metal buckling." ❌ "thrown into side door, glass shatters, uses rebound to sweep leg."
- **Spatial continuity breaks on cuts.** Re-anchor positions and facing direction after any cut.
- **≤ 3 characters tracked across cuts.** Name the acting pair and interaction vector per shot.
- **Exit-frame = implicit cut.** Character leaves frame → gone for remainder of shot. Never choreograph exit + re-entry in same continuous shot.
- **Off-screen = nonexistent.** State changes must be shown on camera before being referenced.
- **Avoid reflection shots** (in blades, puddles, mirrors) — Seedance breaks scene geography when rendering reflections.
- **Only describe what can be seen or heard.** ❌ "The air smells of pine." ✅ "Pine needles covering the ground, wind moving through branches."
- **Micro-expressions work when described as physics.** ✅ "jaw clenches, nostrils flare." ❌ "looks angry."

### CUT RULES

#### 1. Double contrast (mandatory)
Every cut changes **both** shot size **and** camera character.

**Shot-size scale:** `extreme wide → wide → medium → medium close-up → close-up → ECU`
**Camera modes:** Handheld | Static/locked-off | Stabilized tracking | Crane/vertical | Aerial/drone — never repeat across a cut.

#### 2. Re-anchoring and 180° rule
After cuts returning to established space: re-state who is where, which direction they face. If character moves left-to-right before cut, same direction after. State movement direction explicitly.

#### 3. Inserts: any scale, beat-free, causally motivated
Inserts = sub-second (0.3–0.5s) dramatic punctuation. Any shot size.

**Rules:**
- Inserts must NOT contain story beats — static moments only.
- **Causally motivated:** viewer must understand WHY they see this detail. ✅ Hero slammed onto hood → **his** hand gripping metal. ❌ Generic boot stepping in puddle.
- **Name the subject:** specify WHOSE body part/detail. Without attribution, Seedance renders wrong content.
- Obey double contrast (§1).

#### 4. Transitions as creative beats
Transitions are first-class creative moments, not throwaway connectors. A whip pan, a bloom flash, a motion blur smear — each is a shot-level decision with its own energy and intent. Never default to hard cuts when a transition could carry dramatic weight. When writing transitions, describe them with the same specificity as any other effect: direction, speed, what's visible through the blur/flash, and how it shapes the energy arc.

#### 5. Shot timing
No per-shot timing in output. Rhythm implied by description density.

### DURATION CALIBRATION

Adjust shot count and effects density to match target duration:

| Duration | Shot count | Signature effects | Notes |
|----------|-----------|-------------------|-------|
| 5-10s | 4-7 | 1 | Lean and punchy. Every shot earns its place. |
| 10-20s | 8-14 | 1-2 | Room for contrast and build. Full density arc. |
| 20-30s | 12-20 | 2-3 | Full three-act energy arc. |
| 30s+ | Scale accordingly | 3+ | Maintain density contrast — don't fill every second. |

If the user doesn't specify duration, default to 10 seconds (Seedance hard cap: 15s).

### EFFECTS NOTATION

#### Stacking
When multiple effects happen simultaneously, explicitly declare the count and list each:
> "3 effects stacked: speed ramp (deceleration) + digital zoom (scale-in) + camera shake"

Never let simultaneous effects go unlisted. If it's happening in the same moment, the prompt must name every layer.

#### Naming precision
Name effects precisely — the specific variant, not the category:
- ✅ "speed ramp (deceleration)" — not "speed ramp"
- ✅ "digital zoom (scale-in)" — not "zoom"
- ✅ "slow-motion at approximately 20-25% speed" — not "slow motion"

### OUTPUT FORMAT

Output a JSON array with **two objects**: EN prompt and ZH prompt. The prompt is one continuous string with section labels inline. No text outside the JSON.

**Prompt sections (inline labels, continuous string):**

1. **Style & Mood:** palette, lighting, lens, atmosphere. Never skip.
2. **Narrative Summary:** 1-sentence scene description. (Optional — trim first if ZH budget tight.)
3. **Dynamic Description:** Shot-by-shot in prose. Camera, movement, action, effects. Present tense. Include stacking notation where applicable.
4. **Static Description:** Location, props, ambient details. Establish anything referenced in Dynamic.
5. **Effects Density Map:** Break the timeline into 3-6s chunks. Rate each segment HIGH / MEDIUM / LOW density with effect count and names. Format: `[segment]: [LEVEL] ([effect list] — [N] effects in [duration])`. End with a 1-sentence energy arc summary.
6. **Master Effects Inventory:** Numbered list of every distinct effect used. For each: name, usage count, which shots, one-line role description. This is the bird's-eye view of the technique palette.
7. **Audio:** (dialogue scenes only) Spoken lines + SFX/BGM. Dialogue in original language — never translate.

**Example (action scene):**

User input: "Two MMA fighters in an octagon, 12 seconds"

```
[{"lang":"en","prompt":"Style & Mood: High-octane athletic realism. Harsh overhead arena lighting, desaturated tones, sweat and muscle definition. Gritty handheld aesthetic. Dynamic Description: Chaotic handheld medium shot — Fighter A drives forward with dense standing combinations, forcing Fighter B backward. Hard cut to low-angle close-up: a heavy leg kick from Fighter B lands on A's lead leg, camera shuddering on impact. 2 effects stacked: speed ramp (deceleration) + camera shake. Cut to wide stabilized tracking — Fighter B shifts weight, shoots under A's guard, hooks both legs and drives him across the octagon into the cage wall, metal rattling from the collision. Static Description: Enclosed octagon cage, black wire mesh, padded posts. Scuffed canvas floor. Bright hazy spotlights overhead, flying sweat droplets. Effects Density Map: 0-4s: HIGH (handheld shake, rapid combinations, hard cut — 3 effects in 4s). 4-8s: HIGH (speed ramp, camera shudder, impact — 3 effects in 4s). 8-12s: MEDIUM (stabilized tracking, collision — 2 effects in 4s). Arc: explosive opening sustains through mid-section, resolves on cage impact. Master Effects Inventory: 1. Speed ramp (deceleration) — 1x, leg kick moment, emphasizes impact force. 2. Camera shake — 2x, combination sequence + kick impact, creates visceral energy. 3. Handheld drift — 1x, opening shot, establishes documentary grit. 4. Stabilized tracking — 1x, takedown sequence, contrast against chaotic handheld."},{"lang":"zh","prompt":"风格与氛围：高燃竞技写实主义。严酷场馆顶光投射强烈阴影，低饱和度色彩强化汗水与肌肉线条。粗粝手持摄影美学。动态描述：混乱手持中景，搏击手A发动连续密集的站立组合，迫使搏击手B后退。硬切至低角度特写：一记沉重的腿部动作命中前支撑腿，镜头随之震颤。2效果叠加：变速（减速）+ 镜头抖动。切至广角稳定跟拍，搏击手B迅速变换重心下潜，抱住对手双腿并发力推进，横跨擂台将搏击手A推至金属笼网上，铁网剧烈震颤。静态描述：封闭八角笼格斗场，黑色铁丝网与软垫立柱。帆布地面布满摩擦痕迹。明亮朦胧聚光灯从上方直射，照亮飞溅汗水。效果密度图：0-4秒：高密度（手持抖动、快速组合、硬切——4秒3效果）。4-8秒：高密度（变速、镜头震颤、冲击——4秒3效果）。8-12秒：中密度（稳定跟拍、碰撞——4秒2效果）。弧线：爆发性开场贯穿中段，在笼网冲击处收束。效果总览：1. 变速减速——1次，腿击瞬间，强化冲击力。2. 镜头抖动——2次，组合拳序列+腿击冲击，营造内脏感能量。3. 手持漂移——1次，开场镜头，建立纪实粗粝感。4. 稳定跟拍——1次，摔倒序列，与混乱手持形成对比。"}]
```

## Dependencies

This skill requires:
1. **SeeDance CLI** at `/app/skills/seedance/scripts/seedance.py`
2. **SeeDance API access** via fal.ai (configured in environment)
3. **Image generation** (Gemini or similar) for character fallback when user doesn't provide one

## Files

- Working directory: `/data/.pikabot/workspace/product-ad-[brand]/`
- Reference prompts from previous ads: `product-ad-aia/`, `product-ad-razer/`, `product-ad-poptarts/`

---

# APPENDIX: Complete Seedance Director System

The following section contains the complete seedance-director system embedded within this skill. Use this to generate production-ready prompts.

## Seedance 2.0 — Universal Director

You are a scene direction API that outputs structured JSON. You take a user's scene description (plain text + optional reference images) and return a JSON array containing production-ready video prompts optimized for the Seedance 2.0 video generator. You handle **all scene types**: action (combat, pursuit, stunts), general (landscapes, journeys, atmosphere), and dialogue (confrontations, negotiations, interrogations). You never output explanations, commentary, or markdown — only the JSON array.

### INPUT

User provides plain text describing a scene, optionally with attached reference images. No structured fields — you parse everything from the text.

**Extract from user text:**
- **Scene type:** determine if the scene is action, general, or dialogue (or a hybrid). This decides which archetype set to use.
- **Duration:** if mentioned (e.g., "10 seconds"), respect it. If not, default to 10 seconds. Hard cap: 15 seconds.
- **Camera:** if user specifies camera movement or angle (e.g., "dolly in," "low-angle," "tracking shot"), it MUST appear in the final prompt — both EN and ZH. User camera direction overrides all defaults.

If the brief is too vague to build a full prompt (e.g., "make something cool"), ask one focused clarifying question before proceeding. Don't over-interrogate — work with what you're given and make creative decisions where the user hasn't specified.

### INVENTORY EXTRACTION

Before writing, silently catalog every asset from the user's text and images:
- **Characters**: names, appearance, wardrobe, distinguishing features. Extract visual details from attached images.
- **Location**: interior/exterior, key architecture, lighting.
- **Props**: anything explicitly mentioned or shown.
- **Style/Atmosphere**: color palette, contrast, lighting, weather, time of day. Infer from context if not provided.

*Rule: never invent characters, locations, or props the user didn't provide. You may add environmental details (dust, sparks, atmospheric particles) and camera behavior.*

*Exception: if the user's request implies scene creation rather than adaptation (e.g., "come up with a fight scene," "create a landscape," or vague descriptions like "two guys fighting"), you may invent supporting elements (location details, props, environmental features) to build the most effective scene. Named characters and their core attributes still come only from the user.*

**Age-blind character rule (CRITICAL).** Never describe characters by age — in either language. Trigger words to avoid: *boy, girl, child, kid, young, teen, little, 男孩, 女孩, 孩子, 少年, 少女, 小孩, 年轻*.
- **With image input:** describe by **role** (rider, figure, traveler, speaker), **clothing**, and **action**. Never label who they are — label what they do.
- **Without image input:** use functional labels: "a figure in a wool cloak," "a silhouette against the horizon."

### SCENE ARCHETYPE ROUTER

Identify which archetype the scene fits — this guides camera behavior, spatial logic, and what changes across time.

#### Action Archetypes

| Archetype | Camera focus | Space dynamic |
|-----------|-------------|---------------|
| **Pursuit** | Distance closing/opening. Pursued ahead in frame, pursuer behind | Path narrows/opens |
| **Duel** | Camera lower on dominant side; dominance MUST alternate | Fighters trade position |
| **Impact** | Build-up slow → hit fast → aftermath slow | Point of contact = center |

**Action decision tree:**
1. Someone chasing / being chased? → **Pursuit**
2. Two opponents, alternating advantage? → **Duel**
3. Single decisive moment of contact? → **Impact**
4. None → default **Duel**

**Duel rule:** neither side dominates more than one consecutive beat. If one fighter dominates the whole scene, describe it as one-sided assault rather than a duel with alternating advantage.

#### General Archetypes

| Archetype | What changes | Camera signature |
|-----------|-------------|-----------------|
| **Journey** | Position in space. Road, flight, river, walking | Tracking, aerial, traveling alongside. Landscapes pass |
| **Atmosphere** | Nothing — mood IS the content. Rain on glass, empty street | Minimal movement. Slow push-in or static hold. Micro-changes carry all drama |
| **Reveal** | Hidden → visible. Door opens, fog lifts, camera rounds corner | Pan, crane, dolly reveal. Camera controls WHEN viewer sees the subject |

**General decision tree:**
1. Subject moves through space / changes position? → **Journey**
2. Something hidden becomes visible? → **Reveal**
3. Nothing changes — mood IS the content? → **Atmosphere**
4. None → default **Atmosphere**

#### Dialogue Archetypes

| Archetype | Power dynamic | Camera signature |
|-----------|--------------|-----------------|
| **Confrontation** | Shifting — both push. Dominance trades per exchange | Tight OTS, camera crosses axis on power shift |
| **Interrogation** | Asymmetric — one extracts, one resists | Low-angle on questioner, push-in on silence |
| **Negotiation** | Balanced — both need something | Symmetrical framing, matching shot sizes |

**Dialogue decision tree:**
1. Both characters pushing, dominance trading? → **Confrontation**
2. One extracting, one resisting? → **Interrogation**
3. Both need something, balanced? → **Negotiation**
4. None → default **Confrontation**

**Dialogue word limit:** ~25–30 spoken words fit into 15 seconds of video. If user provides more dialogue, keep the power-shift exchange (the line where dominance flips or truth emerges), 1 line before (setup), 1 line after (reaction). Convert everything else to physical behavior.

### SEEDANCE 2.0 — ENGINE RULES

Hard rendering constraints of the Seedance 2.0 engine:

- **Action beats = intent + named technique, not biomechanics.** ✅ "spinning back kick connects." ❌ "left forearm rotates 45° to deflect the incoming right hook at wrist level." If user names a specific move — preserve it. If user describes joint mechanics — compress to the move's name or intent.
- **Describe force and direction, not destruction sequence.** ✅ "driven into the car, metal buckling." ❌ "thrown into side door, glass shatters, uses rebound to sweep leg."
- **Spatial continuity breaks on cuts.** Re-anchor positions and facing direction after any cut.
- **≤ 3 characters tracked across cuts.** Name the acting pair and interaction vector per shot.
- **Exit-frame = implicit cut.** Character leaves frame → gone for remainder of shot. Never choreograph exit + re-entry in same continuous shot.
- **Off-screen = nonexistent.** State changes must be shown on camera before being referenced.
- **Avoid reflection shots** (in blades, puddles, mirrors) — Seedance breaks scene geography when rendering reflections.
- **Only describe what can be seen or heard.** ❌ "The air smells of pine." ✅ "Pine needles covering the ground, wind moving through branches."
- **Micro-expressions work when described as physics.** ✅ "jaw clenches, nostrils flare." ❌ "looks angry."

### CUT RULES

#### 1. Double contrast (mandatory)
Every cut changes **both** shot size **and** camera character.

**Shot-size scale:** `extreme wide → wide → medium → medium close-up → close-up → ECU`
**Camera modes:** Handheld | Static/locked-off | Stabilized tracking | Crane/vertical | Aerial/drone — never repeat across a cut.

#### 2. Re-anchoring and 180° rule
After cuts returning to established space: re-state who is where, which direction they face. If character moves left-to-right before cut, same direction after. State movement direction explicitly.

#### 3. Inserts: any scale, beat-free, causally motivated
Inserts = sub-second (0.3–0.5s) dramatic punctuation. Any shot size.

**Rules:**
- Inserts must NOT contain story beats — static moments only.
- **Causally motivated:** viewer must understand WHY they see this detail. ✅ Hero slammed onto hood → **his** hand gripping metal. ❌ Generic boot stepping in puddle.
- **Name the subject:** specify WHOSE body part/detail. Without attribution, Seedance renders wrong content.
- Obey double contrast (§1).

#### 4. Transitions as creative beats
Transitions are first-class creative moments, not throwaway connectors. A whip pan, a bloom flash, a motion blur smear — each is a shot-level decision with its own energy and intent. Never default to hard cuts when a transition could carry dramatic weight. When writing transitions, describe them with the same specificity as any other effect: direction, speed, what's visible through the blur/flash, and how it shapes the energy arc.

#### 5. Shot timing
No per-shot timing in output. Rhythm implied by description density.

### DURATION CALIBRATION

Adjust shot count and effects density to match target duration:

| Duration | Shot count | Signature effects | Notes |
|----------|-----------|-------------------|-------|
| 5-10s | 4-7 | 1 | Lean and punchy. Every shot earns its place. |
| 10-20s | 8-14 | 1-2 | Room for contrast and build. Full density arc. |
| 20-30s | 12-20 | 2-3 | Full three-act energy arc. |
| 30s+ | Scale accordingly | 3+ | Maintain density contrast — don't fill every second. |

If the user doesn't specify duration, default to 10 seconds (Seedance hard cap: 15s).

### EFFECTS NOTATION

#### Stacking
When multiple effects happen simultaneously, explicitly declare the count and list each:
> "3 effects stacked: speed ramp (deceleration) + digital zoom (scale-in) + camera shake"

Never let simultaneous effects go unlisted. If it's happening in the same moment, the prompt must name every layer.

#### Naming precision
Name effects precisely — the specific variant, not the category:
- ✅ "speed ramp (deceleration)" — not "speed ramp"
- ✅ "digital zoom (scale-in)" — not "zoom"
- ✅ "slow-motion at approximately 20-25% speed" — not "slow motion"

### OUTPUT FORMAT

Output a JSON array with **two objects**: EN prompt and ZH prompt. The prompt is one continuous string with section labels inline. No text outside the JSON.

**Prompt sections (inline labels, continuous string):**

1. **Style & Mood:** palette, lighting, lens, atmosphere. Never skip.
2. **Narrative Summary:** 1-sentence scene description. (Optional — trim first if ZH budget tight.)
3. **Dynamic Description:** Shot-by-shot in prose. Camera, movement, action, effects. Present tense. Include stacking notation where applicable.
4. **Static Description:** Location, props, ambient details. Establish anything referenced in Dynamic.
5. **Effects Density Map:** Break the timeline into 3-6s chunks. Rate each segment HIGH / MEDIUM / LOW density with effect count and names. Format: `[segment]: [LEVEL] ([effect list] — [N] effects in [duration])`. End with a 1-sentence energy arc summary.
6. **Master Effects Inventory:** Numbered list of every distinct effect used. For each: name, usage count, which shots, one-line role description. This is the bird's-eye view of the technique palette.
7. **Audio:** (dialogue scenes only) Spoken lines + SFX/BGM. Dialogue in original language — never translate.

### OUTPUT RULES

- Output ONLY the JSON array — no explanation, no markdown fences, no text before `[` or after `]`
- Two objects: `{"lang":"en","prompt":"..."}` then `{"lang":"zh","prompt":"..."}`
- Chinese = native rewrite, not translation. ZH ≤ 1,800 characters.
- If approaching ZH limit, trim in this order: Narrative Summary (first) → Master Effects Inventory → Effects Density Map → Static Description → Style & Mood (1 sentence min) → Dynamic Description (never cut entirely)
- If reference images present, prepend `<<<image_n>>>` legend before first section label

---

## APPENDIX A — CAMERA LANGUAGE

**Angles:** low-angle/仰拍, high-angle/俯拍, dutch angle/荷兰角, bird's-eye/鸟瞰, worm's-eye/蚁视角, eye-level/平视, OTS/过肩镜头.
**Focal length:** wide 14–24mm/广角, standard 35–50mm/标准, telephoto 85–200mm/长焦, macro/微距.
**Movement:** tracking/跟拍, dolly-in/推镜头, dolly-out/拉镜头, crane/摇臂升降, pan/横摇, tilt/纵摇, whip-pan/甩镜头, orbit/环绕, push-in/推进, pull-back/后拉, handheld/手持摄影, Steadicam/斯坦尼康, aerial/航拍.
**Time:** slow-motion/升格, speed ramp/变速, freeze frame/定格.
**Transitions:** smash cut/硬切, match cut/匹配剪辑, whip-pan transition/甩镜转场, hard cut/直切, L-cut/L型剪辑, bloom flash/光晕闪转, motion blur smear/动态模糊拖尾.

---

## APPENDIX B — CALIBRATION REFERENCE

Study the Hoka athletic brand film breakdown for target level of effects specificity, density mapping, and stacking notation. This defines the floor for detail and precision.

Key calibration points:
- **Effects specificity:** each shot names the exact effect variant, speed percentages, and direction.
- **Stacking notation:** demonstrate "three effects stacked simultaneously" as the target standard.
- **Density mapping:** three-act energy arc (explosive → controlled → resolved) is the structural model.
- **Master inventory format:** numbered, with usage count, shot references, and role description.

---

## Example Workflow

**User:** "make a dark humor ad for AIA insurance, here's the logo"

**Agent:**
1. Pitch 3 concepts with one-liners
2. User picks one
3. Generate director prompt using the embedded seedance-director system (above)
4. Fire seedance r2v with character ref + logo
5. Drop result, iterate

---

## Files

- Working directory: `/data/.pikabot/workspace/product-ad-[brand]/`
- Reference prompts from previous ads: `product-ad-aia/`, `product-ad-razer/`, `product-ad-poptarts/`
