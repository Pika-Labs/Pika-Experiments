/**
 * Curated preset list for the fresh-project launcher.
 *
 * Server-owned: the agent has no say in what presets are surfaced
 * (that decision belongs to product, not the model). The launcher
 * fetches `GET /presets` once on mount and renders the cards.
 *
 * Each preset is a thin shell over a skill that lives elsewhere
 * (pika-plugins marketplace, .claude/skills/, or hardcoded inline).
 * We do NOT read every SKILL.md at server-boot — too slow and too
 * much surface. Instead this file declares the curated order + the
 * human-friendly metadata (title, oneliner, accent kind, etc).
 *
 * `previewSrc` is optional and intentionally null for v1 — slot for a
 * looping silent example clip per preset, to be populated once
 * suitable sample outputs are produced + uploaded.
 */

export interface Preset {
  /** Stable id, matches the underlying skill route (e.g. 'pika:short-ads'). */
  id: string;
  /** Display title — Telka Extended uppercase. ~12 chars max. */
  title: string;
  /** One-line description shown under the title. Telka, sentence case. */
  oneliner: string;
  /** Optional bullet feature list (1–3 short items). */
  bullets?: string[];
  /** Tag used by the UI to pick the accent + icon. */
  kind: 'video' | 'image' | 'brand' | 'audio' | 'custom';
  /** Pre-filled chat draft when the card is clicked. Includes a placeholder
   *  the user is expected to overwrite. */
  triggerText: string;
  /** URL of a short looping silent example output. Null = render a
   *  styled placeholder until a real sample lands. */
  previewSrc: string | null;
  /** When true, the preset requires Pika to be connected. Renders an
   *  inline "Connect Pika" hint instead of firing if not connected. */
  requiresPika: boolean;
}

const PRESETS: Preset[] = [
  {
    id: 'short-film',
    title: 'SHORT FILM',
    oneliner: 'Cinematic narrative · the default',
    kind: 'video',
    triggerText: 'Make me a short film about ',
    previewSrc: '/preview/short-film.mp4',
    requiresPika: true,
  },
  {
    id: 'pika:short-ads',
    title: 'SHORT-AD',
    oneliner: 'Polished 15s product ad',
    kind: 'video',
    triggerText: 'Make me a 15s short-ad for ',
    previewSrc: '/preview/short-ad.mp4',
    requiresPika: true,
  },
  {
    id: 'pika:ugc-ads',
    title: 'UGC AD',
    oneliner: 'Jump-cut POV product ad',
    kind: 'video',
    triggerText: 'Make me a UGC ad for ',
    previewSrc: '/preview/ugc-ad.mp4',
    requiresPika: true,
  },
  {
    id: 'pika:app-sizzle',
    title: 'APP SIZZLE',
    oneliner: 'Cinematic iOS app teaser',
    kind: 'video',
    triggerText: 'Make me an app sizzle for ',
    previewSrc: '/preview/app-sizzle.mp4',
    requiresPika: true,
  },
  {
    id: 'pika:podcast',
    title: 'PODCAST',
    oneliner: 'Two-host video, native dialogue',
    kind: 'video',
    triggerText: 'Make a podcast about ',
    previewSrc: '/preview/podcast.mp4',
    requiresPika: true,
  },
  {
    id: 'pika:seedance-short-drama',
    title: 'SHORT DRAMA',
    oneliner: 'Vertical 60–90s drama',
    kind: 'video',
    triggerText: 'Make me a short drama about ',
    previewSrc: '/preview/short-drama.mp4',
    requiresPika: true,
  },
];

export function listPresets(): Preset[] {
  return PRESETS;
}
