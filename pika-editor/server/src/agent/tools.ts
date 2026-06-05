/**
 * Tool definitions and executors for the in-app agent.
 *
 * Two families:
 *  - File system tools (read_file / write_file / edit_file / list_dir / glob /
 *    grep / bash) — sandboxed via resolveSafe(). These give the agent the same
 *    reach Claude Code has, scoped to the editor's allowed roots.
 *  - Editor API tools (read_timeline / create_scene / patch_scene /
 *    list_comments / patch_comment / write_workspace) — wrappers around the
 *    existing HTTP routes so the agent doesn't have to construct fetches.
 *
 * Each tool returns { content, error?, preview }. `preview` is a short string
 * surfaced to the chat UI; `content` is what's appended to the conversation as
 * the tool_result block.
 */
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import { resolveSafe, relForDisplay, checkBashCommand } from './sandbox.js';
import { readTimeline, writeTimeline, paths, setProject, ProjectLockedError, writeWorkspaceAtomic, mutateWorkspace } from '../state.js';
import { startWatcher } from '../watcher.js';
import { listProjects, touchProject, slugify, emptyTimelineJson } from '../routes/projects.js';
import { TimelineSchema, type Scene, type Clip } from '../schema.js';
import { events } from '../events.js';
import { isPikaTool, callPikaTool, getModelForGenId } from './pika-mcp.js';
import { getJob as getGenJob } from './gen-jobs.js';
import { splitClipAtMaster, rippleInsert } from './clip-ops.js';
import { detectSceneCuts } from '../workers/scene-detect.js';

const MAX_READ_BYTES = 200 * 1024;       // 200KB — large enough for SKILL.md, briefs, workspace.json
const MAX_BASH_OUTPUT = 12 * 1024;       // 12KB — enough to see the meaningful tail
const BASH_TIMEOUT_MS = 60_000;

