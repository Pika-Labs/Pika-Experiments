/**
 * Whisper-timing + script-word alignment for auto-captioning.
 *
 * Why this exists: Whisper is excellent at *when* words are spoken but
 * mediocre at *what* the word is for brand names, character names, jargon,
 * and unusual phrasing. The agent always knows the intended script. This
 * module aligns the script's words to Whisper's word timings via
 * dynamic-programming edit-distance and emits caption rows that read
 * correctly (script text) at the right moments (Whisper timings).
 *
 * Pipeline:
 *   1. tokenize(script)               → scriptWords
 *   2. parseWhisperWords(response)    → whisperWords with start/end
 *   3. alignWords(scriptWords, whisperWords) → pairing
 *   4. groupIntoRows(pairing)         → CaptionRow[]
 */

export interface WhisperWord {
  text: string;
  start: number;   // seconds inside the source audio
  end: number;
}

export interface AlignedWord {
  text: string;          // from the script (NOT Whisper)
  start: number;         // from Whisper if matched, interpolated otherwise
  end: number;
  /** false when this script word had no Whisper anchor and was interpolated.
   *  Useful for downstream display ("approximate timing"). */
  matched: boolean;
}

/** Lowercase + strip punctuation for fuzzy matching. The original-case
 *  text is retained in `display`. */
function normalize(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9'’]/g, '');
}

export function tokenizeScript(script: string): { display: string; norm: string }[] {
  return script
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ({ display: w, norm: normalize(w) }));
}

/**
 * Whisper response shapes vary. Common keys we accept:
 *  - { words: [{ text|word, start, end }, ...] }
 *  - { segments: [{ words: [...] }, ...] }
 *  - flat top-level array
 * Returns [] if we couldn't find any timed words.
 */
