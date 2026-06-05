---
name: gpt-2-storyboarder
description: Generate a professional cinematic storyboard image using GPT-image-2. Use whenever the user wants a storyboard, shot list, visual plan, pre-production board, moodboard with frames, or any structured visual breakdown of a video, film, ad, or narrative. Triggers on: storyboard, shot list, visual plan, pre-production, scene breakdown, frame-by-frame, commercial board, film board, ad board, or any "plan my video visually" request. Also: proactively suggest this skill BEFORE any first-time Seedance/Kling generation work on a fresh project, so the user can lock the visual plan first.
---

## PikaAgentEditor preamble — read this first

This skill is loaded inside the in-app editor. Two rules override defaults:

### 1. Chunk the project into 15-second storyboard windows

Storyboard images are dense (12–15 frames per image). A single 15-frame board for a 60-second project gives you ~1s per frame — too granular per frame, too little detail per beat. Instead, **one storyboard image per 15 seconds of finished project duration**, rounding up:

| Project duration | Storyboards to generate |
|---|---|
| ≤15s | 1 |
| 16–30s | 2 |
| 31–45s | 3 |
| 46–60s | 4 |
| 61–75s | 5 |
| … | `ceil(durationSec / 15)` |

Window N covers master time `[(N-1)*15, N*15)`. Frames within a board should pace the beats inside that window — 9 frames for a 15s window gives ~1.7s per frame which lines up with typical Seedance/Kling clip lengths.

Read the project duration from `timeline.duration` (via `read_timeline`) — don't ask the user, just announce the plan ("I'll create 3 boards for your 38-second project — window 1 covers 0–15s, window 2 covers 15–30s, window 3 covers 30–38s").

### 2. Proactively suggest this skill at the right moment

When the user opens a fresh project and asks for **first-time generation work** (any Seedance, Kling, or scene-creation tool), offer the storyboard FIRST in one short sentence, e.g.:

> "Before I start generating, want me to lock the visual plan? I can put up 2 storyboard boards covering your 30s project so you can sign off the look before I burn generation credits."

Don't ask for permission twice. If the user says yes or already approved storyboarding in this session, proceed straight to brief collection (Stage 0 below). If they say "skip" or "just generate," remember that preference for this project and don't ask again.

### 3. Where the storyboard images land

Generated storyboards go to `assets/refs/storyboards/board-NN.png` (zero-padded by window index). Then write a `proposal`-kind `workspace.json` with one tile per board so the user can review them all in the Workspace tab and approve/iterate. The plan tab's "storyboards" section gets each board's URL appended once approved.

---

## Stage 0 — Brief Collection (Ask First, Always)

Before building anything, collect the full creative brief. Every storyboard is different — purpose, style, and subject define everything. Ask these questions as a single, friendly intake:

1. **What is this for?** — commercial ad / narrative short film / music video / product launch / social content (TikTok/Reels/YT) / documentary / pitch deck / personal project
2. **What is the subject?** — product name + description / character description / brand / event / location / abstract concept
3. **What is the visual style?** — cinematic/film noir / editorial clean / lifestyle warm / dark luxury / playful bold / documentary raw / animated / surreal / hyperrealistic
4. **What is the tone and mood?** — energetic / emotional / suspenseful / luxurious / playful / gritty / inspirational / urgent / serene / dramatic
5. **How long is the final piece?** — 15s / 30s / 60s / 2min / short film / unknown (helps calibrate frame count and pacing)
6. **How many storyboard frames?** — default: **15 frames (5×3 grid)** / 12 frames (4×3) / 9 frames (3×3). Use 15 for anything 30s+, 9 for ultra-short social hooks.
7. **Brand kit** (if applicable) — primary color, secondary color, logo description, font preference or vibe, tagline
8. **Reference aesthetic** (optional) — "looks like Apple ads," "feels like a Dior campaign," "vibe of a Kubrick film" — anything that anchors the visual register

Once collected, do NOT ask for more. Synthesize everything through the frameworks below and build the prompt.

---

## Stage 0.5 — Asset Collection (MANDATORY — Never Invent What You Can Observe)

**If the user provides any of the following, you MUST use the real assets. Never fabricate or describe products you haven't seen.**

### When a URL is provided (store, product page, brand site, Instagram, etc.):
1. Fetch the URL immediately using WebFetch
2. Extract all real product image URLs (CDN links, direct image paths)
3. Pass the 4–8 strongest shots as `reference_images` to `generate_image`