export interface ToolResult {
  content: string;
  error?: boolean;
  preview?: string;
}

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the project, skills, brand-kit, or tmp. Returns the content with line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or project-relative path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a UTF-8 text file. Creates the file (and parent directories) if it does not exist. Overwrites if it does. Only the active project and tmp are writable.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one or all occurrences of an exact string in a file. Fails if old_string is not found, or if it occurs more than once and replace_all is not set.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description: 'List entries of a directory with file sizes. Single-level (non-recursive).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'glob',
    description: 'List files matching a glob pattern. Pattern is relative to the active project unless absolute. Returns up to 200 paths.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: "e.g. 'assets/refs/**/*.png'" } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search files for a regex pattern. Returns matching lines with line numbers. Up to 100 matches.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Optional path to search (file or directory). Defaults to project root.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command. cwd defaults to the active project. Output truncated to 12KB; timeout 60s. Destructive patterns are blocked.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Optional working directory (project-scoped)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_timeline',
    description: 'Read the current timeline.json (the editor source of truth). Returns parsed JSON.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_scene',
    description: 'Append a new pending Pika-gen scene + clip to the timeline. Mirrors POST /scenes. By default the new clip lands at the end of the timeline (after the last existing clip on any video track) — OMIT startSec unless the user explicitly asks for a specific time. Passing the wrong startSec is the #1 cause of clips appearing "randomly" mid-sequence.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model: { type: 'string', description: 'e.g. seedance-2-pro-r2v, kling-v3-omni' },
        duration: { type: 'number', description: 'seconds' },
        refs: { type: 'array', items: { type: 'string' }, description: 'optional asset paths' },
        trackId: { type: 'string', enum: ['v1', 'v2'], description: 'default v1' },
        startSec: { type: 'number', description: 'OPTIONAL master-time start. Omit unless the user explicitly asks "place this at 12.5s" — the server appends to the end of the timeline by default, which is what you almost always want.' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['prompt', 'model', 'duration'],
    },
  },
  {
    name: 'detect_cuts',
    description: [
      'Run ffmpeg scene-change detection on a video file and return the cut timestamps in seconds (relative to the video start).',
      '',
      'Used to find the actual hard cuts in a multi-shot Seedance render before splitting on the timeline. Generally you DON\'T need to call this manually — the server runs it automatically when a scene flips to ready (auto-split) — but it\'s available for ad-hoc inspection or re-running detection with a different threshold.',
      '',
      'Threshold defaults to 0.4 (calibrated for stylized animation). Lower → more sensitive (catches softer transitions). Higher → only the hardest cuts.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path to the video, e.g. assets/pika/setup_15s.mp4' },
        threshold: { type: 'number', description: 'Scene-change score threshold (default 0.4)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'split_clip',
    description: [
      'Split a V1/V2 video clip at a specific master-time. The clip is cut into two pieces in place: the first half keeps the original id and linkId; the second half gets a new id (suffix _b, _c, ...) and a fresh linkId.',
      '',
      'If the original clip has a linked SFX (audio extracted on generation), the matching SFX clip on lane S1 is split at the same master-time. The second-half SFX inherits the second-half V1\'s new linkId — so each (video, audio) pair moves independently after.',
      '',
      'Use this AFTER a 15s Seedance batch lands to chop the single mp4 into per-beat sub-clips on the timeline. Call once per cut. atMasterTime must be strictly inside the clip\'s current range.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        atMasterTime: { type: 'number', description: 'absolute master-time on the timeline, strictly inside the clip range' },
      },
      required: ['clipId', 'atMasterTime'],
    },
  },
  {
    name: 'produce_scene',
    description: [
      'Plan a video scene end-to-end. The server creates the scene + V1 clip + workspace tile, fires the gen, polls until ready, downloads the asset, PATCHes the scene, updates the tile — all in one go. The agent only declares intent; the server owns every UI mutation.',
      '',
      'Returns immediately with a `gen_job_id` and a `scene_id`. Track progress via the workspace tile / timeline V1 clip — both auto-update. Do NOT call pika_generate_video / patch_scene / write_workspace afterwards to monitor; the server reconciles automatically.',
      '',
      'Prefer this over calling `create_scene` + `pika_generate_video` + `write_workspace` separately — it eliminates the "agent forgot one of the three steps" failure modes.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        prompt:   { type: 'string', description: 'Full Pika video prompt (Seedance / Kling grammar — load the matching skill).' },
        model:    { type: 'string', description: 'e.g. seedance-2-pro-r2v, kling-v3-omni, veo3' },
        duration: { type: 'number', description: 'Target clip duration in seconds' },
        refs:     { type: 'array',  items: { type: 'string' }, description: 'Optional ref image/video URLs or assets/ paths.' },
        labels:   { type: 'array',  items: { type: 'string' }, description: 'Optional descriptive labels for the scene.' },
        trackId:  { type: 'string', enum: ['v1', 'v2'], description: 'Default v1.' },
        startSec: { type: 'number', description: 'OPTIONAL master-time start. Omit unless the user explicitly asks for a specific time — defaults to end of timeline.' },
        sound:    { type: 'boolean', description: 'Native audio on (defaults to true for the dialogue/reference video tools).' },
      },
      required: ['prompt', 'model', 'duration'],
    },
  },
  {
    name: 'produce_workspace_image',
    description: [
      'Plan an image that lands on a workspace tile. The server creates the placeholder tile (or claims an existing one by id), fires the image gen, downloads the asset to assets/refs/<tile_id>.<ext> (or a custom path), and updates the tile.',
      '',
      'Returns a `gen_job_id` + `tile_id`. The tile auto-fills when ready — do NOT call write_workspace afterwards just to update src.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        tile_id:  { type: 'string', description: 'Stable id for the tile (and the resulting local file name). If a tile with this id already exists, it gets claimed.' },
        prompt:   { type: 'string' },
        provider: { type: 'string', enum: ['gpt-image-2', 'nano-banana-pro', 'gemini-flash-image', 'seedream'], description: 'Default gpt-image-2 (strongest identity preservation across refs; best for cast / location / product / prop / hero shots).' },
        refs:     { type: 'array', items: { type: 'string' }, description: 'Reference image URLs or assets/ paths.' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '3:4', '4:3'], description: 'Default 1:1.' },
        quality:  { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'gpt-image-2 only.' },
        resolution: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Default 1K.' },
        label:    { type: 'string', description: 'Display label for the tile.' },
        local_rel:{ type: 'string', description: 'Optional override for the save path. Default: assets/refs/<tile_id>.<ext>.' },
      },
      required: ['tile_id', 'prompt'],
    },
  },
  {
    name: 'gen_status',
    description: 'Read the current state of a gen job. Returns the full GenJob record (state, errorMessage, localPath, attempts log). Use this only when you genuinely need it — the agent normally just reacts to gen-event deltas in its next user turn.',
    input_schema: {
      type: 'object',
      properties: { gen_job_id: { type: 'string' } },
      required: ['gen_job_id'],
    },
  },
  {
    name: 'patch_scene',
    description: 'Update an existing scene (status, videoSrc, prompt, refs, etc). Mirrors PATCH /scenes/:id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: { type: 'object', additionalProperties: true },
      },
      required: ['id', 'patch'],
    },
  },
  {
    name: 'list_comments',
    description: 'List clip and floating comments (clip notes + timeline notes). Includes resolved flag.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'patch_comment',
    description: 'Update a comment (note, resolved, agentReply). Mark each one resolved as you ship it, not in bulk.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string' },
        resolved: { type: 'boolean' },
        agentReply: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'set_view',
    description: 'Switch the editor top-segment between the Workspace view (your producer pitch slide) and the Timeline view (the edit). Use this to point the user at what you want them to see.',
    input_schema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['timeline', 'workspace'] } },
      required: ['view'],
    },
  },
  {
    name: 'select_clip',
    description: 'Highlight one or more clips on the timeline. Pass an empty ids array to clear selection. Useful when you want the user to look at a specific clip you just changed.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Clip IDs to select' } },
      required: ['ids'],
    },
  },
  {
    name: 'set_playhead',
    description: 'Move the playhead to a specific master-time in seconds. Pair with play_pause to scrub-and-play a specific moment.',
    input_schema: {
      type: 'object',
      properties: { t: { type: 'number', description: 'Seconds on the master timeline' } },
      required: ['t'],
    },
  },
  {
    name: 'play_pause',
    description: 'Start or stop preview playback. Omit `play` to toggle.',
    input_schema: {
      type: 'object',
      properties: { play: { type: 'boolean', description: 'true=play, false=pause, omit=toggle' } },
    },
  },
  {
    name: 'set_zoom',
    description: 'Set the timeline zoom in pixels-per-second. Clamped to [20, 400]. Use lower values to fit longer projects; higher to see frame-level detail.',
    input_schema: {
      type: 'object',
      properties: { px: { type: 'number' } },
      required: ['px'],
    },
  },
  {
    name: 'set_tool',
    description: 'Switch the timeline interaction tool. select=move/trim, blade=split, slip=slip inside clip, ripple=ripple-trim, stretch=time-stretch, comment=drop note.',
    input_schema: {
      type: 'object',
      properties: { tool: { type: 'string', enum: ['select', 'blade', 'slip', 'ripple', 'stretch', 'comment'] } },
      required: ['tool'],
    },
  },
  {
    name: 'open_modal',
    description: 'Open or close the project switcher modal. Pass modal="projects" to open it (lets the user pick a different project), modal="close" to dismiss it.',
    input_schema: {
      type: 'object',
      properties: { modal: { type: 'string', enum: ['projects', 'close'] } },
      required: ['modal'],
    },
  },
  {
    name: 'delegate_to_claude',
    description: 'VOICE-AGENT-ONLY. Hand a substantive task (character creation, scene planning, "design X", "generate Y", "what should we do next") to the Claude text agent. Claude runs a full turn with its real toolbelt (file ops, editor API, every pika_* generation tool) against the same conversation memory the text chat uses, executes everything, and returns a short summary you read aloud. Use this for ANYTHING creative, generative, or multi-step. Do NOT use this for direct UI commands (play, pause, switch project, set gain) — call those tools yourself. The text agent NEVER sees this tool — recursion is impossible.',
    input_schema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'Clear, complete description of what the user wants done. Include all context the user mentioned in their voice turn (style, references, intent). Claude does not hear the voice; it only reads this brief.' },
      },
      required: ['brief'],
    },
  },
  {
    name: 'set_track_gain',
    description: 'Set an AUDIO TRACK\'s gain in dB — this is the mixer-level control (affects every clip on that track). Use this for "make the music lower", "boost the VO", "lower the SFX track". For a single clip only, use set_clip_gain instead. Track ids look like "a1", "a2", … — get them from read_timeline. Range: -40 to +12 dB. 0 is unity.',
    input_schema: {
      type: 'object',
      properties: {
        trackId: { type: 'string', description: 'Audio track id (e.g. "a1"). Get from read_timeline.' },
        db: { type: 'number', description: 'Target gain in dB. -40 to +12. 0 = unity.' },
      },
      required: ['trackId', 'db'],
    },
  },
  {
    name: 'set_clip_gain',
    description: 'Set a SINGLE audio clip\'s gain in dB — only affects this one clip, leaves the track alone. Use for "make THIS sfx louder" / "drop that specific clip 3 dB". For the whole track, use set_track_gain. Range: -40 to +12 dB.',
    input_schema: {
      type: 'object',
      properties: {
        clipId: { type: 'string', description: 'Audio clip id. Get from read_timeline.' },
        db: { type: 'number', description: 'Target gain in dB. -40 to +12.' },
      },
      required: ['clipId', 'db'],
    },
  },
  {
    name: 'delete_clip',
    description: 'Remove a clip from the timeline by id. Works for any clip kind — video (V1/V2), music, VO, SFX. The clip is gone immediately; the audio engine recomputes the next play. Use this when the user says "remove that", "delete it", "scrap that one". Always confirm in one short sentence after — voice mode otherwise stays silent.',
    input_schema: {
      type: 'object',
      properties: { clipId: { type: 'string', description: 'Clip id, get from read_timeline.' } },
      required: ['clipId'],
    },
  },
  {
    name: 'create_project',
    description: 'Create a NEW project with the given name, aspect ratio, resolution, and fps. Aspect/resolution/fps are LOCKED at creation — they shape the canvas + render output. Switches to the new project immediately (no separate switch_project call needed). Use this for "start a new project", "make a new 9:16 video", "new 4K project at 30fps".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name. Used as the directory slug too.' },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:5', '4:3'], description: 'Canvas aspect ratio. Default 16:9.' },
        resolution: { type: 'string', enum: ['720p', '1080p', '4K'], description: 'Render resolution. Default 1080p.' },
        fps: { type: 'number', enum: [24, 30, 60], description: 'Frames per second. Default 24.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_projects',
    description: 'List all projects available on this machine, newest-first. Returns an array of { name, dir, displayName, mtime } for each. Use this BEFORE switch_project so you know the exact name to pass.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'switch_project',
    description: 'Switch the active project (closes the current one + loads another). Pass the project `name` exactly as it appears in list_projects (e.g. "pika-agent-done"). The whole editor reloads and the current chat conversation continues against the new project.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project directory name (slug). Get this from list_projects.' } },
      required: ['name'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment. Either bound to a clip (pass clipId) or floating on the timeline (pass trackId + at). The agent author field is set automatically.',
    input_schema: {
      type: 'object',
      properties: {
        clipId: { type: 'string', description: 'Bind to this clip (mutually exclusive with floating)' },
        trackId: { type: 'string', description: 'Track for floating comments; defaults to v1' },
        at: { type: 'number', description: 'Master-time in seconds' },
        note: { type: 'string' },
      },
      required: ['at', 'note'],
    },
  },
  {
    name: 'start_render',
    description: 'Start an ffmpeg render of the timeline. preset: draft (fast/720p) | standard (1080p) | high (max quality).',
    input_schema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['draft', 'standard', 'high'] },
        fps: { type: 'number', enum: [24, 30, 60] },
      },
    },
  },
  {
    name: 'save_version',
    description: 'Snapshot the project to git with a human-readable name. Use this to mark a milestone before a risky edit.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'generate_sfx',
    description: 'Generate a sound effect via ElevenLabs and drop it on an audio track. The server picks a collision-free track automatically; pass `trackId` to prefer a specific one (a1, a2, …).',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        startSec: { type: 'number' },
        durationSec: { type: 'number', description: 'optional; defaults to model choice' },
        trackId: { type: 'string', description: 'Preferred audio track id (a1, a2, …). Omit to auto-place on the first track without a time collision.' },
      },
      required: ['prompt', 'startSec'],
    },
  },
  {
    name: 'generate_music',
    description: 'Create a pending music clip. The agent fills the placeholder with an instrumental mp3 via Minimax (no lyrics).',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        startSec: { type: 'number' },
        durationSec: { type: 'number' },
      },
      required: ['prompt', 'startSec', 'durationSec'],
    },
  },
  {
    name: 'auto_caption',
    description: [
      'Auto-generate caption rows for a scene\'s VO using Whisper-timed words aligned to the intended script.',
      '',
      'Pipeline: extracted VO audio → Pika transcribe_audio (Whisper, word-level timings) → DP-alignment of the script to the timings → caption rows with the SCRIPT\'s text at WHISPER\'s precise moments. This is the right way to caption agent-generated VO because Whisper is excellent at timing but bad at brand/character names, jargon, etc.',
      '',
      'Always pass `script` when you have it (you almost always do — it\'s the line(s) you wrote in plan.beats / the scene prompt). Without `script`, rows fall back to Whisper\'s verbatim transcription.',
      '',
      'Pass `replace: true` to clear existing caption rows whose time range overlaps the scene before adding the new ones (use after a regen). Default behavior is additive.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: 'The scene whose VO should be captioned. The server uses its linked SFX clip (sfx_<sceneId>) as the audio source.' },
        script: { type: 'string', description: 'The intended VO text. Use whitespace-separated words; punctuation is preserved on display. Strongly recommended.' },
        replace: { type: 'boolean', default: false },
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'update_plan',
    description: [
      'Write the project Plan — the production bible. Plan is DURABLE and only changes on user approval; do not write here as part of normal workspace iteration.',
      '',
      'Use this ONLY when the user has explicitly approved a workspace proposal and you are graduating those decisions into the canonical plan. Examples: storyboard set approved → write the approved frames into plan.beats; cast refs locked → write to plan.cast; user signs off on the shotlist → write plan.beats.',
      '',
      'Shape (permissive; only include sections you are updating — server merges over existing plan):',
      '  concept: short paragraph, agreed-on premise',
      '  styleAnchor: visual style anchor (markdown ok)',
      '  cast: [{id, name, role, refSrc, notes}]',
      '  locations: [{id, name, refSrc, notes}]',
      '  beats: [{id, label, timecode, durationSec, action, dialogue:[{who,line}], framingNote, storyboardSrc, videoSrc, model, status: "planned"|"storyboard-approved"|"video-ready"}]',
      '  music: {plan, cueRefs?:[]}',
      '  sfx: {plan}',
      '  openDecisions: [{id, question, options?:[]}]',
      '',
      'Pass the FULL plan you want to commit — server overwrites plan.json. The Plan tab in the browser auto-refreshes.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        concept: { type: 'string' },
        styleAnchor: { type: 'string' },
        cast: { type: 'array', items: { type: 'object', additionalProperties: true } },
        locations: { type: 'array', items: { type: 'object', additionalProperties: true } },
        beats: { type: 'array', items: { type: 'object', additionalProperties: true } },
        music: { type: 'object', additionalProperties: true },
        sfx: { type: 'object', additionalProperties: true },
        openDecisions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
  },
  {
    name: 'write_workspace',
    description: [
      'Replace projects/<active>/workspace.json with a new "producer\'s pitch slide" state. The Workspace view in the browser auto-refreshes.',
      '',
      'Top-level fields: phase, headline, subhead, body (markdown), primary{kind,items}, ask, activity[].',
      '',
      'primary.kind is one of: "image-grid" | "video-grid" | "two-up-compare" | "single" | "video-player" | "none".',
      '',
      'Each item in primary.items takes:',
      '  - src: "assets/..." path. OMIT when the asset isn\'t ready yet — the tile renders as a placeholder.',
      '  - pending: true while this tile is being generated. Drops when src lands.',
      '  - taskId: live-bind this tile to a Pika gen. After calling pika_generate_*, grab the [gen_id: ...] line from the tool result and pass that string here. The tile will then auto-update in real time as the gen progresses — flips to the result video the moment it completes, flips to a red "failed" state if it errors out, no second write_workspace call needed. STRONGLY RECOMMENDED for any tile you set as pending.',
      '  - label: short identifier e.g. "Beat 1 · 0:00–0:03"',
      '  - action: what happens in this beat, one short sentence (NOT cinematography)',
      '  - dialogue: array of {who, line} pairs — quote the actual words. Use [] for silent beats.',
      '  - caption: optional cinematography / technical note — small mono text at the bottom',
      '',
      'For storyboard / shot-list views: ALWAYS include action + dialogue so the user can read the story without opening the brief. Keep each one tight — one line of action, the literal line(s) spoken. Pictures alone are not enough.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        phase: { type: 'string' },
        headline: { type: 'string' },
        subhead: { type: 'string' },
        body: { type: 'string' },
        primary: {
          type: 'object',
          additionalProperties: true,
          properties: {
            kind: { type: 'string', enum: ['image-grid', 'video-grid', 'two-up-compare', 'single', 'video-player', 'none'] },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  src: { type: 'string' },
                  label: { type: 'string' },
                  action: { type: 'string' },
                  // Model that produced this asset — set this on every
                  // tile you write for a generated image/video so the
                  // UI badge can show it on hover (e.g. "kling-v3-omni",
                  // "gpt-image-2", "seedance-2-pro"). Persists past the
                  // 8s live-gen keep-alive window — without this the
                  // badge falls back to a generic "Image" / "Video".
                  model: { type: 'string' },
                  dialogue: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        who: { type: 'string' },
                        line: { type: 'string' },
                      },
                      required: ['line'],
                    },
                  },
                  caption: { type: 'string' },
                },
                required: ['src'],
              },
            },
          },
        },
        // `ask` is EITHER a freeform string OR a structured block:
        //   { headline?: string, body?: string,
        //     items: [{ id?, label: string, reply: string }] }
        // Each item becomes a button under the ask card that fills the
        // user's chat input with `reply` — a greenlight becomes one
        // click + Enter instead of typing. Prefer the structured form
        // when the user has discrete confirmations to give. Use the
        // string form for open-ended asks. Schema type is `{}` so both
        // shapes pass validation; the client renderer picks.
        ask: { description: 'string OR { headline?, body?, items: [{ id?, label, reply }] }' },
        activity: { type: 'array', items: { type: 'string' } },
      },
    },
  },
];