export function parseWhisperWords(payload: unknown): WhisperWord[] {
  const out: WhisperWord[] = [];
  const visit = (node: any): void => {
    if (!node) return;
    if (Array.isArray(node)) { for (const x of node) visit(x); return; }
    if (typeof node !== 'object') return;
    if (
      typeof node.start === 'number' && typeof node.end === 'number' &&
      (typeof node.text === 'string' || typeof node.word === 'string')
    ) {
      const text = String(node.text ?? node.word ?? '').trim();
      if (text) out.push({ text, start: Number(node.start), end: Number(node.end) });
      return;
    }
    if (Array.isArray(node.words)) visit(node.words);
    if (Array.isArray(node.segments)) visit(node.segments);
  };
  visit(payload);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Pair script words to Whisper words via classic edit-distance DP. Returns
 * one AlignedWord per script word. Whisper words may be skipped (insertion);
 * script words may have no Whisper anchor (substitution / deletion) — those
 * get their start/end linearly interpolated between the nearest matched
 * anchors so playback timing still feels right.
 */
export function alignWords(
  script: { display: string; norm: string }[],
  whisper: WhisperWord[],
): AlignedWord[] {
  const S = script.length, W = whisper.length;
  if (S === 0) return [];
  if (W === 0) {
    // No Whisper anchors — give every script word a uniform slot. Caller
    // will likely fall back to "no-audio" mode in that case anyway.
    return script.map((sw) => ({ text: sw.display, start: 0, end: 0, matched: false }));
  }

  // dp[i][j] = (cost, op) — op ∈ 'M' match | 'S' substitute | 'D' delete script | 'I' insert whisper
  const cost = Array.from({ length: S + 1 }, () => new Float64Array(W + 1));
  const op = Array.from({ length: S + 1 }, () => new Array<string>(W + 1).fill(''));
  for (let i = 0; i <= S; i++) { cost[i][0] = i; op[i][0] = 'D'; }
  for (let j = 0; j <= W; j++) { cost[0][j] = j; op[0][j] = 'I'; }
  op[0][0] = '';

  for (let i = 1; i <= S; i++) {
    for (let j = 1; j <= W; j++) {
      const sNorm = script[i - 1].norm;
      const wNorm = normalize(whisper[j - 1].text);
      const same = sNorm === wNorm;
      const matchC = cost[i - 1][j - 1] + (same ? 0 : 1);
      const delC = cost[i - 1][j] + 1;     // skip script word
      const insC = cost[i][j - 1] + 1;     // skip whisper word
      let best = matchC; let bestOp = same ? 'M' : 'S';
      if (delC < best) { best = delC; bestOp = 'D'; }
      if (insC < best) { best = insC; bestOp = 'I'; }
      cost[i][j] = best;
      op[i][j] = bestOp;
    }
  }

  // Backtrack: emit a pairing (scriptIdx → whisperIdx | null)
  const pairing: (number | null)[] = new Array(S).fill(null);
  let i = S, j = W;
  while (i > 0 || j > 0) {
    const o = op[i][j];
    if (o === 'M' || o === 'S') { pairing[i - 1] = j - 1; i--; j--; }
    else if (o === 'D')          { pairing[i - 1] = null;  i--; }
    else                          { j--; }   // 'I' — drop whisper word
  }

  // Fill timings. For matched script words, use Whisper's timing directly.
  // For unmatched (substituted/deleted), interpolate between the nearest
  // matched neighbors so the script word still appears at a believable time.
  const aligned: AlignedWord[] = script.map((sw, idx) => {
    const wj = pairing[idx];
    if (wj !== null) {
      return { text: sw.display, start: whisper[wj].start, end: whisper[wj].end, matched: true };
    }
    return { text: sw.display, start: 0, end: 0, matched: false };
  });

  // Walk the pairing to interpolate unmatched gaps.
  let lastAnchorIdx = -1;
  let lastTime = whisper[0]?.start ?? 0;
  for (let idx = 0; idx <= S; idx++) {
    const isAnchor = idx === S ? true : aligned[idx]?.matched;
    if (!isAnchor) continue;
    const anchorTime = idx === S ? (whisper[W - 1]?.end ?? lastTime + 0.5) : aligned[idx].start;
    const span = idx - lastAnchorIdx;
    if (span > 1) {
      const dt = (anchorTime - lastTime) / span;
      for (let k = 1; k < span; k++) {
        const gIdx = lastAnchorIdx + k;
        if (gIdx >= 0 && gIdx < S && !aligned[gIdx].matched) {
          aligned[gIdx].start = lastTime + dt * k;
          aligned[gIdx].end = lastTime + dt * (k + 1);
        }
      }
    }
    lastAnchorIdx = idx;
    lastTime = idx === S ? lastTime : aligned[idx].end;
  }

  return aligned;
}

export interface CaptionRowDraft {
  start: number;
  end: number;
  text: string;
}

/** True if the word ends a sentence by punctuation. */
function endsSentence(text: string): boolean { return /[.!?]$/.test(text); }
/** True if the word ends a clause by mid-sentence punctuation. */
function endsClause(text: string): boolean { return /[,;:]$/.test(text); }

/**
 * Group aligned words into caption rows in TWO passes:
 *
 *   Pass 1 — Sentence chunking.
 *     Split the word stream at HARD boundaries: `.` `!` `?`, explicit `\n`
 *     in a word, OR a big inter-word gap (Whisper sometimes misses the
 *     period; a >250ms pause between adjacent words is almost always a
 *     real sentence break). Each chunk is one "sentence" — the natural
 *     unit a reader expects to land on a single caption line.
 *
 *   Pass 2 — Sub-split long sentences.
 *     If a sentence fits (≤ wordsPerRow words AND ≤ maxRowSec), emit as
 *     ONE row. Otherwise split at clauses (`,` `;` `:`) preferring breaks
 *     that keep each piece within the limits; as a last resort split by
 *     word count using LOOK-BACK so the cut lands at the nearest natural
 *     boundary instead of an arbitrary 8th word.
 *
 *   Timing polish.
 *     Lead-in: row.start is pulled back by ~80ms (clamped to 0 / prev
 *     row's end) so the caption appears just as the speaker begins, not
 *     a few frames late. Whisper's word-onset stamps tend to be slightly
 *     conservative — this offset compensates without producing overlap.
 *
 *     Min duration: a row that lands shorter than ~700ms gets its end
 *     pushed forward (clamped to the next row's start) so the reader has
 *     time to actually finish reading it.
 *
 * The "first line-break, then sync" mental model maps onto this code as:
 * pass 1 is the LINE BREAK decision (purely structural — where do
 * sentences end?), pass 2 keeps the same structure but enforces visual
 * fit, and timings come from the underlying Whisper word stamps — so
 * line breaks and sync don't trade off against each other.
 */
export function groupIntoRows(
  aligned: AlignedWord[],
  offsetSec: number = 0,
  opts: {
    wordsPerRow?: number;
    maxRowSec?: number;
    minWordsBeforeComma?: number;
    /** Pause (s) between adjacent words that counts as an implicit
     *  sentence boundary when Whisper didn't transcribe a period. */
    implicitSentenceGapSec?: number;
    /** Pull row.start earlier by this much so captions appear right as
     *  the speaker begins. Clamped per-row to avoid overlap. */
    leadInSec?: number;
    /** Minimum on-screen duration for any row. */
    minRowSec?: number;
    /** Any internal silence inside a row at or above this length splits the
     *  row at that gap. Catches sentence boundaries that pass-1 missed AND
     *  prevents one row from sitting on screen across a silence (the
     *  "coast-to-coast" caption). Tighter than implicitSentenceGapSec
     *  because we already have the row built — splitting here only
     *  shortens; it doesn't merge anything new. */
    intraRowGapSec?: number;
  } = {},
): CaptionRowDraft[] {
  const wordsPerRow = opts.wordsPerRow ?? 8;
  const maxRowSec = opts.maxRowSec ?? 3.2;
  const minWordsBeforeComma = opts.minWordsBeforeComma ?? 3;
  const implicitGap = opts.implicitSentenceGapSec ?? 0.20;
  const leadInSec = opts.leadInSec ?? 0.08;
  const minRowSec = opts.minRowSec ?? 0.7;
  const intraRowGap = opts.intraRowGapSec ?? 0.18;

  // ─── Pass 1: chunk into sentences ────────────────────────────────────
  const sentences: AlignedWord[][] = [];
  let buf: AlignedWord[] = [];
  for (let i = 0; i < aligned.length; i++) {
    const w = aligned[i];
    // Newline inside a token forces a hard break around the newline.
    if (w.text.includes('\n')) {
      const parts = w.text.split('\n').filter(Boolean);
      const span = Math.max(0.05, w.end - w.start);
      const per = span / Math.max(1, parts.length);
      for (let p = 0; p < parts.length; p++) {
        buf.push({ text: parts[p], start: w.start + per * p, end: w.start + per * (p + 1), matched: w.matched });
        if (p < parts.length - 1) { sentences.push(buf); buf = []; }
      }
      continue;
    }
    buf.push(w);
    const next = aligned[i + 1];
    const interGap = next ? next.start - w.end : 0;
    // Implicit sentence boundary detection — Whisper often misses periods,
    // especially before short connector words. Two cumulative signals:
    //   • Pause > implicitGap (≈250ms) — natural sentence break in speech.
    //   • Even a short pause (>100ms) when the NEXT word starts capital
    //     AND the current word doesn't end with mid-sentence punctuation
    //     (commas, etc.). Capital-start mid-stream is almost always a new
    //     sentence; the !endsClause guard prevents misfires after "no,"
    //     when the next word happens to be a proper noun.
    const nextStartsNewSentence = next ? /^[A-Z]/.test(next.text) && !endsClause(w.text) : false;
    const hardEnd = endsSentence(w.text)
      || (next && (interGap > implicitGap || (interGap > 0.10 && nextStartsNewSentence)));
    if (hardEnd) { sentences.push(buf); buf = []; }
  }
  if (buf.length) sentences.push(buf);

  // ─── Pass 2: sub-split long sentences ────────────────────────────────
  const rowsOfWords: AlignedWord[][] = [];
  for (const sentence of sentences) {
    if (sentence.length === 0) continue;
    splitSentence(sentence, wordsPerRow, maxRowSec, minWordsBeforeComma, rowsOfWords);
  }

  // ─── Pass 3: split rows on internal silence ──────────────────────────
  //
  // Whisper word-level mode often returns plain words with no punctuation,
  // so pass 1's sentence detection has to rely on inter-word gaps alone.
  // When the speaker runs sentences together with a < implicitGap pause,
  // multiple sentences end up in one pass-1 chunk; the same applies to a
  // single sentence whose tail trails into silence before the next phrase.
  //
  // Either way the symptom is the same: a row whose ws[0].start →
  // ws[last].end window straddles a real silence, so the caption sits
  // on screen across the quiet part (the "coast-to-coast" bug). Walking
  // each row's word list and cutting at any internal gap ≥ intraRowGap
  // produces tighter rows that visibly track the audio.
  const splitRows: AlignedWord[][] = [];
  for (const row of rowsOfWords) {
    if (row.length === 0) continue;
    let segStart = 0;
    for (let i = 1; i < row.length; i++) {
      const gap = row[i].start - row[i - 1].end;
      if (gap >= intraRowGap) {
        splitRows.push(row.slice(segStart, i));
        segStart = i;
      }
    }
    splitRows.push(row.slice(segStart));
  }

  // ─── Build drafts + apply timing polish ──────────────────────────────
  const drafts: CaptionRowDraft[] = splitRows.map((ws) => ({
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    text: ws.map((w) => w.text).join(' '),
  }));

  // Lead-in: pull start back, clamped to 0 / previous row's end so we
  // never produce overlap. Walk in order so prevEnd is fresh.
  for (let i = 0; i < drafts.length; i++) {
    const prevEnd = i > 0 ? drafts[i - 1].end : 0;
    drafts[i].start = Math.max(prevEnd, drafts[i].start - leadInSec);
  }
  // Min display duration: extend end forward, clamped to next row's start.
  for (let i = 0; i < drafts.length; i++) {
    const nextStart = i + 1 < drafts.length ? drafts[i + 1].start : Infinity;
    if (drafts[i].end - drafts[i].start < minRowSec) {
      drafts[i].end = Math.min(nextStart, drafts[i].start + minRowSec);
    }
  }

  // Final no-overlap clamp, after offset is applied. Floats drift by
  // sub-ms across the lead-in / min-duration / offset passes; libass
  // (and our preview) stack any row whose start is even 1ms before the
  // previous row's end on top of it, producing the "captions sit at
  // different heights" visual. Round to 3 decimals and force a strict
  // ordering so adjacent rows just touch.
  const offset = (n: number): number => Math.round((n + offsetSec) * 1000) / 1000;
  const final: CaptionRowDraft[] = [];
  for (const r of drafts) {
    const start = offset(r.start);
    const end = offset(r.end);
    const lastEnd = final.length > 0 ? final[final.length - 1].end : 0;
    const safeStart = Math.max(start, lastEnd);
    const safeEnd = Math.max(safeStart + 0.05, end);
    final.push({ start: safeStart, end: safeEnd, text: r.text });
  }
  return final;
}

/**
 * Sub-split one sentence (already known to end at a real boundary).
 * Strategy:
 *   1. If it fits → one row.
 *   2. Else split at clause punctuation (`, ; :`). Greedy pack: accumulate
 *      clauses into a row until adding the next clause would overflow,
 *      then flush. If a single clause still overflows, fall through to (3).
 *   3. Else split by word count with LOOK-BACK: walk up to wordsPerRow,
 *      then search backwards from there for the most recent comma /
 *      semicolon / colon; cut there. If no clause boundary found, cut at
 *      the exact word limit (last resort).
 */
function splitSentence(
  sentence: AlignedWord[],
  wordsPerRow: number,
  maxRowSec: number,
  minWordsBeforeComma: number,
  out: AlignedWord[][],
): void {
  const sentenceDur = sentence[sentence.length - 1].end - sentence[0].start;
  if (sentence.length <= wordsPerRow && sentenceDur <= maxRowSec) {
    out.push(sentence);
    return;
  }

  // (2) Clause-aware greedy packing.
  // Build clause units first.
  const clauses: AlignedWord[][] = [];
  let cb: AlignedWord[] = [];
  for (const w of sentence) {
    cb.push(w);
    if (endsClause(w.text) && cb.length >= minWordsBeforeComma) {
      clauses.push(cb);
      cb = [];
    }
  }
  if (cb.length) clauses.push(cb);

  // Greedy pack clauses into rows.
  let row: AlignedWord[] = [];
  const flushRow = () => { if (row.length) { out.push(row); row = []; } };
  for (const clause of clauses) {
    const combinedLen = row.length + clause.length;
    const combinedDur = row.length === 0
      ? clause[clause.length - 1].end - clause[0].start
      : clause[clause.length - 1].end - row[0].start;
    if (row.length === 0 && (clause.length > wordsPerRow || combinedDur > maxRowSec)) {
      // Single clause is itself too long — fall back to word-count cut
      // (with look-back) for THIS clause and continue.
      splitByWordCount(clause, wordsPerRow, maxRowSec, out);
      continue;
    }
    if (combinedLen > wordsPerRow || combinedDur > maxRowSec) {
      flushRow();
    }
    row.push(...clause);
  }
  flushRow();
}

function splitByWordCount(words: AlignedWord[], wordsPerRow: number, maxRowSec: number, out: AlignedWord[][]): void {
  let i = 0;
  while (i < words.length) {
    let end = Math.min(i + wordsPerRow, words.length);
    // Apply duration cap.
    while (end > i + 1 && (words[end - 1].end - words[i].start) > maxRowSec) end--;
    // Anti-orphan: if cutting here would leave only 1–2 trailing words for
    // the FINAL chunk, absorb them now (slight overrun is OK — better than
    // a 0.2s "kind," row the reader can't even register).
    if (words.length - end > 0 && words.length - end <= 2 && words.length - i <= wordsPerRow + 2) {
      end = words.length;
    }
    // Look-back for a natural break inside [i, end). Range is k > i so the
    // very first word AFTER i (k = i+1) is a valid cut point — otherwise a
    // sentence like "I'm crying, but the tears…" would never get to cut at
    // "crying," and the whole 9-word run lands as a single row.
    let cut = end;
    for (let k = end - 1; k > i; k--) {
      if (endsClause(words[k].text) || endsSentence(words[k].text)) { cut = k + 1; break; }
    }
    out.push(words.slice(i, cut));
    i = cut;
  }
}
