import { z } from 'zod';

// ─── Scene definitions ────────────────────────────────────────────────────
// PikaAgentEditor scenes are pure video sources — either an agent-generated
// pika-gen (Pika MCP fills it in) or a user-imported file.

export const PikaGenSceneSchema = z.object({
  id: z.string(),
  kind: z.literal('pika-gen'),
  prompt: z.string(),
  model: z.string().default('kling-v3-master'),
  // Free-form ref/source images, identity refs, etc. — the agent decides
  // how to pass them when generating.
  refs: z.array(z.string()).default([]),
  status: z.enum(['pending', 'generating', 'ready', 'error']).default('pending'),
  videoSrc: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  naturalDuration: z.number(),
  sourceFps: z.number().default(24),
  // Token cost charged at generation time, for the credits pill.
  costCredits: z.number().nullable().default(null),
  labels: z.array(z.string()).optional(),
});

export const VideoImportSceneSchema = z.object({
  id: z.string(),
  kind: z.literal('video-import'),
  videoSrc: z.string(),
  naturalDuration: z.number(),
  sourceFps: z.number().default(24),
  labels: z.array(z.string()).optional(),
});

/**
 * Static-image overlay scene — a PNG / WebP / JPG dropped on a track to
 * sit on top of whatever video is playing underneath. Distinct from
 * video-import because:
 *   • no `videoSrc` (it's an image, not a video file),
 *   • `naturalDuration` is purely user-set (the user picks how long the
 *     overlay stays on screen — there's no "source duration"),
 *   • the renderer composites with alpha rather than replacing the
 *     underlying video (the flattener skips its carve pass for these,
 *     so V1 plays through under it),
 *   • the preview shows it as a layered `<img>` over the `<video>`.
 *
 * Currently only static images are supported. Animated PNG / WebP /
 * GIF can be added later — the render path would change to feed the
 * frame source through a different ffmpeg input + loop config.
 */
export const ImageOverlaySceneSchema = z.object({
  id: z.string(),
  kind: z.literal('image-overlay'),
  imageSrc: z.string(),                                     // path under assets/
  naturalDuration: z.number().default(3),                   // user-set; 3s default
  labels: z.array(z.string()).optional(),
});

export const SceneSchema = z.discriminatedUnion('kind', [
  PikaGenSceneSchema,
  VideoImportSceneSchema,
  ImageOverlaySceneSchema,
]);

export type Scene = z.infer<typeof SceneSchema>;

// ─── Track + clip definitions ─────────────────────────────────────────────

export const ClipSchema = z.object({
  id: z.string(),
  trackId: z.string(),
  sceneId: z.string(),
  start: z.number(),       // seconds on master timeline
  in: z.number(),          // seconds inside the scene
  out: z.number(),         // seconds inside the scene
  rate: z.number().default(1.0),
  fadeIn: z.number().default(0),
  fadeOut: z.number().default(0),
  smoothFps: z.boolean().default(false),
  // Per-clip gain (dB) applied to the V clip's EMBEDDED audio at render
  // time and in the preview's <video> element. Only meaningful when
  // there's no linked A-lane clip carrying the audio (otherwise gain
  // lives on the A clip). 0 = unchanged; the inspector slider exposes
  // -40 → +12 dB matching the audio-clip slider semantics.
  gain: z.number().default(0),
  linkId: z.string().nullable().default(null),
  comments: z.array(z.object({
    id: z.string(),
    at: z.number(),                                  // master-time within clip
    note: z.string(),
    author: z.enum(['user', 'agent']).default('user'),
    resolved: z.boolean().default(false),
    resolvedAt: z.string().nullable().default(null), // ISO timestamp
    agentReply: z.string().nullable().default(null), // short summary of what the agent did
  })).default([]),
});

export type Clip = z.infer<typeof ClipSchema>;

export const TrackSchema = z.object({
  id: z.string(),
  // Display name shown in the lane label. null = use the canonical "V1/V2/…"
  // derived from array order. Editable from the timeline UI.
  label: z.string().nullable().default(null),
  // `kind` retained for back-compat reads; new tracks are always 'video' —
  // z-order is now determined by array order (later index = closer to the
  // viewer, i.e. on top). The legacy 'overlay' value is preserved on read
  // but normalized to 'video' on write.
  kind: z.enum(['video', 'overlay']).default('video'),
  // Per-track mute for embedded audio. When true: Preview's <video> is muted
  // AND the render pipeline skips this track's clips when building the audio
  // mix. Track-level rather than per-clip because the common ask is "kill
  // all the source audio on V2", not clip-by-clip. Existing projects default
  // to false (audio plays as today).
  audioMuted: z.boolean().default(false),
  clips: z.array(ClipSchema).default([]),
});