export async function executeTool(name: string, input: unknown): Promise<ToolResult> {
  try {
    // Pika MCP tools — dispatch through the local MCP client (token stays here)
    if (isPikaTool(name)) {
      return await callPikaTool(name, input);
    }
    const args = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'read_file':       return await toolReadFile(args);
      case 'write_file':      return await toolWriteFile(args);
      case 'edit_file':       return await toolEditFile(args);
      case 'list_dir':        return await toolListDir(args);
      case 'glob':            return await toolGlob(args);
      case 'grep':            return await toolGrep(args);
      case 'bash':            return await toolBash(args);
      case 'read_timeline':   return toolReadTimeline();
      case 'create_scene':    return toolCreateScene(args);
      case 'produce_scene':           return await toolProduceScene(args);
      case 'produce_workspace_image': return await toolProduceWorkspaceImage(args);
      case 'gen_status':              return toolGenStatus(args);
      case 'patch_scene':     return toolPatchScene(args);
      case 'split_clip':      return toolSplitClip(args);
      case 'detect_cuts':     return await toolDetectCuts(args);
      case 'list_comments':   return toolListComments();
      case 'patch_comment':   return toolPatchComment(args);
      case 'write_workspace': return toolWriteWorkspace(args);
      case 'update_plan':     return toolUpdatePlan(args);
      case 'set_view':        return toolSetView(args);
      case 'select_clip':     return toolSelectClip(args);
      case 'set_playhead':    return toolSetPlayhead(args);
      case 'play_pause':      return toolPlayPause(args);
      case 'set_zoom':        return toolSetZoom(args);
      case 'set_tool':        return toolSetTool(args);
      case 'open_modal':      return toolOpenModal(args);
      case 'delegate_to_claude': return await toolDelegateToClaude(args);
      case 'set_track_gain':  return toolSetTrackGain(args);
      case 'set_clip_gain':   return toolSetClipGain(args);
      case 'delete_clip':     return toolDeleteClip(args);
      case 'create_project':  return toolCreateProject(args);
      case 'list_projects':   return toolListProjects();
      case 'switch_project':  return toolSwitchProject(args);
      case 'add_comment':     return toolAddComment(args);
      case 'start_render':    return toolStartRender(args);
      case 'save_version':    return await toolSaveVersion(args);
      case 'generate_sfx':    return await toolGenerateSfx(args);
      case 'generate_music':  return await toolGenerateMusic(args);
      case 'auto_caption':    return await toolAutoCaption(args);
      default: return { content: `unknown tool: ${name}`, error: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `error: ${msg}`, error: true };
  }
}

/* ------- file tools ------- */

async function toolReadFile(args: Record<string, unknown>): Promise<ToolResult> {
  const r = resolveSafe(String(args.path));
  if (!existsSync(r.abs)) return { content: `file not found: ${args.path}`, error: true };
  const stat = statSync(r.abs);
  if (stat.isDirectory()) return { content: `path is a directory: ${args.path}`, error: true };
  if (stat.size > MAX_READ_BYTES) {
    return { content: `file too large (${stat.size} bytes; max ${MAX_READ_BYTES}). Use grep or bash head/tail.`, error: true };
  }
  const text = readFileSync(r.abs, 'utf8');
  const numbered = text.split('\n').map((line, i) => `${String(i + 1).padStart(5)}\t${line}`).join('\n');
  return { content: numbered, preview: `read ${relForDisplay(r.abs)} (${stat.size}B)` };
}

async function toolWriteFile(args: Record<string, unknown>): Promise<ToolResult> {
  const r = resolveSafe(String(args.path));
  if (!r.writable) return { content: `path is read-only: ${args.path}`, error: true };
  const content = String(args.content ?? '');
  mkdirSync(path.dirname(r.abs), { recursive: true });
  const tmp = r.abs + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, r.abs);
  events.broadcast({ type: 'asset-added', relPath: relForDisplay(r.abs) });
  return { content: `wrote ${content.length} bytes`, preview: `wrote ${relForDisplay(r.abs)}` };
}

async function toolEditFile(args: Record<string, unknown>): Promise<ToolResult> {
  const r = resolveSafe(String(args.path));
  if (!r.writable) return { content: `path is read-only: ${args.path}`, error: true };
  if (!existsSync(r.abs)) return { content: `file not found: ${args.path}`, error: true };
  const before = readFileSync(r.abs, 'utf8');
  const oldStr = String(args.old_string ?? '');
  const newStr = String(args.new_string ?? '');
  const replaceAll = Boolean(args.replace_all);
  if (!oldStr) return { content: `old_string is required`, error: true };
  const idx = before.indexOf(oldStr);
  if (idx < 0) return { content: `old_string not found in file`, error: true };
  if (!replaceAll) {
    const second = before.indexOf(oldStr, idx + oldStr.length);
    if (second >= 0) return { content: `old_string appears multiple times — pass replace_all: true, or use a longer string`, error: true };
  }
  const after = replaceAll ? before.split(oldStr).join(newStr) : (before.slice(0, idx) + newStr + before.slice(idx + oldStr.length));
  const tmp = r.abs + '.tmp';
  writeFileSync(tmp, after);
  renameSync(tmp, r.abs);
  events.broadcast({ type: 'asset-added', relPath: relForDisplay(r.abs) });
  return { content: `edit ok (${before.length} → ${after.length} bytes)`, preview: `edited ${relForDisplay(r.abs)}` };
}

async function toolListDir(args: Record<string, unknown>): Promise<ToolResult> {
  const r = resolveSafe(String(args.path));
  if (!existsSync(r.abs)) return { content: `not found: ${args.path}`, error: true };
  const stat = statSync(r.abs);
  if (!stat.isDirectory()) return { content: `not a directory: ${args.path}`, error: true };
  const entries = readdirSync(r.abs, { withFileTypes: true });
  const lines = entries.slice(0, 500).map((e) => {
    if (e.isDirectory()) return `d  ${e.name}/`;
    try {
      const s = statSync(path.join(r.abs, e.name));
      return `f  ${e.name}  ${s.size}B`;
    } catch { return `f  ${e.name}`; }
  });
  return { content: lines.join('\n') || '(empty)', preview: `ls ${relForDisplay(r.abs)} · ${entries.length} entries` };
}

async function toolGlob(args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = String(args.pattern ?? '');
  if (!pattern) return { content: 'pattern required', error: true };
  // Use shell glob via bash for simplicity — output goes through the safety check
  const cmd = `set -o pipefail; ls -1d ${pattern} 2>/dev/null | head -200`;
  const out = await runBash(cmd, paths.project);
  return { content: out.stdout || '(no matches)', preview: `glob ${pattern}` };
}

