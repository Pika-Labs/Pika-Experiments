// Mirrors server/src/schema.ts

export type SceneKind = 'pika-gen' | 'video-import' | 'image-overlay';

export interface SceneBase { id: string; kind: SceneKind; naturalDuration: number; labels?: string[] }

export interface PikaGenScene extends SceneBase {
  kind: 'pika-gen';
  sourceFps: number;
  prompt: string;
  model: string;
  refs: string[];
  status: 'pending' | 'generating' | 'ready' | 'error';
  videoSrc: string | null;
  errorMessage: string | null;
  costCredits: number | null;
}

export interface VideoImportScene extends SceneBase {
  kind: 'video-import';
  sourceFps: number;
  videoSrc: string;
}

/** Static-image overlay (PNG / WebP / JPG). Compositions with alpha,
 *  doesn't carve V1 underneath. See server schema for full notes. */
export interface ImageOverlayScene extends SceneBase {
  kind: 'image-overlay';
  imageSrc: string;
}

export type Scene = PikaGenScene | VideoImportScene | ImageOverlayScene;

export interface ClipComment {
  id: string;
  at: number;
  note: string;
  author?: 'user' | 'agent';
  resolved: boolean;
  resolvedAt?: string | null;
  agentReply?: string | null;
}

export interface FloatingComment {
  id: string;
  at: number;
  trackId: string;
  note: string;
  author: 'user' | 'agent';
  resolved: boolean;
  resolvedAt: string | null;
  agentReply: string | null;
  ghostClipId: string | null;
}

export interface Clip {
  id: string;
  trackId: string;
  sceneId: string;
  start: number;
  in: number;
  out: number;
  rate: number;
  fadeIn: number;
  fadeOut: number;
  smoothFps: boolean;
  linkId?: string | null;
  /** Per-clip gain (dB) for the V clip's embedded audio. Only honored
   *  when the clip has no linkId (otherwise audio comes from the A-lane
   *  clip and gain lives there). Default 0 = unchanged. */
  gain?: number;
  comments: ClipComment[];
}

export interface Track {
  id: string;
  label: string | null;
  kind: 'video' | 'overlay';
  /** When true, the embedded audio of every clip on this track is silenced
   *  in BOTH the preview and the render output. Toggled via the speaker
   *  icon next to V1/V2 in the lane header. */
  audioMuted?: boolean;
  clips: Clip[];
}

// Unified audio model — replaces MusicClip + SfxClip. Every audio item
// (generated music, extracted VO, generated SFX, imported file) lives on
// some AudioTrack in timeline.audioTracks. `kind` is a soft tag for UI
// labeling, not a behavioral switch — the renderer + audio engine treat
// every AudioClip identically.
export interface AudioClip {
  id: string;
  src: string;
  start: number;
  in: number;
  out: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  linkId: string | null;
  prompt: string | null;
  naturalDuration: number;
  kind: 'music' | 'vo' | 'sfx' | 'voice' | 'imported' | 'generated';
  status: 'pending' | 'generating' | 'ready' | 'error';
  errorMessage: string | null;
}

export interface AudioTrack {
  id: string;
  label: string | null;       // null → derive from index ("A1", "A2", …)
  gain: number;
  clips: AudioClip[];
}

// Back-compat aliases — some components still type as MusicClip / SfxClip
// during the migration. Both are now structurally a subset of AudioClip,
// so existing call sites that read .start/.in/.out/.gain/etc. keep working.
export type MusicClip = AudioClip;
export type SfxClip = AudioClip;

export type Aspect = '16:9' | '9:16' | '1:1' | '4:5' | '4:3';
export type Resolution = '720p' | '1080p' | '4K';

export interface CaptionOutline {
  enabled: boolean;
  color: string;
  width: number;
}
export interface CaptionShadow {
  enabled: boolean;
  color: string;
  blur: number;
  dx: number;
  dy: number;
}
export interface CaptionStyle {
  font: string;
  size: number;
  weight: 400 | 500 | 600 | 700 | 800 | 900;
  color: string;
  bgEnabled: boolean;
  bg: string;
  xPct: number;   // 0-100, caption box center horizontally
  yPct: number;   // 0-100, caption box center vertically
  padX: number;
  padY: number;
  radius: number;
  textCase: 'none' | 'caps';
  align: 'left' | 'center' | 'right';
  outline: CaptionOutline;
  shadow: CaptionShadow;
}

export interface CaptionRow {
  id: string;
  start: number;
  end: number;
  text: string;
  style: Partial<CaptionStyle> | null;
  linkSceneId: string | null;
}

export interface Captions {
  enabled: boolean;
  defaultStyle: CaptionStyle;
  rows: CaptionRow[];
}

export interface Timeline {
  version: 2;
  name: string;
  aspect: Aspect;
  resolution: Resolution;
  fps: 24 | 30 | 60;
  duration: number;
  bpm: number | null;
  downbeats: number[];
  beats: number[];
  // Legacy fields kept for transitional reads — the server migrates them
  // into `audioTracks` on every load, so new code should never write here.
  music: { src: string; gain: number; clips: MusicClip[] } | null;
  sfx: { gain: number; clips: SfxClip[] };
  audioTracks: AudioTrack[];
  tracks: Track[];
  scenes: Scene[];
  floatingComments: FloatingComment[];
  captions: Captions;
  render: { preset: 'draft' | 'standard' | 'high'; lastJobs: any[] };
}

export interface ServerEvent {
  type:
    | 'timeline-changed'
    | 'comments-changed'
    | 'beats-changed'
    | 'asset-added'
    | 'render-progress'
    | 'render-done'
    | 'render-error'
    | 'pika-gen-progress'
    | 'sfx-ready'
    | 'sfx-error'
    | 'project-changed'
    | 'agent-action'
    | 'pika-auth-changed'
    | 'pika-live-gen'
    | 'gen-job'
    | 'reconciler-health'
    | 'persona-loaded';
  [key: string]: any;
}

export type AgentAction =
  | { kind: 'set_view'; view: 'timeline' | 'workspace' }
  | { kind: 'select_clip'; ids: string[] }
  | { kind: 'set_playhead'; t: number }
  | { kind: 'play_pause'; play?: boolean }
  | { kind: 'set_zoom'; px: number }
  | { kind: 'set_tool'; tool: 'select' | 'blade' | 'slip' | 'ripple' | 'stretch' | 'comment' }
  | { kind: 'open_modal'; modal: 'projects' | null };

// Aspect ratio → canvas px ratio for the preview pane
export function aspectRatio(a: Aspect): number {
  if (a === '16:9') return 16/9;
  if (a === '9:16') return 9/16;
  if (a === '1:1') return 1;
  if (a === '4:3') return 4/3;
  return 4/5;
}