export type Track = z.infer<typeof TrackSchema>;

// ─── Unified audio model ──────────────────────────────────────────────────
//
// Replaces the legacy split between `music.clips` (one music lane) and
// `sfx.clips[].lane: VO|SFX1|SFX2` (three SFX-style lanes). Now every audio
// item — generated music, extracted dialogue, generated SFX, imported clip
// — is just an AudioClip on some AudioTrack. Tracks have user-editable
// labels and per-track gain. Auto-place logic creates a new track when a
// clip would collide with another on the same lane.
//
// The `kind` field is a soft hint for the UI / agent, not a behavioral
// switch: anywhere the renderer or audio engine consumes a clip, only the
// usual {src, start, in, out, gain, fadeIn, fadeOut, linkId} fields are
// used. `kind` lets the chip in the timeline say "music" vs "VO" without
// the old hard-typed lanes.

export const AudioClipSchema = z.object({
  id: z.string(),
  src: z.string().default(''),
  start: z.number(),
  in: z.number(),
  out: z.number(),
  gain: z.number().default(0),
  fadeIn: z.number().default(0),
  fadeOut: z.number().default(0),
  linkId: z.string().nullable().default(null),
  prompt: z.string().nullable().default(null),
  naturalDuration: z.number().default(0),
  // Soft tag. Recognized values are documentation-only; the renderer
  // doesn't branch on them.
  kind: z.enum(['music', 'vo', 'sfx', 'voice', 'imported', 'generated']).default('sfx'),
  status: z.enum(['pending', 'generating', 'ready', 'error']).default('ready'),
  errorMessage: z.string().nullable().default(null),
});
export type AudioClip = z.infer<typeof AudioClipSchema>;