async function toolGrep(args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = String(args.pattern ?? '');
  if (!pattern) return { content: 'pattern required', error: true };
  const inPath = args.path ? resolveSafe(String(args.path)).abs : paths.project;
  // Prefer ripgrep if available; fall back to grep -rn
  const cmd = `command -v rg >/dev/null 2>&1 && rg -n --max-count 100 -- ${quote(pattern)} ${quote(inPath)} 2>/dev/null || grep -rn --max-count=100 -- ${quote(pattern)} ${quote(inPath)} 2>/dev/null`;
  const out = await runBash(cmd, paths.project);
  return { content: out.stdout || '(no matches)', preview: `grep ${pattern}` };
}

async function toolBash(args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command ?? '');
  const cwdArg = args.cwd ? String(args.cwd) : '';
  const check = checkBashCommand(command);
  if (!check.ok) return { content: `command blocked — ${check.reason}`, error: true };
  const cwd = cwdArg ? resolveSafe(cwdArg).abs : paths.project;
  const out = await runBash(command, cwd);
  const head = `$ ${command}\n[cwd: ${relForDisplay(cwd)}, exit: ${out.code}, time: ${out.elapsedMs}ms]\n`;
  const body = out.stdout + (out.stderr ? `\n--- stderr ---\n${out.stderr}` : '');
  return { content: head + truncate(body, MAX_BASH_OUTPUT), error: out.code !== 0, preview: `$ ${command.slice(0, 60)}${command.length > 60 ? '…' : ''}` };
}

function quote(s: string): string {
  // POSIX-safe single-quote escape
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} bytes]`;
}

function runBash(command: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number; elapsedMs: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('bash', ['-lc', command], { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, BASH_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: killed ? `${stderr}\n[timed out after ${BASH_TIMEOUT_MS}ms]` : stderr,
        code: code ?? -1,
        elapsedMs: Date.now() - t0,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n' + err.message, code: -1, elapsedMs: Date.now() - t0 });
    });
  });
}

/* ------- editor API tools ------- */

function toolReadTimeline(): ToolResult {
  const { timeline } = readTimeline();
  const summary = {
    duration: timeline.duration,
    fps: timeline.fps,
    aspect: timeline.aspect,
    resolution: timeline.resolution,
    sceneCount: timeline.scenes.length,
    videoTracks: timeline.tracks.map((t) => ({ id: t.id, label: t.label, clipCount: t.clips.length })),
    audioTracks: timeline.audioTracks.map((t) => ({ id: t.id, label: t.label, clipCount: t.clips.length })),
    floatingComments: timeline.floatingComments?.length ?? 0,
  };
  return {
    content: JSON.stringify({ summary, timeline }, null, 2),
    preview: `${summary.sceneCount} scenes · ${summary.duration}s · ${summary.aspect}`,
  };
}

async function toolCreateScene(args: Record<string, unknown>): Promise<ToolResult> {
  const { timeline } = readTimeline();
  const prompt = String(args.prompt ?? '');
  const model = String(args.model ?? '');
  const duration = Number(args.duration ?? 0);
  if (!prompt || !model || !(duration > 0)) {
    return { content: 'prompt, model, and duration are required', error: true };
  }
  const trackId = args.trackId ? String(args.trackId) : 'v1';
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) return { content: `unknown track: ${trackId}`, error: true };

  const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map(String) : [];
  const refs = Array.isArray(args.refs) ? (args.refs as unknown[]).map(String) : [];

  // sceneId + clipId
  const nextN = (prefix: string, arr: { id: string }[]): string => {
    const used = new Set(arr.map((x) => x.id));
    for (let i = arr.length + 1; i < arr.length + 200; i++) {
      const id = `${prefix}_${String(i).padStart(2, '0')}`;
      if (!used.has(id)) return id;
    }
    return `${prefix}_${Date.now()}`;
  };
  const sceneId = nextN('sc', timeline.scenes);
  const clipId = nextN('clip', timeline.tracks.flatMap((t) => t.clips));

  // Default placement: end of the WHOLE timeline (max clip end across all
  // video tracks), not just end-of-this-track. Aligns with the server's
  // POST /scenes default. Prevents the "new clip appears at 0s and shoves
  // everything" bug, and prevents V2 clips from being placed at a time
  // where V1 is shorter (or vice versa) producing visual gaps.
  const startSec = typeof args.startSec === 'number'
    ? args.startSec
    : timeline.tracks.reduce((acc, tr) =>
        tr.clips.reduce((a, c) => Math.max(a, c.start + (c.out - c.in) / (c.rate || 1)), acc),
      0);

  const scene: Scene = {
    id: sceneId,
    kind: 'pika-gen',
    prompt,
    model,
    refs,
    status: 'pending',
    videoSrc: null,
    errorMessage: null,
    naturalDuration: duration,
    sourceFps: 24,
    costCredits: null,
    labels,
  };

  const clip: Clip = {
    id: clipId,
    trackId,
    sceneId,
    start: startSec,
    in: 0,
    out: duration,
    rate: 1,
    fadeIn: 0,
    fadeOut: 0,
    smoothFps: false,
    gain: 0,
    linkId: null,
    comments: [],
  };

  // Ripple-insert: if the new clip lands MID-timeline, shift downstream
  // content forward by `duration` so V clips, audio, captions, and
  // floating comments past startSec stay in sync. No-op when the clip
  // appends at end-of-timeline (the typical agent path).
  const rippled = rippleInsert(timeline, clip.start, duration);
  const next = {
    ...rippled,
    scenes: [...rippled.scenes, scene],
    tracks: rippled.tracks.map((tr) => tr.id === trackId
      ? { ...tr, clips: [...tr.clips, clip].sort((a, b) => a.start - b.start) }
      : tr),
    duration: Math.max(rippled.duration, clip.start + duration),
  };
  TimelineSchema.parse(next);
  await writeTimeline(next);
  events.broadcast({ type: 'timeline-changed', sha: '' });
  return {
    content: JSON.stringify({ sceneId, clipId, startSec }, null, 2),
    preview: `+ ${sceneId} on ${trackId} @ ${startSec.toFixed(2)}s`,
  };
}

/**
 * Intent-only tools (Phase 2). The agent calls one of these instead of
 * the raw `pika_generate_*` + `create_scene` + `write_workspace` triple.
 * The server creates every required state in one atomic operation:
 *   - timeline scene (for produce_scene) or workspace tile (for
 *     produce_workspace_image) gets persisted first;
 *   - then callPikaTool fires with the matching __sceneId/__tileId/__localRel
 *     hint so the existing fire-and-forget pipeline (claim → poll →
 *     auto-bind → GenJob projection) carries the rest;
 *   - the tool returns the scene_id / tile_id / local_rel the agent
 *     should reference downstream — NOT the gen_job_id (which is
 *     server-internal bookkeeping).
 *
 * These tools eliminate the four most common agent-discretion failure
 * modes from the audit: (1) skipping the placeholder write, (2) firing
 * a gen against a scene that doesn't exist, (3) renaming a tile.id
 * mid-flight, and (4) reusing a CDN URL across choice tiles. The server
 * doesn't trust the agent for any UI-state transition; the agent only
 * declares intent.
 */
async function toolProduceScene(args: Record<string, unknown>): Promise<ToolResult> {
  // Step 1 — create the scene + clip on the timeline (placeholder).
  // Reuses toolCreateScene's full flow so the V1 clip and ripple-insert
  // behavior is identical to manual create_scene.
  const created = await toolCreateScene(args);
  if (created.error) return created;
  let sceneId: string;
  try {
    sceneId = JSON.parse(created.content).sceneId;
  } catch {
    return { content: `produce_scene: could not parse sceneId from create_scene result: ${created.content}`, error: true };
  }

  // Step 2 — decide which Pika tool to fire and shape args.
  // Refs in the agent's input map to `reference_images` (multi-ref) on
  // generate_reference_video. If none provided, plain generate_video.
  const refs = Array.isArray(args.refs) ? (args.refs as unknown[]).map(String) : [];
  const hasRefs = refs.length > 0;
  const toolName = hasRefs ? 'pika_generate_reference_video' : 'pika_generate_video';
  const pikaArgs: Record<string, unknown> = {
    prompt: args.prompt,
    model: args.model,
    duration: args.duration,
    sound: args.sound ?? true,
    __sceneId: sceneId,
  };
  if (hasRefs) pikaArgs.reference_images = refs;

  // Step 3 — fire. Returns [QUEUED]. GenJob + LiveGen are created
  // inside callPikaTool; the fire-and-forget runner handles everything.
  const fired = await callPikaTool(toolName, pikaArgs);
  if (fired.error) {
    // Scene exists but gen never started. Mark the scene as error so
    // the timeline doesn't show a permanent "Generating…" spinner.
    try {
      const port = process.env.PIKA_EDITOR_PORT ?? '3080';
      await fetch(`http://127.0.0.1:${port}/scenes/${encodeURIComponent(sceneId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'error', errorMessage: `gen failed to fire: ${fired.content.slice(0, 200)}` }),
      });
    } catch { /* best-effort */ }
    return { content: `produce_scene fired ${toolName} but it errored: ${fired.content}`, error: true };
  }

  return {
    content: [
      `[PRODUCING] scene_id: ${sceneId} · tool: ${toolName}`,
      ``,
      `Server is handling everything end-to-end: gen fires, polls Pika, downloads to assets/pika/${sceneId}.mp4, PATCHes the scene to ready, updates the timeline V1 clip. No follow-up tool calls needed.`,
      ``,
      `End your turn with a one-liner. Watch the workspace + timeline for the result.`,
    ].join('\n'),
    preview: `+ ${sceneId} (${toolName})`,
  };
}