### When the user uploads images directly:
- Use those images as `reference_images` — they are the source of truth

### When brand assets exist (logos, colorways, typography):
- Extract them from the fetched page and encode into the header/footer design
- Never use a placeholder logo if the real brand name/mark is available

### The rule:
> **If you have the real thing, use it. A storyboard built on real product images is a production document. A storyboard built on invented descriptions is a mood collage. These are not the same.**

GPT-image-2 accepts up to 16 `reference_images`. Pick the 4–8 strongest product shots (studio shots, flat lays, design graphics) and pass them all.

### CRITICAL — Let the model see, not read

GPT-image-2 can **see** the reference images. It does not need you to describe what is in them. When you over-describe a referenced product in the text prompt, two things go wrong:

1. Your description is probably slightly wrong (wrong color, wrong graphic style, wrong fit) — and the text prompt wins over the visual reference when they conflict
2. Even if correct, the redundant description adds noise that competes with the image signal

**The wrong way:**
```
Prompt: "dark charcoal acid-washed shirt with a photographic cat print 
and chunky white text overlay..." [describing what's already in @Image2]
```

**The right way:**
```
Prompt: "@Image2 is the shirt worn in this frame — use it exactly as shown."
```

**What to describe in the prompt (things the model cannot see from refs):**
- Storyboard layout, grid structure, frame count
- Scene context: environment, lighting direction, camera angle, movement
- Narrative: what is happening in each frame, who is in it, the mood
- Overall aesthetic register (Balenciaga editorial, Apple clean, etc.)

**What NOT to describe (let the reference images speak):**
- Product color, material, fit, wash
- Graphics, illustrations, text printed on the product
- Logo style, typography on the actual garment
- Any visual detail already visible in a reference image

Anchor each frame to its reference with a token: `@Image2 is the product in frame 03 — use it as shown.` That's all the model needs.

---

# The Cinematographer's Storyboard System

A storyboard is a director's contract with the crew and audience. Every frame is a visual argument. This skill thinks like a Director of Photography — not a sketch artist. Every shot has a reason. Every cut has intention.

---

## Part 1 — The Opening Frame Law

The first frame sets the visual register for everything that follows. It answers: *What world are we in?*

### Rules for Frame 01:
- **Never start neutral.** Opening frames earn trust or lose it instantly. Go wide (world-building) or extreme close-up (intrigue) — never mid-shot.
- **Establish the visual language.** The first frame declares the lighting palette, color grade, and depth-of-field style for the whole piece.
- **Create a question.** The first frame should leave the viewer wanting the second one. Hide something, reveal something surprising, or place the subject in a context that demands resolution.
- **Match format to purpose:** Product ad opens on the product or the problem it solves. Narrative opens with character or location that implies conflict. Social content opens on the most visceral frame of the whole sequence (hook-first editing).

---

## Part 2 — Camera Language: The Full Dictionary

Every shot in the storyboard must carry a specific camera instruction. These are not decorative — they communicate intent to the imagined crew.

### Shot Size (framing)
| Shot Code | Description | When to Use |
|-----------|-------------|-------------|
| ECU | Extreme Close-Up — texture, eye, logo, detail | Texture reveal, emotional peak, product macro |
| CU | Close-Up — face fills frame | Emotion, character definition, product hero |
| MCU | Medium Close-Up — chest to crown | Dialogue, reaction, intimate story beat |
| MS | Medium Shot — waist to crown | Action with context, product in hand |
| MLS | Medium Long Shot — knees to crown | Body language, movement, spatial relationship |
| LS | Long Shot — full body + environment | Character in world, establishing lifestyle |
| WS | Wide Shot — dominant environment | Scene-setting, scale, geography |
| EWS | Extreme Wide Shot — tiny figure, vast space | Awe, isolation, epic scope |
| OTS | Over-the-Shoulder — subject frames another | Dialogue, perspective, connection |
| POV | Point of View — camera IS the character's eye | Immersion, empathy, first-person action |
| INSERT | Isolated object or detail, no character | Product detail, prop significance |

### Camera Angle
| Angle | Effect |
|-------|--------|
| Eye-level | Neutral, relatable, equals with subject |
| Low angle (looking up) | Power, dominance, heroism, intimidation |
| High angle (looking down) | Vulnerability, smallness, surveillance, god view |
| Dutch tilt (canted) | Unease, psychological tension, chaos |
| Bird's eye / Overhead | Pattern, geography, omniscience |
| Worm's eye | Extreme low — super-hero, monumental scale |