export const AudioTrackSchema = z.object({
  id: z.string(),
  label: z.string().nullable().default(null),
  gain: z.number().default(0),
  clips: z.array(AudioClipSchema).default([]),
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

// ─── Music + SFX ──────────────────────────────────────────────────────────

export const MusicClipSchema = z.object({
  id: z.string(),
  start: z.number(),
  in: z.number(),
  out: z.number(),
  gain: z.number().default(0),
  fadeIn: z.number().default(0),
  fadeOut: z.number().default(0),
  // PER-CLIP mp3 path. Empty = pending (not yet generated). The audio engine
  // loads this per clip, so multiple gens on the same project produce
  // independent tracks that don't overwrite each other.
  // Legacy projects with no per-clip src fall back to the project-level
  // `music.src` at load time (see TimelineSchema preprocess below).
  src: z.string().default(''),
  // Music-lane gens: when the user paints a region + a prompt, server creates
  // a pending music clip with the prompt + target duration. ElevenLabs (or
  // the agent) fills `src` once the audio lands.
  prompt: z.string().nullable().default(null),
  status: z.enum(['pending', 'generating', 'ready', 'error']).default('ready'),
  errorMessage: z.string().nullable().default(null),
  // Source duration of the rendered audio (set when the file lands). Trim
  // handlers use this as the upper bound so the user can't drag past the
  // available content. Defaults to 0 = unknown; we fall back to clip.out.
  naturalDuration: z.number().default(0),
});

export const MusicSchema = z.object({
  // LEGACY — kept for back-compat. Was the project-wide music source before
  // per-clip src landed. New projects should leave this empty; the loader
  // migrates legacy data by copying src down onto every clip that has none.
  src: z.string().default(''),
  gain: z.number().default(0),
  clips: z.array(MusicClipSchema).default([]),
}).transform((m) => {
  // Migration: if any clip has no src but the project has music.src, fill
  // the clip's src from it. Once migrated, the per-clip src is canonical.
  if (m.src && m.clips.some((c) => !c.src)) {
    return { ...m, clips: m.clips.map((c) => c.src ? c : { ...c, src: m.src }) };
  }
  return m;
});

export const SfxClipSchema = z.object({
  id: z.string(),
  src: z.string(),
  start: z.number(),
  in: z.number(),
  out: z.number(),
  gain: z.number().default(-3),
  fadeIn: z.number().default(0),
  fadeOut: z.number().default(0),
  // Audio lane assignment. VO = the diegetic dialogue / ambient extracted
  // from generated videos (one per scene, linked via linkId to the V1 clip).
  // SFX1 / SFX2 = independently placed sound effects. Legacy timelines used
  // S1/S2 — those are migrated on load: S1 → VO, S2 → SFX1.
  lane: z.preprocess(
    (v) => (v === 'S1' ? 'VO' : v === 'S2' ? 'SFX1' : v),
    z.enum(['VO', 'SFX1', 'SFX2']).default('SFX1'),
  ),
  linkId: z.string().nullable().default(null),
  // Human-friendly label (the prompt that generated it, or imported filename).
  // Displayed on the clip instead of the random slug.
  prompt: z.string().nullable().default(null),
  // Source mp3 duration after gen completes; trim handlers cap at this.
  naturalDuration: z.number().default(0),
});

export const SfxSchema = z.object({
  // Master gain for the whole non-music side (kept for backward compat;
  // typically left at 0dB — the per-lane mixer below does the real work).
  gain: z.number().default(0),
  // Per-lane mixer values in dB. Audio engine has one GainNode per lane that
  // multiplies into the master sfx node before going to the master output.
  voGain: z.number().default(0),
  sfx1Gain: z.number().default(0),
  sfx2Gain: z.number().default(0),
  clips: z.array(SfxClipSchema).default([]),
});

// ─── Render history ───────────────────────────────────────────────────────

export const RenderJobSchema = z.object({
  id: z.string(),
  fps: z.number(),
  format: z.enum(['mp4', 'webm', 'mov']).default('mp4'),
  preset: z.enum(['draft', 'standard', 'high']).default('standard'),
  out: z.string(),
  smooth: z.boolean().default(false),
  startedAt: z.string(),
  finishedAt: z.string().nullable().default(null),
  status: z.enum(['queued', 'running', 'done', 'error']).default('queued'),
  elapsedSec: z.number().default(0),
  errorMessage: z.string().nullable().default(null),
});

// ─── Project-level metadata ───────────────────────────────────────────────

export const AspectSchema = z.enum(['16:9', '9:16', '1:1', '4:5', '4:3']);
export const ResolutionSchema = z.enum(['720p', '1080p', '4K']);
export type Aspect = z.infer<typeof AspectSchema>;
export type Resolution = z.infer<typeof ResolutionSchema>;

const ASPECT_DIMS: Record<z.infer<typeof AspectSchema>, [number, number]> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1':  [1, 1],
  '4:5':  [4, 5],
  '4:3':  [4, 3],
};
const RES_LONG_EDGE: Record<z.infer<typeof ResolutionSchema>, number> = {
  '720p':  1280,
  '1080p': 1920,
  '4K':    3840,
};

export function resolveDimensions(aspect: Aspect, resolution: Resolution): { width: number; height: number } {
  const [aw, ah] = ASPECT_DIMS[aspect];
  const long = RES_LONG_EDGE[resolution];
  if (aw >= ah) {
    const width = long;
    const height = Math.round((long * ah) / aw);
    return { width, height };
  }
  const height = long;
  const width = Math.round((long * aw) / ah);
  return { width, height };
}

// ─── Floating comments (clip-less notes) ──────────────────────────────────
//
// A floating comment sits on the timeline at a master-time `at` but isn't
// attached to a clip. Two uses:
//   • Plain timeline-level note ("agent: cut down the middle act, it drags")
//   • Companion to a "ghost clip" placeholder ("describe what goes here")
// Same shape as clip-level comments + an optional `ghostClipId` linking it
// to its placeholder clip.

export const FloatingCommentSchema = z.object({
  id: z.string(),
  at: z.number(),
  trackId: z.string().default('v1'),
  note: z.string(),
  author: z.enum(['user', 'agent']).default('user'),
  resolved: z.boolean().default(false),
  resolvedAt: z.string().nullable().default(null),
  agentReply: z.string().nullable().default(null),
  ghostClipId: z.string().nullable().default(null),
});
export type FloatingComment = z.infer<typeof FloatingCommentSchema>;

// ─── Captions (CC lane) ──────────────────────────────────────────────────
//
// Live editable text rendered as an overlay during playback and burned in
// at render time. Generation pipeline (auto-caption): extract VO audio →
// Whisper word-level timestamps → align against the agent's VO script via
// dynamic-programming edit-distance → emit rows with the script's text and
// Whisper's timings. Manual entry uses the same row shape.

// Legacy `position` enum (top/mid/bottom) is translated to xPct/yPct in
// `migrateCaptionStyle` (state.ts) at read time so existing timelines
// don't snap to the bottom default. New writes never include `position`.
export const CaptionStyleSchema = z.object({
  font: z.string().default('Telka Extended'),
  // Pixel size in 1080p reference space; preview/render scale to actual
  // canvas height so a 36 here looks the same at 720p vs 1080p vs 4K.
  size: z.number().default(36),
  weight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(800), z.literal(900)]).default(800),
  color: z.string().default('#ffffff'),
  // Background fill behind the text — only rendered when bgEnabled is true.
  bgEnabled: z.boolean().default(true),
  bg: z.string().default('rgba(13,13,13,0.65)'),
  // Free positioning, 0–100% of canvas. Anchor is the caption box's center
  // (so xPct=50,yPct=92 lands the caption centered horizontally and near
  // the bottom, TikTok-style).
  xPct: z.number().default(50),
  yPct: z.number().default(92),
  // Horizontal padding inside the bg pill, vertical line padding around the bg.
  padX: z.number().default(14),
  padY: z.number().default(6),
  // 0–1 corner rounding factor for the bg pill (0 = square, 1 = full pill).
  radius: z.number().default(0.5),
  // 'caps' transforms text to uppercase at render time (handy for Telka).
  textCase: z.enum(['none', 'caps']).default('none'),
  // Horizontal alignment WITHIN the caption box (multi-line wraps respect
  // this). Track-locked like xPct/yPct — never overridden per row.
  align: z.enum(['left', 'center', 'right']).default('center'),
  // Stroke around each glyph. When `enabled`, drawn at `width` px (1080-ref
  // space) in `color`. Independent of bg.
  outline: z.object({
    enabled: z.boolean().default(false),
    color: z.string().default('#000000'),
    width: z.number().default(2),
  }).default({}),
  // Drop shadow. dx/dy in 1080-ref px; blur in 1080-ref px (libass treats
  // shadow as a single-offset blur — we approximate with `Shadow` value).
  shadow: z.object({
    enabled: z.boolean().default(false),
    color: z.string().default('rgba(0,0,0,0.8)'),
    blur: z.number().default(4),
    dx: z.number().default(0),
    dy: z.number().default(3),
  }).default({}),
});
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const CaptionRowSchema = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  text: z.string().default(''),
  // Per-row override of the track's defaultStyle. Sparse — only the fields
  // the user changed for this row land here. Renderer merges row over default.
  style: CaptionStyleSchema.partial().nullable().default(null),
  // Optional link to a source clip — useful when the row was generated from
  // a specific scene's VO so regen flows can recompute it.
  linkSceneId: z.string().nullable().default(null),
});
export type CaptionRow = z.infer<typeof CaptionRowSchema>;