async function toolProduceWorkspaceImage(args: Record<string, unknown>): Promise<ToolResult> {
  const tileId = String(args.tile_id ?? '').trim();
  if (!tileId) return { content: 'tile_id is required', error: true };
  const prompt = String(args.prompt ?? '').trim();
  if (!prompt) return { content: 'prompt is required', error: true };

  // Step 1 — make sure the tile exists. Match priority:
  //   1. exact id match (agent wrote the tile with this id)
  //   2. label match (case-insensitive, ignoring leading/trailing
  //      whitespace) — the agent commonly writes placeholders with a
  //      label like "Vinnie — Character Ref" and NO id, then fires
  //      produce_workspace_image with tile_id: "vinnie-ref". Without
  //      this fallback, the server can't connect the two and pushes a
  //      duplicate tile — the user sees TWO Vinnies in the workspace
  //      (one with the agent's full description, one with the
  //      server's minimal claim).
  // If no match by either id or label, push a new tile.
  await mutateWorkspace((cur: any) => {
    const items = Array.isArray(cur?.primary?.items) ? [...cur.primary.items] : [];
    let idx = items.findIndex((it: any) => it && it.id === tileId);
    if (idx < 0 && args.label) {
      const wantLabel = String(args.label).trim().toLowerCase();
      if (wantLabel) {
        // Find ALL label-matches. If exactly one, claim it. If more than
        // one, the label is ambiguous — fall through to creating a new
        // tile rather than guessing. Without this check, a label collision
        // ("Hero Shot" placeholder + another "Hero Shot" placeholder)
        // would always merge into the first match, silently leaving the
        // second un-gen'd and any agent intent to create a NEW tile with
        // the same label getting absorbed.
        const matches = items
          .map((it: any, i: number) => ({ it, i }))
          .filter(({ it }: any) => it && typeof it.label === 'string' && it.label.trim().toLowerCase() === wantLabel);
        if (matches.length === 1) {
          idx = matches[0].i;
        } else if (matches.length > 1) {
          console.warn(`[tools] produce_workspace_image label "${args.label}" matches ${matches.length} tiles — creating new tile instead of guessing.`);
        }
      }
    }
    const baseTile = {
      id: tileId,
      label: args.label ?? tileId,
      pending: true,
    };
    if (idx < 0) {
      items.push(baseTile);
    } else {
      // Adopt the id onto the existing (possibly id-less) tile so the
      // agent's description / dialogue / caption fields survive the
      // gen-fire path. Most server-owned fields (sceneId, src) on the
      // existing tile are preserved by the spread. EXCEPTION: when
      // we're re-claiming a tile that previously FAILED, we have to
      // clear `failed` + `errorMessage` so the UI flips back to the
      // pending spinner — otherwise the red "Generation Failed" card
      // sticks until the retry actually lands, which reads as "the
      // retry isn't happening." Same applies to a stale `src` from a
      // previous successful gen that the agent is now regenerating.
      const merged: Record<string, unknown> = { ...items[idx], ...baseTile };
      // ONLY drop the previous src when we're retrying a FAILED tile —
      // that case has no valid image, so clearing the field flips the
      // UI to the pending spinner instead of leaving a red error card.
      // When the agent re-fires on a SUCCESSFUL tile (e.g. "regenerate
      // with a better prompt"), keep the existing image visible during
      // the gen window so the user isn't staring at a spinner where a
      // working image was sitting a moment ago.
      const wasFailed = merged.failed === true;
      delete merged.failed;
      delete merged.errorMessage;
      if (wasFailed && merged.src) delete merged.src;
      items[idx] = merged;
    }
    const next = {
      ...cur,
      primary: { ...(cur?.primary ?? {}), kind: cur?.primary?.kind ?? 'image-grid', items },
    };
    return { next, result: undefined };
  });

  // Step 2 — fire the image gen.
  const provider = args.provider ?? 'gpt-image-2';
  const refs = Array.isArray(args.refs) ? (args.refs as unknown[]).map(String) : [];
  const localRel = args.local_rel ? String(args.local_rel) : undefined;
  const pikaArgs: Record<string, unknown> = {
    prompt,
    provider,
    __tileId: tileId,
  };
  if (localRel) pikaArgs.__localRel = localRel;
  if (refs.length > 0) pikaArgs.reference_images = refs;
  if (args.aspect_ratio) pikaArgs.aspect_ratio = args.aspect_ratio;
  if (args.quality) pikaArgs.quality = args.quality;
  if (args.resolution) pikaArgs.resolution = args.resolution;

  const fired = await callPikaTool('pika_generate_image', pikaArgs);
  if (fired.error) {
    // Mark the tile as failed so the placeholder doesn't sit forever.
    await mutateWorkspace((cur: any) => {
      const items = Array.isArray(cur?.primary?.items) ? cur.primary.items.map((it: any) => {
        if (it?.id !== tileId) return it;
        return { ...it, failed: true, errorMessage: `gen failed to fire: ${fired.content.slice(0, 200)}`, pending: false };
      }) : [];
      return { next: { ...cur, primary: { ...(cur?.primary ?? {}), items } }, result: undefined };
    });
    return { content: `produce_workspace_image fired pika_generate_image but it errored: ${fired.content}`, error: true };
  }

  return {
    content: [
      `[PRODUCING] tile_id: ${tileId} · provider: ${provider}`,
      ``,
      `Server fires the gen, downloads to ${localRel ?? `assets/refs/${tileId}.<ext>`}, and updates the tile's src. End your turn.`,
    ].join('\n'),
    preview: `+ tile ${tileId}`,
  };
}

function toolGenStatus(args: Record<string, unknown>): ToolResult {
  const id = String(args.gen_job_id ?? '').trim();
  if (!id) return { content: 'gen_job_id is required', error: true };
  const job = getGenJob(id);
  if (!job) return { content: `no GenJob with id=${id}`, error: true };
  return {
    content: JSON.stringify({
      id: job.id,
      state: job.state,
      tool: job.tool,
      bind: job.bind,
      pikaTaskId: job.pikaTaskId,
      remoteUrl: job.remoteUrl,
      localPath: job.localPath,
      errorMessage: job.errorMessage,
      progressSec: job.progressSec,
      progressPct: job.progressPct,
      attempts: job.attempts.map((a) => ({ at: new Date(a.at).toISOString(), from: a.from, to: a.to, note: a.note })),
      startedAt: new Date(job.startedAt).toISOString(),
      endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : null,
    }, null, 2),
    preview: `${id}: ${job.state}`,
  };
}

async function toolDetectCuts(args: Record<string, unknown>): Promise<ToolResult> {
  const r = resolveSafe(String(args.path ?? ''));
  if (!existsSync(r.abs)) return { content: `file not found: ${args.path}`, error: true };
  const threshold = typeof args.threshold === 'number' ? args.threshold : 0.4;
  try {
    const cuts = await detectSceneCuts(r.abs, threshold);
    return {
      content: cuts.length === 0
        ? '(single-shot — no cuts detected)'
        : `${cuts.length} cut${cuts.length === 1 ? '' : 's'} at: ${cuts.map((t) => t.toFixed(3) + 's').join(', ')}`,
      preview: `${cuts.length} cut${cuts.length === 1 ? '' : 's'} in ${relForDisplay(r.abs).split('/').pop()}`,
    };
  } catch (err) {
    return { content: `detect_cuts failed: ${err instanceof Error ? err.message : String(err)}`, error: true };
  }
}

async function toolSplitClip(args: Record<string, unknown>): Promise<ToolResult> {
  const clipId = String(args.clipId ?? '');
  const atMasterTime = Number(args.atMasterTime);
  if (!clipId || !isFinite(atMasterTime)) return { content: 'clipId and atMasterTime required', error: true };
  const { timeline } = readTimeline();
  const result = splitClipAtMaster(timeline, clipId, atMasterTime);
  if ('error' in result) return { content: result.error, error: true };
  TimelineSchema.parse(result.timeline);
  await writeTimeline(result.timeline);
  events.broadcast({ type: 'timeline-changed', sha: '' });
  return {
    content: `split ${result.firstHalfId} at ${atMasterTime.toFixed(2)}s → ${result.firstHalfId} + ${result.secondHalfId}`,
    preview: `split @ ${atMasterTime.toFixed(2)}s`,
  };
}