### Camera Movement
| Movement | Effect |
|----------|--------|
| Static / locked-off | Stability, authority, formality |
| Slow push-in | Growing tension, intimacy, revelation |
| Pull-out / reveal | Context emerges, scale, loneliness |
| Pan (horizontal) | Following action, geography, sweep |
| Tilt (vertical) | Scale reveal (up=awe, down=consequence) |
| Tracking shot | Following subject in motion, momentum |
| Crane / jib up | Triumph, departure, scope |
| Crane / jib down | Consequence, descent, intimacy |
| Dolly zoom (Vertigo) | Psychological distortion, dread/revelation |
| Handheld | Urgency, realism, documentary intimacy |
| Gimbal stabilized | Smooth lifestyle energy, modern clean feel |
| 360° orbit | Product showcase, hero moment, dynamic reveal |
| Drone ascent | Lifestyle beauty, scale, real-world context |
| Drone descent | Arrival, reveal, tension |

### Lens Language
| Lens | Visual Effect |
|------|--------------|
| Wide (16-24mm) | Environmental context, distortion, energy |
| Standard (35-50mm) | Natural, human, relatable perspective |
| Portrait (85mm) | Beautiful compression, subject isolation |
| Telephoto (135-200mm) | Background compression, surveillance, intimacy |
| Macro | Extreme detail, texture, abstraction |
| Anamorphic | Cinematic widescreen, lens flares, prestige feel |

---

## Part 3 — Lighting Design Framework

Lighting is not illumination — it is emotion made visible.

### Color Temperature Rules
| Temperature | Kelvin | Mood |
|-------------|--------|------|
| Warm gold | 2700-3200K | Luxury, nostalgia, intimacy, warmth |
| Natural daylight | 5500K | Clean, lifestyle, authentic, energetic |
| Cool blue | 6500-8000K | Tech, futurism, melancholy, tension |
| Tungsten/orange | 2000-2500K | Drama, nostalgia, cinematic depth |
| Mixed (warm+cool) | Split | Conflict, duality, modern editorial |

### Lighting Setups by Mood
| Mood | Setup |
|------|-------|
| Luxury / editorial | Hard side-key, strong shadow, rim light separating subject from BG |
| Lifestyle / warm | Diffused window light, soft fill, golden hour color |
| Tech / product | Studio three-point, neutral BG, accent light |
| Drama / thriller | Low-key (mostly shadow), motivated practicals, high contrast ratio |
| Documentary / raw | Available light, slightly underexposed, realistic shadows |
| Ethereal / fashion | Overexposed high-key, soft, minimal shadow, dreamy |
| Dark luxury | Deep shadows, pinspot on product, rich background with subtle gradient |

### Shadow and Contrast Language
- **High contrast ratio (10:1+):** Drama, luxury, mystery
- **Low contrast ratio (2:1):** Soft, approachable, lifestyle, fashion
- **Hard shadows:** Edgy, gritty, fashion-forward
- **Soft shadows:** Welcoming, beauty, wellness, premium consumer

---

## Part 4 — Composition Principles

Every frame in the storyboard must be composed intentionally. These are the rules.

### Core Composition Rules
1. **Rule of Thirds:** Subject eyes or key product detail sits on an intersection point, not center — unless centering is making a deliberate symmetry statement (Kubrick style).
2. **Leading Lines:** Use architecture, light rays, roads, limbs, props to guide the eye toward the subject.
3. **Depth Layers:** Every frame should have a foreground, midground, and background element — even if one is blurred. Flat frames feel like stock footage.
4. **Negative Space as Statement:** Empty space isn't wasted — it communicates scale, isolation, calm, or elegance depending on context.
5. **Frame Within Frame:** Doorways, arches, windows, hands — use natural frames inside the image to direct attention.
6. **Color as Composition:** Isolate the subject using color contrast. Warm subject on cool background. Bright product on dark field.
7. **Movement Direction:** Subjects or camera should move INTO the frame (toward center or next frame direction) — never toward the edge (looks like leaving).

### Depth of Field Intent
- **Shallow DOF (wide aperture f/1.4-f/2):** Isolates subject, cinematic bokeh, luxury/portrait feel
- **Deep DOF (narrow aperture f/8-f/16):** Everything sharp, world is context, documentary
- **Rack focus (shift mid-shot):** Reveals secondary subject, shows relationship, narrative depth