export const CaptionsSchema = z.object({
  enabled: z.boolean().default(true),
  defaultStyle: CaptionStyleSchema.default({}),
  rows: z.array(CaptionRowSchema).default([]),
});
export type Captions = z.infer<typeof CaptionsSchema>;

// ─── Timeline ─────────────────────────────────────────────────────────────
//
// Legacy → unified audio migration runs once on read. The legacy `music` +
// `sfx` (with VO/SFX1/SFX2 sub-lanes) collapse into `audioTracks`:
//   - A1 "Music" — every music clip
//   - A2 "VO"    — every SFX clip with lane=VO (auto-extracted dialogue)
//   - A3 "SFX"   — every SFX clip with lane=SFX1
//   - A4 "SFX 2" — every SFX clip with lane=SFX2
// Track gains carry over: music.gain → A1, sfx.voGain/sfx1Gain/sfx2Gain →
// A2/A3/A4. After migration the legacy fields are blanked on the next write.

function migrateLegacyAudio(input: any): any {
  if (!input || typeof input !== 'object') return input;
  if (Array.isArray(input.audioTracks)) return input;   // already migrated

  const cleanAudio = (c: any, kind: string, fallbackSrc?: string) => ({
    id: c.id,
    src: c.src || fallbackSrc || '',
    start: c.start,
    in: c.in,
    out: c.out,
    gain: typeof c.gain === 'number' ? c.gain : 0,
    fadeIn: c.fadeIn ?? 0,
    fadeOut: c.fadeOut ?? 0,
    linkId: c.linkId ?? null,
    prompt: c.prompt ?? null,
    naturalDuration: c.naturalDuration ?? 0,
    kind,
    status: c.status ?? 'ready',
    errorMessage: c.errorMessage ?? null,
  });

  const audioTracks: any[] = [];

  const music = input.music;
  if (music && Array.isArray(music.clips) && music.clips.length > 0) {
    audioTracks.push({
      id: 'a1', label: 'Music', gain: music.gain ?? 0,
      clips: music.clips.map((c: any) => cleanAudio(c, 'music', music.src)),
    });
  }
  const sfxClips = input.sfx?.clips ?? [];
  const byLane = (lane: string) => sfxClips.filter((c: any) => c.lane === lane);
  const voClips   = byLane('VO');
  const sfx1Clips = byLane('SFX1');
  const sfx2Clips = byLane('SFX2');
  if (voClips.length)   audioTracks.push({ id: `a${audioTracks.length + 1}`, label: 'VO',    gain: input.sfx?.voGain ?? 0,   clips: voClips.map((c: any) => cleanAudio(c, 'vo')) });
  if (sfx1Clips.length) audioTracks.push({ id: `a${audioTracks.length + 1}`, label: 'SFX',   gain: input.sfx?.sfx1Gain ?? 0, clips: sfx1Clips.map((c: any) => cleanAudio(c, 'sfx')) });
  if (sfx2Clips.length) audioTracks.push({ id: `a${audioTracks.length + 1}`, label: 'SFX 2', gain: input.sfx?.sfx2Gain ?? 0, clips: sfx2Clips.map((c: any) => cleanAudio(c, 'sfx')) });

  // Always have at least one audio track so the UI has a place to drop new
  // clips into without forcing the user to "add lane" first.
  if (audioTracks.length === 0) audioTracks.push({ id: 'a1', label: null, gain: 0, clips: [] });

  return { ...input, audioTracks };
}