async function toolPatchScene(args: Record<string, unknown>): Promise<ToolResult> {
  const id = String(args.id ?? '');
  const patch = (args.patch ?? {}) as Record<string, unknown>;
  if (!id) return { content: 'id required', error: true };
  // Route through the HTTP endpoint so the audio-extract hook fires when
  // status flips to 'ready' with a local videoSrc. Direct timeline.json
  // mutation skips the hook — that was the "no audio after gen" bug.
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  const res = await fetch(`http://127.0.0.1:${port}/scenes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { content: `patch_scene failed (${res.status}): ${JSON.stringify(body)}`, error: true };
  }
  return { content: `patched ${id}`, preview: `patched ${id}` };
}

function toolListComments(): ToolResult {
  const { timeline } = readTimeline();
  const clipComments = timeline.tracks.flatMap((t) =>
    t.clips.flatMap((c) =>
      (c.comments ?? []).map((cc) => ({ ...cc, clipId: c.id, trackId: t.id })),
    ),
  );
  const floating = timeline.floatingComments ?? [];
  return {
    content: JSON.stringify({ clipComments, floating }, null, 2),
    preview: `${clipComments.length} clip · ${floating.length} floating`,
  };
}

async function toolPatchComment(args: Record<string, unknown>): Promise<ToolResult> {
  const id = String(args.id ?? '');
  if (!id) return { content: 'id required', error: true };
  const { timeline } = readTimeline();
  let found: Record<string, unknown> | null = null;
  for (const t of timeline.tracks) for (const c of t.clips) for (const cc of (c.comments ?? [])) if (cc.id === id) found = cc as Record<string, unknown>;
  for (const f of timeline.floatingComments ?? []) if (f.id === id) found = f as Record<string, unknown>;
  if (!found) return { content: `comment not found: ${id}`, error: true };
  if (args.note !== undefined) found.note = String(args.note);
  if (args.resolved !== undefined) found.resolved = Boolean(args.resolved);
  if (args.agentReply !== undefined) found.agentReply = String(args.agentReply);
  TimelineSchema.parse(timeline);
  await writeTimeline(timeline);
  events.broadcast({ type: 'timeline-changed', sha: '' });
  return { content: `patched comment ${id}`, preview: `comment ${id} → ${args.resolved ? 'resolved' : 'updated'}` };
}

function toolUpdatePlan(args: Record<string, unknown>): ToolResult {
  const planPath = path.join(paths.project, 'plan.json');
  // Merge: load existing plan if present, then overlay top-level keys the
  // agent passed. This lets the agent update just one section (e.g. beats)
  // without having to re-send everything.
  let existing: Record<string, unknown> = {};
  if (existsSync(planPath)) {
    try { existing = JSON.parse(readFileSync(planPath, 'utf8')); } catch { existing = {}; }
  }
  const next = { ...existing, ...args, updatedAt: new Date().toISOString() };
  mkdirSync(path.dirname(planPath), { recursive: true });
  const tmp = planPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, planPath);
  events.broadcast({ type: 'asset-added', relPath: 'plan.json' });
  const sections = Object.keys(args).filter((k) => k !== 'updatedAt');
  return { content: `updated plan.json (${sections.join(', ')})`, preview: `plan: ${sections.join(', ')}` };
}

/** Walk write_workspace args and fill `model` on every primary.items tile
 *  that has a `taskId` known to the gen map. Idempotent: tiles that
 *  already have `model` are left untouched. The agent's `taskId` is the
 *  `gen_id` we appended to its tool result; we use it as the canonical
 *  key into the model map (populated in pika-mcp.ts when the gen tool
 *  starts). This makes the model badge robust against agent forgetting
 *  to pass `model` explicitly. */
function enrichWorkspaceTilesWithModel(args: Record<string, unknown>): Record<string, unknown> {
  const primary = args.primary as Record<string, unknown> | undefined;
  if (!primary || !Array.isArray(primary.items)) return args;
  const enrichedItems = (primary.items as Array<Record<string, unknown> | unknown>).map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const it = raw as Record<string, unknown>;
    if (it.model) return it;
    const taskId = typeof it.taskId === 'string' ? it.taskId : null;
    if (!taskId) return it;
    const model = getModelForGenId(taskId);
    if (!model) return it;
    return { ...it, model };
  });
  return { ...args, primary: { ...primary, items: enrichedItems } };
}

async function toolWriteWorkspace(args: Record<string, unknown>): Promise<ToolResult> {
  const wsPath = path.join(paths.project, 'workspace.json');

  // GUARDRAIL: reject grids where multiple tiles share the same `src`.
  //
  // Failure mode this catches: the agent reaches for a random/leftover
  // CDN URL it remembers from a prior gen (or hallucinates one that
  // happens to resolve) and pastes the same src across every tile of a
  // choice menu — every "trope" tile rendered with the same portrait.
  // Each choice tile must show its OWN content, or no media at all.
  // If the agent doesn't have N distinct gens yet, the right move is
  // to omit src and ship label-only tiles, or stage with pending=true
  // placeholders and fan out gens. Either path is fine; a duplicated
  // src is not.
  const primary = (args as any)?.primary;
  if (primary && Array.isArray(primary.items) && (primary.kind === 'image-grid' || primary.kind === 'video-grid')) {
    const seen = new Map<string, number>();
    for (const it of primary.items as Array<Record<string, unknown>>) {
      if (typeof it?.src === 'string' && it.src.length > 0) {
        seen.set(it.src, (seen.get(it.src) ?? 0) + 1);
      }
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    if (dupes.length > 0) {
      const sample = dupes[0][0].length > 90 ? dupes[0][0].slice(0, 90) + '…' : dupes[0][0];
      return {
        content: [
          `[blocked] write_workspace rejected — ${dupes.length} src URL${dupes.length === 1 ? '' : 's'} is repeated across multiple tiles in this ${primary.kind}.`,
          `Example duplicate (used ${dupes[0][1]}× across tiles): ${sample}`,
          ``,
          `Each tile in a choice/option grid MUST show its own content. Two options:`,
          `  1. Generate N distinct images (one pika_generate_image per tile with __tileId set on each).`,
          `  2. Ship label-only tiles — omit src on every tile, keep label/action/dialogue so the user reads the option in text.`,
          ``,
          `Never reuse a src across tiles. If you're tempted to "use this CDN url I remember from earlier", DON'T — generate fresh, or go label-only.`,
        ].join('\n'),
        error: true,
      };
    }
  }

  // Server-side enrichment: any primary.items tile that has a `taskId`
  // but no `model` gets `model` filled in from the persistent gen-id
  // map (populated when the gen tool ran). This makes the model badge
  // deterministic — the agent only has to remember to pass `taskId`,
  // which it already does for live-binding. No more "agent forgot to
  // set model" gaps.
  const enriched = enrichWorkspaceTilesWithModel(args);
  const payload = { ...enriched, generatedAt: new Date().toISOString() };
  mkdirSync(path.dirname(wsPath), { recursive: true });

  // Snapshot the previous workspace.json before overwriting it. Lets the
  // user step backwards through prior iterations of a variation via the
  // Workspace card's "Previous" affordance — useful when the agent
  // narrows in on a look across multiple writes.
  //
  // EXCEPTION: if the previous workspace state had any `pending: true`
  // tiles, the prior state was mid-flight (an in-progress gen). The
  // agent's NEXT write is almost always the "settle" — same logical
  // card, just transitioned from GENERATING → DONE. Stacking both in
  // history creates a confusing "two of the same" entry where one is a
  // frozen placeholder. So mid-flight states are treated as ephemeral
  // and the new write replaces them without leaving a snapshot behind.
  if (existsSync(wsPath)) {
    try {
      const prevBytes = readFileSync(wsPath, 'utf8');
      let prevHadPending = false;
      try {
        const prev = JSON.parse(prevBytes);
        const items = prev?.primary?.items;
        if (Array.isArray(items)) {
          // True loading-state = pending AND no src yet. A tile with both
          // {pending:true, src:"..."} is contradictory (and was the cause
          // of the chars/locations bug pre-merge-fix); only the no-src
          // form counts as a real placeholder worth treating as ephemeral.
          prevHadPending = items.some((it: unknown) => {
            if (it === null || typeof it !== 'object') return false;
            const tile = it as Record<string, unknown>;
            return tile.pending === true && !tile.src;
          });
        }
      } catch { /* unparseable previous file — fall through and snapshot it */ }

      if (!prevHadPending) {
        const historyDir = path.join(paths.project, '.agent', 'workspace-history');
        mkdirSync(historyDir, { recursive: true });
        // Use the previous file's recorded generatedAt as the snapshot key
        // when it exists, falling back to mtime. Stable + sortable.
        let stamp: string;
        try { stamp = (JSON.parse(prevBytes).generatedAt as string) || new Date(statSync(wsPath).mtimeMs).toISOString(); }
        catch { stamp = new Date(statSync(wsPath).mtimeMs).toISOString(); }
        const safeStamp = stamp.replace(/[:.]/g, '-');
        const snapPath = path.join(historyDir, `${safeStamp}.json`);
        if (!existsSync(snapPath)) writeFileSync(snapPath, prevBytes);
        // Cap at 50 most-recent snapshots so the directory doesn't grow forever.
        const all = readdirSync(historyDir).filter((f) => f.endsWith('.json')).sort();
        if (all.length > 50) {
          for (const old of all.slice(0, all.length - 50)) {
            try { unlinkSync(path.join(historyDir, old)); } catch { /* noop */ }
          }
        }
      }
    } catch { /* snapshotting is best-effort; never block the write */ }
  }

  // Merge through the actor so server-set gen-state fields (sceneId,
  // taskId, src, pending) on existing tiles SURVIVE the agent's rewrite.
  //
  // Why: the server's `claimWorkspaceTile` runs at gen fire-time and
  // writes sceneId+taskId onto a matching pending tile so the auto-bind
  // on completion can find it. But the agent frequently calls
  // write_workspace AFTER firing the gens (to refine copy, switch
  // phase, etc.), and the old code just overwrote the whole file —
  // wiping the claims. The completed gens then had nowhere to bind,
  // leaving tiles permanently stuck on "generating". This is the root
  // cause of "fire N gens in parallel, only one lands".
  //
  // Match priority: tile.id (when set on both sides), otherwise label
  // (case-insensitive, exact). Preserved fields are exactly the ones
  // the server owns; everything else is replaced from the agent's
  // payload as before. Top-level fields (phase / headline / etc.) are
  // wholly agent-owned — no merge there.
  await mutateWorkspace((prev: any) => {
    const prevItems = (prev?.primary?.items ?? []) as Array<Record<string, unknown>>;
    const nextItemsRaw = ((payload as any)?.primary?.items ?? []) as Array<Record<string, unknown>>;
    const findPrev = (it: Record<string, unknown>): Record<string, unknown> | undefined => {
      if (it.id && typeof it.id === 'string') {
        const byId = prevItems.find((p) => p && p.id === it.id);
        if (byId) return byId;
      }
      if (it.label && typeof it.label === 'string') {
        const lab = it.label.trim().toLowerCase();
        if (lab) return prevItems.find((p) => p && typeof p.label === 'string' && (p.label as string).trim().toLowerCase() === lab);
      }
      return undefined;
    };
    const SERVER_FIELDS = ['sceneId', 'taskId', 'src', 'pending'] as const;
    const mergedItems = nextItemsRaw.map((it) => {
      const old = findPrev(it);
      if (!old) return it;
      const merged: Record<string, unknown> = { ...it };
      for (const k of SERVER_FIELDS) {
        if (merged[k] === undefined && old[k] !== undefined) merged[k] = old[k];
      }
      // A tile carrying a real `src` is settled by definition — don't let
      // stale `pending: true` from the prior loading-state tile survive the
      // merge. Without this, an agent write that fills in src but omits
      // `pending` ends up with a contradictory {pending:true, src:"..."}
      // shape, which downstream snapshot heuristics misread as "loading"
      // and skip preserving the view in history (the chars/locations bug).
      if (merged.src && merged.pending === true) {
        delete merged.pending;
      }
      return merged;
    });
    const next = {
      ...payload,
      primary: { ...((payload as any).primary ?? {}), items: mergedItems },
    };
    return { next, result: undefined };
  });
  // Auto-download any tile srcs that are CDN URLs. Without this,
  // tiles that the agent populated with `https://cdn.pika.art/…`
  // (typically from analyze_media / scrape_ads / app store scrape)
  // eventually break when the CDN expires. The server owns the
  // download — no agent discretion. Fire-and-forget; once the
  // download lands, the tile's src is rewritten to the local path
  // via the actor (race-safe). Idempotent: a tile that already has
  // a local src is skipped.
  void downloadCdnTileSrcs().catch((e) => console.warn('[tools] CDN tile rewrite failed:', (e as Error)?.message ?? e));
  return { content: `wrote workspace.json (${Object.keys(args).length} fields)`, preview: 'workspace.json updated' };
}

/** Background sweep: any workspace tile whose `src` is a remote URL
 *  gets downloaded to `assets/refs/tiles/<safe>.<ext>` and the tile's
 *  src is rewritten to that local path. Runs after every workspace
 *  write so the user never has to wait for a separate "save refs"
 *  step. Best-effort; failures are logged but never disrupt the
 *  write that triggered the sweep. */
async function downloadCdnTileSrcs(): Promise<void> {
  // Anchor the sweep to the project that was active when
  // toolWriteWorkspace ran — same rule as gen downloads. If the user
  // switches projects mid-sweep, downloads still land in the right
  // project's assets/refs/tiles/, and we skip the actor mutate (the
  // workspace.json that needs updating is the captured one; the
  // current project's actor would write into the wrong file).
  const projectDir = paths.project;
  // Snapshot the current workspace so we can sweep without holding
  // the actor for the entire HTTP fetch.
  const wsPath = path.join(projectDir, 'workspace.json');
  if (!existsSync(wsPath)) return;
  let snapshot: { primary?: { items?: Array<Record<string, unknown>> } };
  try { snapshot = JSON.parse(readFileSync(wsPath, 'utf8')); }
  catch { return; }
  const items = snapshot?.primary?.items ?? [];
  // Find tiles that need a download.
  const todo: Array<{ src: string; label: string; idx: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object') continue;
    const src = it.src;
    if (typeof src !== 'string' || !/^https?:\/\//i.test(src)) continue;
    const label = typeof it.label === 'string' && it.label.trim() ? it.label : `tile_${i + 1}`;
    todo.push({ src, label, idx: i });
  }
  if (todo.length === 0) return;
  // Download each in parallel. Each item independent — one failing
  // doesn't stop the others.
  const results = await Promise.allSettled(todo.map(async (job) => {
    const url = job.src;
    const m = url.match(/\.(png|jpe?g|webp|gif|bmp|tiff|mp4|mov|webm)\b/i);
    const ext = (m?.[1] ?? 'png').toLowerCase();
    const safeLabel = job.label.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 48);
    const filename = `${safeLabel}-${Date.now().toString(36)}-${job.idx}.${ext}`;
    const relPath = `assets/refs/tiles/${filename}`;
    const absPath = path.join(projectDir, relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(absPath, buf);
    console.log(`[tools] tile CDN→local: ${url.slice(0, 60)}… → ${relPath}`);
    return { url, relPath };
  }));
  // Rewrite all successful downloads in ONE actor mutation. The
  // match key is the ORIGINAL CDN URL (not the index) so concurrent
  // workspace edits between our snapshot read and now don't corrupt
  // anything — we only update tiles whose src is STILL the URL we
  // downloaded.
  const successes = results
    .filter((r): r is PromiseFulfilledResult<{ url: string; relPath: string }> => r.status === 'fulfilled')
    .map((r) => r.value);
  if (successes.length === 0) return;
  // Don't actor-mutate if the user has switched projects since we
  // started — mutateWorkspace is bound to the active project. The
  // downloads landed in the right place; on the user's next
  // workspace write in that project the rewrite runs again.
  if (projectDir !== paths.project) {
    console.warn(`[tools] CDN tile downloads (${successes.length}) saved in ${path.basename(projectDir)} but skipping workspace rewrite — user switched to ${path.basename(paths.project)}.`);
    return;
  }
  const urlToLocal = new Map(successes.map((s) => [s.url, s.relPath]));
  await mutateWorkspace((cur: any) => {
    const cs = cur?.primary?.items as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(cs)) return { next: cur, result: undefined };
    let touched = false;
    const nextItems = cs.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const src = it.src;
      if (typeof src !== 'string') return it;
      const local = urlToLocal.get(src);
      if (!local) return it;
      touched = true;
      return { ...it, src: local };
    });
    if (!touched) return { next: cur, result: undefined };
    return { next: { ...cur, primary: { ...cur.primary, items: nextItems } }, result: undefined };
  });
}