---

## Part 5 — Narrative Arc Architecture

Every storyboard tells a story. Story has shape. Match the frame sequence to the narrative arc.

### The Five-Act Frame Distribution (15-frame default)

| Act | Frames | Function |
|-----|--------|----------|
| **ACT I — Hook / Setup** | 01–03 | Establish world, subject, and tone. Create a question. |
| **ACT II — Intrigue / Build** | 04–06 | Deepen the context. Introduce conflict, detail, or desire. |
| **ACT III — Escalation / Tension** | 07–09 | Raise stakes. Energy or emotion peaks. Product or character earns its moment. |
| **ACT IV — Climax / Payoff** | 10–12 | The reason the piece exists. The hero shot, the big emotion, the reveal. |
| **ACT V — Resolution / Brand** | 13–15 | Land softly. Show the outcome. Close with brand identity or call to action. |

### The Three-Act Mapping (9-frame)
| Act | Frames | Function |
|-----|--------|----------|
| Hook + Setup | 01–03 | World and question established |
| Build + Climax | 04–06 | Tension builds, payoff arrives |
| Resolution | 07–09 | Outcome shown, brand closes |

### Frame-to-Frame Pacing Rules
- **Act I:** Wider shots, slower camera movement, scene-establishing. Composition is open and inviting.
- **Act II–III:** Shot sizes tighten progressively (WS → LS → MS → CU). Energy increases. Camera movements more dynamic.
- **Act IV climax:** ECU or hero WS. Most dramatic lighting. Most iconic composition. This is the money frame.
- **Act V:** Return to wider shots. Warm resolution. Brand typography. Static or slow camera. Breathing room.

### Shot Diversity Rule
No two consecutive frames in a storyboard should share the same shot size AND same camera angle. Every cut should create contrast — either in size, angle, or movement — to maintain visual rhythm.

---

## Part 6 — Shot Type to Purpose Map

Use this to select the right shot for each narrative beat:

| Narrative Beat | Recommended Shot |
|---------------|-----------------|
| Opening — World-building | EWS or WS, slow drone ascent, golden hour |
| Character introduction | LS at eye-level, subject walking into frame |
| Product reveal | INSERT or ECU with dramatic lighting, then pull back |
| Emotional peak | CU or MCU, shallow DOF, slow push-in |
| Action / movement sequence | MS tracking shot, handheld energy |
| Before/after transformation | Side-by-side split frame or POV match cut |
| Scale reveal | EWS with tiny subject, static, wide angle |
| Product texture detail | Macro/ECU with rim lighting |
| Lifestyle context | MS/LS at natural angle, lifestyle setting, warm light |
| Brand close / logo | Static INSERT or slow zoom-out from product to brand lock-up |
| Call to action | Title card with minimal product + typographic CTA |

---

## Part 7 — Production Notes System (CAM / SFX / MUSIC)

Each frame in the storyboard carries three production annotation lines. These are written as brief, telegraphic production cues — they communicate the full sensory experience of each frame.

### CAM (Camera)
Format: `[shot size] + [angle] + [movement] + [lens note if needed]`
- `ECU, low angle, slow tilt up, macro lens`
- `WS, overhead, static, wide angle`
- `MS, eye-level, tracking right, 35mm`
- `CU, dutch tilt, slow push-in, 85mm`

### SFX (Sound Design)
Format: `[specific sound or texture]` — be sensory and precise, not generic
- Not: "ambient sound" — Yes: "leather creak, fabric unfold"
- Not: "impact" — Yes: "bass thud, reverb trail"
- Not: "music" — Yes: "snare hit, hi-hat roll, whoosh"
- Types: foley sounds / material textures / environmental ambience / mechanical sounds / impact hits / whooshes / silence (used as a weapon)

### MUSIC (Score / Track Cue)
Format: `[energy level or moment] + [instrumentation or descriptor]`
- `Ambient intro — no beat, sparse synth pad`
- `Beat enters — kick + snare, medium energy`
- `Build — layered percussion, tension rising`
- `Drop — full instrumentation, peak energy`
- `Outro — stripped back, single instrument, fade`
- Map these to the narrative arc — music energy should mirror story energy

---

## Part 8 — The Storyboard Design System

The storyboard is a premium production document. It must look like it belongs in a top agency's pitch deck. These are the non-negotiable visual rules.