export const TimelineSchema = z.preprocess(migrateLegacyAudio, z.object({
  version: z.literal(2),
  name: z.string().default('Untitled project'),
  aspect: AspectSchema.default('16:9'),
  resolution: ResolutionSchema.default('1080p'),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(24),
  duration: z.number(),
  bpm: z.number().nullable().default(null),
  downbeats: z.array(z.number()).default([]),
  beats: z.array(z.number()).default([]),
  // Legacy shape kept readable but emptied on write — see migrateLegacyAudio.
  music: MusicSchema.nullable().default(null),
  sfx: SfxSchema.default({ clips: [] }),
  // NEW canonical audio surface. Multiple tracks; auto-place puts new clips
  // on a track that doesn't collide, or creates a new one.
  audioTracks: z.array(AudioTrackSchema).default([{ id: 'a1', label: null, gain: 0, clips: [] }]),
  tracks: z.array(TrackSchema).default([]),
  scenes: z.array(SceneSchema).default([]),
  floatingComments: z.array(FloatingCommentSchema).default([]),
  captions: CaptionsSchema.default({ enabled: true, defaultStyle: {} as any, rows: [] }),
  render: z.object({
    preset: z.enum(['draft', 'standard', 'high']).default('standard'),
    lastJobs: z.array(RenderJobSchema).default([]),
  }).default({ preset: 'standard', lastJobs: [] }),
}).superRefine((tl, ctx) => {
  /**
   * Cross-field invariant: for pika-gen scenes, `status === 'ready'`
   * IMPLIES `videoSrc !== null`. Without this check the auto-bind code
   * could (and did, on 2026-05-20) PATCH a scene to ready without a
   * videoSrc — the mp4 sat orphaned on disk while the timeline thought
   * the scene was complete with no video to play. The runtime guard
   * here, plus the migrateOrphanReadyScenes step in state.ts that
   * demotes existing bad scenes on read, plus the isVideo regex fix
   * in pika-mcp.ts, together make this state genuinely unreachable.
   */
  tl.scenes.forEach((scene, i) => {
    if (scene.kind === 'pika-gen' && scene.status === 'ready' && (scene.videoSrc === null || scene.videoSrc === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `pika-gen scene ${scene.id} has status='ready' but videoSrc is null. Either set videoSrc or use status='pending'/'generating'.`,
        path: ['scenes', i, 'videoSrc'],
      });
    }
  });
}));

export type Timeline = z.infer<typeof TimelineSchema>;

// ─── Comments (parsed from comments.md) ───────────────────────────────────

export const CommentBlockSchema = z.object({
  scene: z.string(),
  at: z.number(),
  selector: z.string().nullable(),
  note: z.string(),
  resolved: z.boolean().default(false),
});

export type CommentBlock = z.infer<typeof CommentBlockSchema>;