/* ------- UI control tools (server emits agent-action; client dispatches to store) ------- */

function toolSetView(args: Record<string, unknown>): ToolResult {
  const view = args.view === 'workspace' ? 'workspace' : 'timeline';
  events.broadcast({ type: 'agent-action', action: { kind: 'set_view', view } });
  return { content: `view: ${view}`, preview: `view → ${view}` };
}

function toolSelectClip(args: Record<string, unknown>): ToolResult {
  const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map(String) : [];
  events.broadcast({ type: 'agent-action', action: { kind: 'select_clip', ids } });
  return { content: ids.length ? `selected: ${ids.join(', ')}` : 'selection cleared', preview: ids.length ? `select ${ids[0]}${ids.length > 1 ? ` +${ids.length - 1}` : ''}` : 'clear selection' };
}

function toolSetPlayhead(args: Record<string, unknown>): ToolResult {
  const t = Number(args.t);
  if (!isFinite(t) || t < 0) return { content: 't must be a non-negative number', error: true };
  events.broadcast({ type: 'agent-action', action: { kind: 'set_playhead', t } });
  return { content: `playhead → ${t.toFixed(2)}s`, preview: `→ ${t.toFixed(2)}s` };
}

function toolPlayPause(args: Record<string, unknown>): ToolResult {
  const play = typeof args.play === 'boolean' ? args.play : undefined;
  events.broadcast({ type: 'agent-action', action: play === undefined ? { kind: 'play_pause' } : { kind: 'play_pause', play } });
  return { content: play === undefined ? 'toggle play' : (play ? 'play' : 'pause'), preview: play === undefined ? '⏯' : (play ? '▶' : '⏸') };
}

function toolSetZoom(args: Record<string, unknown>): ToolResult {
  const px = Math.max(20, Math.min(400, Number(args.px) || 100));
  events.broadcast({ type: 'agent-action', action: { kind: 'set_zoom', px } });
  return { content: `zoom: ${px}px/sec`, preview: `zoom ${px}` };
}

function toolSetTool(args: Record<string, unknown>): ToolResult {
  const tool = String(args.tool ?? 'select') as 'select' | 'blade' | 'slip' | 'ripple' | 'stretch' | 'comment';
  events.broadcast({ type: 'agent-action', action: { kind: 'set_tool', tool } });
  return { content: `tool: ${tool}`, preview: `tool → ${tool}` };
}

function toolOpenModal(args: Record<string, unknown>): ToolResult {
  const m = args.modal;
  const modal = m === 'projects' ? 'projects' as const : null;
  events.broadcast({ type: 'agent-action', action: { kind: 'open_modal', modal } });
  return { content: modal ? `opened ${modal} modal` : 'closed modal', preview: modal ?? 'close modal' };
}

function toolListProjects(): ToolResult {
  const list = listProjects().map((p) => ({
    name: p.name,
    displayName: p.displayName,
    active: p.active,
    aspect: p.aspect,
    resolution: p.resolution,
    fps: p.fps,
    clipCount: p.clipCount,
    openedAt: p.openedAt,
  }));
  return { content: JSON.stringify(list, null, 2), preview: `${list.length} projects` };
}

async function toolDelegateToClaude(args: Record<string, unknown>): Promise<ToolResult> {
  const brief = String(args.brief ?? '').trim();
  if (!brief) return { content: 'brief is required', error: true };
  // Lazy-import to break the otherwise-circular shape (delegate.ts imports
  // executeTool from this file).
  const { runDelegatedTurn } = await import('./delegate.js');
  const r = await runDelegatedTurn(brief);
  if (!r.ok) return { content: r.error ?? 'delegation failed', error: true };
  const verb = r.actions.length === 0 ? 'replied' : `ran ${r.actions.length} tool${r.actions.length === 1 ? '' : 's'}`;
  return {
    content: r.summary,
    preview: `${verb} · ${r.summary.slice(0, 60)}${r.summary.length > 60 ? '…' : ''}`,
  };
}

function clampDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(-40, Math.min(12, db));
}

async function toolSetTrackGain(args: Record<string, unknown>): Promise<ToolResult> {
  const trackId = String(args.trackId ?? '').trim();
  const db = clampDb(Number(args.db));
  if (!trackId) return { content: 'trackId is required (e.g. "a1")', error: true };
  const { timeline } = readTimeline();
  let found = false;
  const audioTracks = (timeline.audioTracks ?? []).map((t) => {
    if (t.id !== trackId) return t;
    found = true;
    return { ...t, gain: db };
  });
  if (!found) return { content: `no audio track "${trackId}" — call read_timeline first`, error: true };
  await writeTimeline({ ...timeline, audioTracks });
  events.broadcast({ type: 'timeline-changed', sha: '' });
  return { content: `set track ${trackId} gain to ${db.toFixed(1)} dB`, preview: `${trackId} → ${db.toFixed(1)} dB` };
}

