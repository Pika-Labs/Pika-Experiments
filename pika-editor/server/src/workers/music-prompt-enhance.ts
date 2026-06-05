/**
 * Music prompt enhancer.
 *
 * The user types short prompts on the music lane ("dreamy", "energetic
 * synthwave", "tense"). ElevenLabs music_v1 reads structured cues better
 * than vibes, so we expand a short prompt into a fuller one covering:
 *
 *   GENRE / STYLE  →  INSTRUMENTS  →  MOOD  →  TEMPO  →  PRODUCTION  →  INSTRUMENTAL
 *
 * Heuristic, not magic: if the user already wrote something rich (>= 60
 * chars or mentions ≥ 3 of the structural dimensions), we leave it alone
 * and just append the "instrumental" reinforcement. Otherwise we infer
 * sensible defaults for whatever's missing.
 *
 * We always pass `force_instrumental: true` to the API too — the prompt
 * cues are belt + suspenders for the few cases where the model gets
 * confused by genre words that imply vocals ("trap", "pop", "rap").
 */

interface Dimensions {
  hasGenre: boolean;
  hasInstruments: boolean;
  hasMood: boolean;
  hasTempo: boolean;
  hasProduction: boolean;
  hasInstrumental: boolean;
}

const GENRE_HINTS = [
  'synthwave', 'lofi', 'lo-fi', 'hip-hop', 'orchestral', 'cinematic', 'ambient',
  'edm', 'house', 'techno', 'trap', 'rock', 'jazz', 'blues', 'folk', 'country',
  'classical', 'electronic', 'pop', 'indie', 'dnb', 'drum and bass', 'idm',
  'trance', 'dub', 'reggae', 'metal', 'punk', 'gospel', 'funk', 'soul',
  'r&b', 'rnb', 'disco', 'phonk', 'piano', 'guitar-driven', 'choir', 'minimal',
  'score', 'soundtrack',
];
const INSTRUMENT_HINTS = [
  'pad', 'synth', 'piano', 'guitar', 'drum', 'kick', 'snare', 'bass', 'strings',
  'choir', 'horn', 'brass', 'flute', 'cello', 'violin', 'pluck', 'arp',
  'organ', 'harp', 'marimba', 'rhodes', '808', 'sub', 'glock',
];
const MOOD_HINTS = [
  'dreamy', 'uplifting', 'melancholic', 'tense', 'epic', 'intimate', 'romantic',
  'dark', 'haunting', 'hopeful', 'nostalgic', 'urgent', 'calm', 'serene',
  'aggressive', 'mysterious', 'triumphant', 'eerie', 'warm', 'cold', 'ethereal',
  'peaceful', 'driving', 'introspective', 'playful',
];
const TEMPO_HINTS = ['slow', 'mid', 'fast', 'bpm', 'driving', 'pulse', 'tempo', 'beat', 'groove'];
const PRODUCTION_HINTS = ['lo-fi', 'tape', 'hiss', 'vintage', 'modern', 'analog', 'clean', 'gritty', 'polished', 'sidechain', 'reverb', '80s', '70s', '90s', '2000s'];
const INSTRUMENTAL_HINTS = ['instrumental', 'no vocals', 'no lyrics'];

function dimensionsIn(text: string): Dimensions {
  const t = text.toLowerCase();
  const has = (list: string[]) => list.some((k) => t.includes(k));
  return {
    hasGenre:        has(GENRE_HINTS),
    hasInstruments:  has(INSTRUMENT_HINTS),
    hasMood:         has(MOOD_HINTS),
    hasTempo:        has(TEMPO_HINTS),
    hasProduction:   has(PRODUCTION_HINTS),
    hasInstrumental: has(INSTRUMENTAL_HINTS),
  };
}

/**
 * Rewrite a user prompt into a structured form. Conservative — only adds
 * what's missing, never overwrites the user's words. The result is a single
 * comma-separated descriptor block, which is the shape music_v1 reads best.
 */
export function enhanceMusicPrompt(userPrompt: string): { prompt: string; enhanced: boolean } {
  const raw = userPrompt.trim();
  if (!raw) return { prompt: raw, enhanced: false };
  const dims = dimensionsIn(raw);

  // If the user already wrote a rich prompt (length OR ≥3 dimensions), just
  // ensure the instrumental cue is present and call it done.
  const dimCount = [dims.hasGenre, dims.hasInstruments, dims.hasMood, dims.hasTempo, dims.hasProduction].filter(Boolean).length;
  if (raw.length >= 80 || dimCount >= 3) {
    const suffix = dims.hasInstrumental ? '' : ', instrumental, no vocals';
    return { prompt: raw + suffix, enhanced: !!suffix };
  }

  // Otherwise expand with sensible defaults for missing dimensions. The
  // defaults are deliberately gentle ("warm pads", "midtempo") so they don't
  // clash with whatever the user did write.
  const parts: string[] = [raw];
  if (!dims.hasInstruments) parts.push('warm pads, plucked synth, soft drums');
  if (!dims.hasMood)        parts.push('reflective and cinematic');
  if (!dims.hasTempo)       parts.push('midtempo, steady pulse');
  if (!dims.hasProduction)  parts.push('clean modern production, light reverb');
  if (!dims.hasInstrumental) parts.push('instrumental, no vocals, no lyrics');
  return { prompt: parts.join(', '), enhanced: true };
}