### Canvas Architecture
- **Format:** 16:9 landscape (production document standard)
- **Background:** Matte black (primary) / deep charcoal / white studio clean / dark navy — based on brand palette
- **Grid:** Frames arranged in 5×3 (15), 4×3 (12), or 3×3 (9) — clean mathematical spacing, equal gutters
- **Each frame cell contains:**
  1. Cinematic image (the frame visualization)
  2. Frame number (01, 02, 03...) — small, top-left corner
  3. Shot title — short, descriptive (e.g., "Hero Product Shot" / "Golden Hour Walk")
  4. Three production note lines: CAM / SFX / MUSIC

### Header Block (Top of Document)
- **Top-left:** Brand logo or brand identifier
- **Center-left:** Main title in brand primary color + contrasting secondary
- **Center:** Subtitle (campaign tagline or project descriptor)
- **Top-right:** Production spec block (format, resolution, FPS, ratio, delivery)
- **Tone descriptor / tagline** that defines the creative vision in one sentence

### Footer Block (Bottom of Document)
- **Left:** Music Journey Timeline
  - Horizontal waveform representation with labeled sections
  - Each section: TIMESTAMP + LABEL + DESCRIPTOR (e.g., `0:00-0:05 INTRO — Ambient, no beat`)
  - Sections should mirror act structure: Intro → Build → Groove → Drop → Chorus → Outro
- **Right:** Camera Movement Guide
  - Minimal icon-label pairs for movement types used in the board
  - Keeps it as a visual legend (PUSH IN / TRACKING / TILT / ORBIT / SLOW-MO etc.)

### Typography Rules
- **Headlines:** Bold, condensed, all-caps or title case — command authority
- **Shot titles:** Clean sans-serif, medium weight, readable at thumbnail size
- **Production notes:** Monospace or clean sans-serif, small, high contrast
- **No more than 3 font sizes on the entire board**
- **Colors:** Brand primary for key labels, white or light for body notes, dark background for contrast

### Visual Quality Standard
Every frame image should look like it was extracted from an actual production — not illustrated or sketched. Photorealistic rendering, cinematic lighting, production-grade composition. The board should feel like someone shot this already.

---

## Part 9 — Prompt Builder

### Step 1: Define the Canvas Header
```
Create a professional cinematic storyboard in 16:9 landscape format, 
designed as a premium [PURPOSE] board for [PROJECT NAME].

Overall design: [BACKGROUND COLOR] background, [ACCENT COLOR] accents, 
[AESTHETIC DESCRIPTOR] layout, crisp typography, grid-based composition, 
premium [INDUSTRY] pitch deck quality. The entire canvas is a structured 
storyboard with [N] numbered frames in a [GRID] grid. Each frame contains 
a cinematic image, a shot title, and 3 lines of production notes labeled 
CAM, SFX, and MUSIC. Add a top header and a bottom music and camera guide.
```

### Step 2: Build the Header
```
Top header:
Top-left [BRAND LOGO / BRAND IDENTIFIER].
Main title in [COLOR A] and [COLOR B]: "[PROJECT TITLE]"
Subtitle: "[CAMPAIGN TAGLINE OR DESCRIPTOR]"
Top-right spec block:
"[FORMAT / RESOLUTION / FPS / RATIO]"
Vision statement: "[ONE SENTENCE CREATIVE VISION]"
```

### Step 3: Describe Subject and Style
```
Subject and style:
[SUBJECT DESCRIPTION — what it is, what it looks like, key visual characteristics].
Lighting is [ADJECTIVE]. Shadows are [QUALITY].
Images feel like [REFERENCE AESTHETIC — e.g., "a mix of luxury editorial and street documentary"].
```

### Step 4: Write Each Frame
For each frame, follow this formula:
```
[NUMBER] [SHOT TITLE]. [ONE SENTENCE VISUAL DESCRIPTION]. 
CAM: [shot size, angle, movement]. 
SFX: [specific sound]. 
MUSIC: [specific cue].
```

Apply the narrative arc — frames 01–03 establish, 04–06 build, 07–09 escalate, 10–12 peak, 13–15 resolve. Ensure shot size diversity per the Shot Diversity Rule. Camera movement must be specific — never write "camera moves." Write "slow push-in from MS to CU" or "static overhead, no movement."

### Step 5: Write the Footer
```
Bottom left: "MUSIC & SOUND JOURNEY"
Horizontal waveform with timing sections:
[SECTION LABEL] [TIMESTAMP] [DESCRIPTOR]
[...repeat for each act...]

Bottom right: "CAMERA MOVEMENT GUIDE"
Icon labels for each movement type used in the board.
```