async function toolSetClipGain(args: Record<string, unknown>): Promise<ToolResult> {
  const clipId = String(args.clipId ?? '').trim();
  const db = clampDb(Number(args.db));
  if (!clipId) return { content: 'clipId is required', error: true };
  const { timeline } = readTimeline();
  let found = false;
  const audioTracks = (timeline.audioTracks ?? []).map((t) => ({
    ...t,
    clips: t.clips.map((c) => {
      if (c.id !== clipId) return c;
      found = true;
      return { ...c, gain: db };
    }),
  }));
  if (!found) return { content: `no audio clip "${clipId}" — call read_timeline first`, error: true };
  await writeTimeline({ ...timeline, audioTracks });
  events.broadcast({ type: 'timeline-changed', sha: '' });
  return { content: `set clip ${clipId} gain to ${db.toFixed(1)} dB`, preview: `${clipId.slice(0, 16)} → ${db.toFixed(1)} dB` };
}

async function toolDeleteClip(args: Record<string, unknown>): Promise<ToolResult> {
  const clipId = String(args.clipId ?? '').trim();
  if (!clipId) return { content: 'clipId is required', error: true };
  const { timeline } = readTimeline();
  let removedFrom: string | null = null;
  // Try video tracks first (V1/V2). When a video clip leaves, its
  // linked audio (linkId match) goes with it — same policy as the
  // delete-clip hotkey in the editor UI.
  const videoNext = timeline.tracks.map((tr) => {
    const before = tr.clips.length;
    const clips = tr.clips.filter((c) => c.id !== clipId);
    if (clips.length !== before) removedFrom = `video:${tr.id}`;
    return { ...tr, clips };
  });
  let linkedAudioIds = new Set<string>();
  if (removedFrom) {
    // Find the original clip's linkId so we can drop linked audio clips too.
    for (const tr of timeline.tracks) {
      const original = tr.clips.find((c) => c.id === clipId);
      if (original?.linkId) {
        for (const at of timeline.audioTracks ?? []) {
          for (const ac of at.clips) if (ac.linkId === original.linkId) linkedAudioIds.add(ac.id);
        }
      }
    }
  }
  // Now walk audio tracks — either to remove the clip itself OR to
  // drop the linked audio that goes with a deleted video clip.
  const audioNext = (timeline.audioTracks ?? []).map((tr) => {
    const before = tr.clips.length;
    const clips = tr.clips.filter((c) => c.id !== clipId && !linkedAudioIds.has(c.id));
    if (clips.length !== before && !removedFrom) removedFrom = `audio:${tr.id}`;
    return { ...tr, clips };
  });
  if (!removedFrom) {
    return { content: `no clip with id "${clipId}" — call read_timeline first`, error: true };
  }
  const next = { ...timeline, tracks: videoNext, audioTracks: audioNext };
  await writeTimeline(next);
  events.broadcast({ type: 'timeline-changed', sha: '' });
  return {
    content: `deleted clip ${clipId}${linkedAudioIds.size > 0 ? ` (plus ${linkedAudioIds.size} linked audio)` : ''} from ${removedFrom}`,
    preview: `× ${clipId.slice(0, 24)}`,
  };
}

function toolCreateProject(args: Record<string, unknown>): ToolResult {
  const name = String(args.name ?? '').trim();
  if (!name) return { content: 'name is required', error: true };
  const aspect = (args.aspect as 'string' | undefined) ?? '16:9';
  const resolution = (args.resolution as 'string' | undefined) ?? '1080p';
  const fpsNum = Number(args.fps ?? 24);
  const fps = (fpsNum === 24 || fpsNum === 30 || fpsNum === 60) ? fpsNum : 24;
  const root = path.dirname(paths.project);
  let dirName = slugify(name);
  let candidate = path.join(root, dirName);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = path.join(root, `${dirName}-${n}`);
    n++;
  }
  mkdirSync(candidate, { recursive: true });
  writeFileSync(path.join(candidate, 'timeline.json'),
    emptyTimelineJson(name, aspect as any, resolution as any, fps as 24 | 30 | 60));
  try {
    setProject(candidate);
  } catch (err) {
    if (err instanceof ProjectLockedError) {
      return { content: `project "${name}" was created but is locked by another running server (pid ${err.holderPid}). Close that server or switch it off the project first.`, error: true };
    }
    throw err;
  }
  touchProject(candidate);
  startWatcher();
  events.broadcast({ type: 'project-changed', dir: paths.project, name: path.basename(paths.project) });
  // Auto-close picker if it was open.
  events.broadcast({ type: 'agent-action', action: { kind: 'open_modal', modal: null } });
  return {
    content: `created project "${name}" — ${aspect} ${resolution} ${fps}fps — switched to it`,
    preview: `+ ${name} (${aspect})`,
  };
}

function toolSwitchProject(args: Record<string, unknown>): ToolResult {
  const name = String(args.name ?? '').trim();
  if (!name) return { content: 'name is required', error: true };
  const root = path.dirname(paths.project);
  const target = path.resolve(root, name);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return { content: `no project named "${name}" — call list_projects first`, error: true };
  }
  if (!existsSync(path.join(target, 'timeline.json'))) {
    return { content: `"${name}" has no timeline.json`, error: true };
  }
  try {
    setProject(target);
  } catch (err) {
    if (err instanceof ProjectLockedError) {
      return { content: `cannot switch to "${name}" — it's locked by another running server (pid ${err.holderPid})`, error: true };
    }
    throw err;
  }
  touchProject(target);
  startWatcher();
  events.broadcast({ type: 'project-changed', dir: paths.project, name: path.basename(paths.project) });
  return { content: `switched to project "${name}"`, preview: `→ ${name}` };
}

async function toolAddComment(args: Record<string, unknown>): Promise<ToolResult> {
  const at = Number(args.at);
  const note = String(args.note ?? '');
  if (!note || !isFinite(at)) return { content: 'at and note required', error: true };
  const { timeline } = readTimeline();
  const id = `cm_${Date.now().toString(36)}`;
  const author = 'agent' as const;
  if (args.clipId) {
    const clip = timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === args.clipId);
    if (!clip) return { content: `clip not found: ${args.clipId}`, error: true };
    clip.comments = [...(clip.comments ?? []), { id, at, note, author, resolved: false, resolvedAt: null, agentReply: null }];
  } else {
    const trackId = String(args.trackId ?? 'v1');
    timeline.floatingComments = [...(timeline.floatingComments ?? []), { id, trackId, at, note, author, resolved: false, resolvedAt: null, agentReply: null, ghostClipId: null }];
  }
  TimelineSchema.parse(timeline);
  await writeTimeline(timeline);
  events.broadcast({ type: 'timeline-changed', sha: '' });
  return { content: `added comment ${id}`, preview: `+ comment @ ${at.toFixed(1)}s` };
}

function toolStartRender(args: Record<string, unknown>): ToolResult {
  // Route through the existing /render endpoint so we get the full ffmpeg job
  // queue + progress SSE events the user already sees. fetch hits localhost.
  const body = JSON.stringify({
    preset: args.preset ?? 'standard',
    fps: args.fps ?? undefined,
  });
  // We can't await fetch here without breaking the sync executor signature, so
  // fire-and-forget — the render system reports back via render-progress /
  // render-done events the UI already listens to.
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  void fetch(`http://127.0.0.1:${port}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).catch(() => { /* the SSE event stream will surface failure */ });
  return { content: `render queued (preset=${args.preset ?? 'standard'})`, preview: 'render queued' };
}

async function toolSaveVersion(args: Record<string, unknown>): Promise<ToolResult> {
  const name = String(args.name ?? '').trim();
  if (!name) return { content: 'name required', error: true };
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  const res = await fetch(`http://127.0.0.1:${port}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return { content: `save_version failed: ${res.status}`, error: true };
  return { content: `saved version "${name}"`, preview: `★ ${name}` };
}

async function toolGenerateSfx(args: Record<string, unknown>): Promise<ToolResult> {
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  const res = await fetch(`http://127.0.0.1:${port}/sfx/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: String(args.prompt ?? ''),
      startSec: Number(args.startSec ?? 0),
      durationSec: args.durationSec !== undefined ? Number(args.durationSec) : undefined,
      trackId: typeof args.trackId === 'string' ? args.trackId : undefined,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as { error?: string }).error) {
    return { content: `sfx error: ${JSON.stringify(body)}`, error: true };
  }
  return { content: `sfx placeholder: ${(body as { placeholderId?: string }).placeholderId}`, preview: 'SFX gen started' };
}

async function toolGenerateMusic(args: Record<string, unknown>): Promise<ToolResult> {
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  const res = await fetch(`http://127.0.0.1:${port}/music/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: String(args.prompt ?? ''),
      startSec: Number(args.startSec ?? 0),
      durationSec: Number(args.durationSec ?? 8),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { content: `music error: ${JSON.stringify(body)}`, error: true };
  return { content: `music pending: ${(body as { id?: string }).id}`, preview: 'music gen queued' };
}

async function toolAutoCaption(args: Record<string, unknown>): Promise<ToolResult> {
  const sceneId = String(args.sceneId ?? '').trim();
  if (!sceneId) return { content: 'auto_caption: sceneId required', error: true };
  const port = process.env.PIKA_EDITOR_PORT ?? '3080';
  const res = await fetch(`http://127.0.0.1:${port}/captions/auto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sceneId,
      script: typeof args.script === 'string' ? args.script : undefined,
      replace: args.replace === true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as { error?: string }).error) {
    return { content: `auto_caption error: ${JSON.stringify(body)}`, error: true };
  }
  const added = (body as { added?: number }).added ?? 0;
  const usedTimings = (body as { usedWhisperTimings?: boolean }).usedWhisperTimings;
  return {
    content: `auto_caption: added ${added} rows${usedTimings ? ' (Whisper-timed)' : ' (no Whisper timings — evenly distributed)'}`,
    preview: `+${added} caption rows`,
  };
}