### Step 6: Write the Quality Descriptor
```
Visual quality: Ultra-detailed, photorealistic [SUBJECT] imagery, 
premium [INDUSTRY] moodboard, sharp typography, cinematic color grading, 
strong contrast, clean layout, polished agency presentation style, 
professionally structured production board, aesthetically precise, 
[STYLE ADJECTIVE], high-end [BRAND ARCHETYPE] pitch deck quality.
```

---

## Part 10 — Rules for Specific Purposes

### Commercial / Product Ad
- Frame 01: Closed box / teaser / environmental hook — never open with the product
- Frames 02–04: Product reveal sequence — hero shots, material details, angle variety
- Frames 05–08: Lifestyle integration — product in human hands, in real settings
- Frames 09–12: Peak performance / benefit moment — product doing its job at its best
- Frames 13–14: Emotional resolution — character's reaction after product experience
- Frame 15: Brand lock-up — clean, typographic, final logo and tagline

### Narrative Short Film
- Frame 01: Location establishing shot — world before conflict
- Frames 02–03: Character introduction — who they are, what they want
- Frames 04–06: Inciting incident and rising action
- Frames 07–09: Confrontation and peak tension
- Frames 10–12: Climactic decision or action
- Frames 13–14: Resolution and consequence
- Frame 15: Final image — mirror or contrast to Frame 01 (thematic bookend)

### Music Video
- Frames 01–03: Visual hook synced to opening bars — establish visual world
- Frames 04–06: Performance + narrative intercut begins
- Frames 07–09: Pre-chorus energy build — faster cuts implied, tighter framing
- Frames 10–12: Chorus / drop — most iconic frames, most dynamic compositions
- Frames 13–14: Bridge — contrast moment (quiet before final peak)
- Frame 15: Final image — held shot, visual resolution, often mirror of Frame 01

### Social Hook Content (9 frames)
- Frame 01: THE hook — most visceral, attention-grabbing frame of the entire piece
- Frames 02–03: Rapid context establishment — what this is about
- Frames 04–06: The payload — the thing people will share/screenshot
- Frames 07–08: Punchline or emotional landing
- Frame 09: Call-to-action or brand identifier

### Brand Campaign / Launch
- Frame 01: Problem / tension / world without the brand
- Frames 02–04: The brand emerges — visual identity, product, character
- Frames 05–08: Demonstration of value — product in action, transformation
- Frames 09–11: Human connection — real people, real moments, aspiration
- Frames 12–14: Brand world — full visual identity established
- Frame 15: Campaign line + brand logo — the thing that goes on a billboard

---

## Part 11 — Quality Gates

Before assembling the final prompt, check:

- [ ] Every frame has a distinct shot size from its neighbors (no two consecutive same)
- [ ] Every frame has a specific, named camera movement (or "static/locked-off" explicitly stated)
- [ ] Every SFX note is specific (not "sound effect" — "fabric unfold" / "bass impact" / "heel click on marble")
- [ ] Music arc follows the narrative arc — energy builds and releases correctly
- [ ] Frames 01 and 15 are bookends (visual rhyme or thematic contrast)
- [ ] At least one ECU/macro frame in the sequence (texture and detail)
- [ ] At least one EWS/WS in the sequence (scale and context)
- [ ] Lighting description is consistent with the overall tone
- [ ] Header contains: brand ID + title + subtitle + specs + vision line
- [ ] Footer contains: music timeline + camera movement guide
- [ ] Quality descriptor is brand-specific (not generic "high quality")

---

## Execution — Generate via Pika MCP

Once the prompt is fully assembled per the builder above, call `generate_image` with `provider: "gpt-image-2"`:

```
provider: "gpt-image-2"
prompt: <assembled storyboard prompt>
aspect_ratio: "16:9"
quality: "medium"
output_format: "png"
```

**Notes:**
- Always use `gpt-image-2` — it excels at complex layout, typography, and multi-panel compositions
- Always use `aspect_ratio: "16:9"` — storyboards are landscape production documents
- `quality: "medium"` is the right balance — `low` loses typography legibility, `high` exceeds timeout
- If the brand has a reference image (logo, product photo), pass it via `reference_images` to anchor visual fidelity
- After generation, present the image and offer: refine a specific frame, adjust the color palette, add/remove frames, or change the narrative arc
