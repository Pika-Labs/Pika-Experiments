import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { subscribeServerEvents } from '../sse';
import { useEscapeKey } from '../useEscapeKey';
import { useStore, assetUrl } from '../store';
import * as api from '../api';
import { HoverScrubVideo } from './HoverScrubVideo';

/** Toggle a workspace tile's file as a chat-composer attachment chip.
 *  First click attaches and focuses the textarea; second click on the
 *  same tile removes the chip. Replaces the older "paste a [token]"
 *  affordance — the chip is visual, removable, and the agent sees the
 *  actual file path via the send pipeline. */
function toggleTalkAbout(att: { rel: string; kind: 'image' | 'video' | 'audio' | 'other'; name: string }): boolean {
  const s = useStore.getState();
  const id = `att_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000).toString(36)}`;
  const cleanRel = att.rel.replace(/^assets\//, '');
  const rel = cleanRel.startsWith('assets/') ? cleanRel : `assets/${cleanRel}`;
  const added = s.toggleChatAttachment({ id, rel, kind: att.kind, name: att.name });
  if (added) s.focusChatInput();
  return added;
}

interface TalkAboutTarget { rel: string; kind: 'image' | 'video' | 'audio' | 'other'; name: string }

/** Render the "What I need from you" card. If `ask` is a structured
 *  block with `items`, surfaces each as a quick-reply chip that fills
 *  the chat input with the agent's pre-written reply on click (same
 *  pattern as `TalkAboutButton` — populate draft + focus, user hits
 *  Enter). For freeform string asks, falls back to a plain text body.
 *
 *  Chips don't auto-submit — the user might want to edit ("Greenlight
 *  on 1, but use Avery instead of Reg"). One click + Enter is the
 *  intended pace. */
/** Parse a freeform ask string for numbered items so legacy workspace
 *  data (pre-structured-ask schema) still gets greenlight chips.
 *  Recognizes:
 *    - "(1) ... (2) ... (3) ..."     ← parenthesized
 *    - "1. ... 2. ... 3. ..."         ← dot-prefixed
 *    - "1) ... 2) ... 3) ..."         ← close-paren
 *  Returns items with a short label + a templated reply. Bails (returns
 *  []) when fewer than 2 items are found — single-item parses tend to
 *  be false positives. */
function parseFreeformAsk(text: string): api.WorkspaceAskItem[] {
  if (!text) return [];
  const pattern = /(?:^|\s)(?:\((\d+)\)|(\d+)[.)])\s+/g;
  const matches: { num: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const num = parseInt(m[1] ?? m[2] ?? '', 10);
    if (Number.isFinite(num)) {
      matches.push({ num, start: m.index, end: pattern.lastIndex });
    }
  }
  if (matches.length < 2) return [];
  // Slice text between marker positions to capture each item body.
  const items: api.WorkspaceAskItem[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const body = text.slice(cur.end, next ? next.start : text.length).trim().replace(/[.,;:]+$/, '');
    if (!body) continue;
    items.push({
      id: `auto-${cur.num}`,
      label: `Greenlight #${cur.num}`,
      reply: `Greenlight #${cur.num} — ${body}`,
    });
  }
  return items;
}

function AskBlock({ ask }: { ask: api.WorkspaceAsk }) {
  const setChatDraft = useStore((s) => s.setChatDraft);
  const focusChatInput = useStore((s) => s.focusChatInput);
  function fire(reply: string): void {
    setChatDraft(reply);
    focusChatInput();
  }
  // Freeform string ask — render text, then layer chips on top.
  // Parser pulls out "(1)... (2)..." style numbered items; if it finds
  // ≥2 it shows one chip per item. If it finds none we still surface a
  // generic "Greenlight" chip so the user can confirm with one click
  // even on un-numbered asks.
  if (typeof ask === 'string') {
    const parsed = parseFreeformAsk(ask);
    return (
      <div className="ws-ask">
        <div className="ws-ask-h">What I need from you</div>
        <div className="ws-ask-body">{ask}</div>
        <div className="ws-ask-actions">
          {parsed.length > 0 ? (
            parsed.map((it, i) => (
              <button
                key={it.id ?? `${i}-${it.label}`}
                className="ws-ask-chip"
                title={it.reply}
                onClick={() => fire(it.reply)}
              >
                {it.label}
              </button>
            ))
          ) : (
            <button
              className="ws-ask-chip"
              title="Send a greenlight message"
              onClick={() => fire('Greenlight — go ahead.')}
            >
              Greenlight
            </button>
          )}
        </div>
      </div>
    );
  }
  // Structured ask — agent wrote items directly. Trust them verbatim.
  return (
    <div className="ws-ask">
      <div className="ws-ask-h">{ask.headline || 'What I need from you'}</div>
      {ask.body && <div className="ws-ask-body">{ask.body}</div>}
      {ask.items && ask.items.length > 0 && (
        <div className="ws-ask-actions">
          {ask.items.map((it, i) => (
            <button
              key={it.id ?? `${i}-${it.label}`}
              className="ws-ask-chip"
              title={it.reply}
              onClick={() => fire(it.reply)}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per-tile selection button rendered on every item of a multi-tile
 *  image-grid / video-grid. Fills the chat draft with a row-specific
 *  pick message and focuses the input — same one-click pattern as
 *  AskBlock chips and ProposalRow Approve / Reject. This is the
 *  system-level guarantee that choice menus always have selection
 *  affordances, even if the agent forgot to wire ask.items. */
function TilePickButton({ label }: { label: string }) {
  const setChatDraft = useStore((s) => s.setChatDraft);
  const focusChatInput = useStore((s) => s.focusChatInput);
  const reply = `Pick "${label}" — go with this one.`;
  return (
    <button
      className="ws-pri-pick"
      title={reply}
      onClick={(e) => {
        e.stopPropagation();
        setChatDraft(reply);
        focusChatInput();
      }}
    >
      Pick this
    </button>
  );
}

function TalkAboutButton({ target }: { target: TalkAboutTarget }) {
  const normalizedRel = (() => {
    const r = target.rel.replace(/^assets\//, '');
    return r.startsWith('assets/') ? r : `assets/${r}`;
  })();
  const isAttached = useStore((s) => s.chatAttachments.some((a) => a.rel === normalizedRel));
  return (
    <button
      className={`ws-talk-btn ${isAttached ? 'is-on' : ''}`}
      title={isAttached ? `Remove from chat: ${target.name}` : `Talk about it: ${target.name}`}
      aria-pressed={isAttached}
      onClick={(e) => { e.stopPropagation(); toggleTalkAbout(target); }}
    >
      {isAttached ? '✓ attached' : 'Talk about it'}
    </button>
  );
}

/** Icon-only media-type badge — top-left corner of every workspace
 *  tile. Both variants share the SAME chip surface (white-translucent
 *  + blur + ink border) and SAME stroke weight, so they read as a
 *  single visual family; only the glyph swaps. Image = picture frame
 *  with sun + horizon. Video = film-strip rectangle with side
 *  sprocket holes — clearly motion-media, not just a play arrow. */
function MediaBadge({ isVideo, model }: { isVideo: boolean; model?: string | null }) {
  // Hover expands the badge into a pill that slides out the model name
  // ("kling-v3-omni", "gpt-image-2", …) next to the icon. Falls back to
  // the generic kind ("Image" / "Video") when no model is bound. The
  // expansion is CSS-driven — the label sits in a span with max-width
  // animated 0 → ch, opacity 0 → 1.
  const kind = isVideo ? 'Video' : 'Image';
  const label = model || kind;
  return (
    <span className={`ws-media-badge ws-media-badge-${isVideo ? 'video' : 'image'}`} aria-label={`${kind}${model ? ` · ${model}` : ''}`}>
      {isVideo ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="5" width="18" height="14" rx="2.5"/>
          <line x1="7" y1="5" x2="7" y2="19"/>
          <line x1="17" y1="5" x2="17" y2="19"/>
          <line x1="3" y1="9" x2="7" y2="9"/>
          <line x1="3" y1="15" x2="7" y2="15"/>
          <line x1="17" y1="9" x2="21" y2="9"/>
          <line x1="17" y1="15" x2="21" y2="15"/>
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="3" width="18" height="18" rx="2.5"/>
          <circle cx="9" cy="9" r="1.6" fill="currentColor" stroke="none"/>
          <path d="M21 16l-5-5-7 7"/>
        </svg>
      )}
      <span className="ws-media-badge-label">{label}</span>
    </span>
  );
}

/** Tiny markdown-to-JSX renderer for brief.md + body fields. Handles headings,
 *  bold/italic, code, bullet lists, tables, blockquotes, paragraphs. */
function renderMarkdown(src: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  // Tolerate agent-written bodies that escaped characters twice (e.g.
  // via a bash heredoc or a double-stringify upstream). The data on disk
  // then contains literal `\n`, `\t`, and `\uXXXX` SEQUENCES instead of
  // real whitespace / Unicode chars. Symptoms:
  //   - `\n\n` paragraph breaks render as visible "\N\N" markers
  //   - Smart quotes ("curly quotes") show as raw `“` / `”`
  //   - Em dashes show as `—`
  //   - Apostrophes show as `’`
  //
  // Unescape conservatively before splitting. Real backslash-letter
  // sequences in markdown body are vanishingly rare; falling through to
  // the decoded char is the harmless interpretation.
  const normalized = src
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    // \uXXXX → corresponding code point. Covers smart quotes, em dashes,
    // apostrophes, anything else JSON.stringify would have escaped.
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  const lines = normalized.split('\n');
  let i = 0;
  let key = 0;
  const inline = (s: string): (JSX.Element | string)[] => {
    const parts: (JSX.Element | string)[] = [];
    let rest = s;
    while (rest.length) {
      const m = rest.match(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/);
      if (!m) { parts.push(rest); break; }
      const before = rest.slice(0, m.index!);
      if (before) parts.push(before);
      const token = m[1];
      if (token.startsWith('**')) parts.push(<strong key={`b${key++}`}>{token.slice(2, -2)}</strong>);
      else if (token.startsWith('`')) parts.push(<code key={`c${key++}`}>{token.slice(1, -1)}</code>);
      else parts.push(<em key={`i${key++}`}>{token.slice(1, -1)}</em>);
      rest = rest.slice((m.index ?? 0) + token.length);
    }
    return parts;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const Tag = (`h${Math.min(level, 6)}`) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      out.push(<Tag key={key++} className={`md-h md-h${level}`}>{inline(h[2])}</Tag>);
      i++; continue;
    }
    if (line.includes('|') && lines[i + 1]?.match(/^\s*\|?[-:\s|]+\|?\s*$/)) {
      const headers = line.split('|').map((s) => s.trim()).filter(Boolean);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) {
        const r = lines[i].split('|').map((s) => s.trim());
        rows.push(r.filter((_, idx) => idx > 0 || r[0] !== ''));
        i++;
      }
      out.push(
        <table key={key++} className="md-table">
          <thead><tr>{headers.map((h, idx) => <th key={idx}>{inline(h)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ridx) => (
            <tr key={ridx}>{r.map((c, cidx) => <td key={cidx}>{inline(c)}</td>)}</tr>
          ))}</tbody>
        </table>
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push(<ul key={key++} className="md-ul">{items.map((t, idx) => <li key={idx}>{inline(t)}</li>)}</ul>);
      continue;
    }
    if (line.startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) { buf.push(lines[i].slice(2)); i++; }
      out.push(<blockquote key={key++} className="md-quote">{buf.map((t, idx) => <div key={idx}>{inline(t)}</div>)}</blockquote>);
      continue;
    }
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
      i++;
      out.push(<pre key={key++} className="md-pre"><code>{buf.join('\n')}</code></pre>);
      continue;
    }
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^(#{1,6}\s|\s*[-*]\s|>|```)/) && !lines[i].includes('|')) {
      buf.push(lines[i]); i++;
    }
    out.push(<p key={key++} className="md-p">{inline(buf.join(' '))}</p>);
  }
  return out;
}

interface PreviewState { rel: string; kind: 'image' | 'video' | 'audio' | 'other'; name: string }

function Lightbox({ preview, onClose }: { preview: PreviewState; onClose: () => void }) {
  useEscapeKey(true, onClose);
  return (
    <div className="render-modal-backdrop" onClick={onClose}>
      <div className="workspace-lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="render-modal-head">
          <div>
            <div className="render-modal-title">{preview.name}</div>
            <div className="render-modal-sub">{preview.rel}</div>
          </div>
          <button className="render-modal-close" onClick={onClose}>×</button>
        </div>
        {preview.kind === 'image' && <img src={assetUrl(preview.rel)} alt={preview.name} style={{ maxWidth: '100%', maxHeight: '75vh', display: 'block', margin: '0 auto', borderRadius: 'var(--r-md)' }} />}
        {preview.kind === 'video' && <video src={assetUrl(preview.rel)} controls autoPlay style={{ width: '100%', maxHeight: '75vh', borderRadius: 'var(--r-md)', background: '#000', display: 'block' }} />}
        {preview.kind === 'audio' && <audio src={assetUrl(preview.rel)} controls autoPlay style={{ width: '100%' }} />}
      </div>
    </div>
  );
}

/** Renders the primary visual block per workspace.json. Each `kind` gets a
 *  tailored layout — image-grid, two-up-compare, single, video-grid, proposal,
 *  compare. */
// 5 minutes — long enough that a legitimate slow gen (kling-omni multi-shot,
// big seedance r2v batch) doesn't get flagged STUCK while it's still alive
// on the Pika side. Previously 90s, which fired false-positives on the
// 14-shot batches the user reported. The workspace ALSO re-polls
// /agent/pika-gens every 5s so missed SSE events don't push tiles into
// STUCK falsely — the threshold is the second line of defence, not the
// only one.
const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

/** Top-of-workspace banner that surfaces when ≥1 stuck tile exists, with
 *  a one-click "clear all" that dismisses every stuck tile in one go.
 *  Dismisses descend by index so earlier dismissals don't shift later
 *  indices — and each dismiss-tile call also fires task_cancel on the
 *  underlying Pika task, so we're not just hiding the symptom. */
function ClearStuckBanner({ items, genMap, workspaceGeneratedAt, nowTick, isSnapshot }: {
  items: api.WorkspaceItem[];
  genMap: Map<string, api.LiveGen>;
  workspaceGeneratedAt: number | null;
  nowTick: number;
  isSnapshot: boolean;
}) {
  // "Stuck" is a live-state affordance. In a historical snapshot the gen
  // already concluded — the tile is just frozen mid-flight. Showing it as
  // stuck (and offering a Clear button that can't actually edit history)
  // is misleading, so the banner is suppressed when viewing a snapshot.
  if (isSnapshot) return null;
  const isTileStuck = (it: api.WorkspaceItem): boolean => {
    const liveGen = it.taskId ? genMap.get(it.taskId) : undefined;
    if (liveGen?.status === 'error') return true;
    const resolved = it.src || (liveGen?.status === 'done' ? liveGen.resultPreview : undefined);
    return (
      !resolved
      && !liveGen
      && it.pending === true
      && workspaceGeneratedAt !== null
      && nowTick - workspaceGeneratedAt > ORPHAN_THRESHOLD_MS
    );
  };
  const stuckIdxs = items
    .map((it, i) => (isTileStuck(it) ? i : -1))
    .filter((i) => i >= 0);
  if (stuckIdxs.length === 0) return null;
  async function clearAll(): Promise<void> {
    // Descend so each removal leaves earlier indices intact.
    for (let i = stuckIdxs.length - 1; i >= 0; i--) {
      try { await api.dismissWorkspaceTile(stuckIdxs[i]); }
      catch { /* keep going; one failure shouldn't block the rest */ }
    }
  }
  return (
    <div className="ws-stuck-banner">
      <span>
        {stuckIdxs.length} stuck generation{stuckIdxs.length === 1 ? '' : 's'} — these died silently and can be cleared.
      </span>
      <button className="ws-stuck-banner-btn" onClick={() => void clearAll()}>
        Clear stuck ({stuckIdxs.length})
      </button>
    </div>
  );
}

function PrimaryBlock({ primary, onPreview, genMap, workspaceGeneratedAt, nowTick, isSnapshot, phase }: {
  primary: api.WorkspacePrimary;
  onPreview: (p: PreviewState) => void;
  genMap: Map<string, api.LiveGen>;
  workspaceGeneratedAt: number | null;
  nowTick: number;
  isSnapshot: boolean;
  phase?: string;
}) {
  if (primary.kind === 'none' || primary.items.length === 0) return null;

  // Proposal: keep/change/regen rows with disposition pills + collapsed rationale
  if (primary.kind === 'proposal') {
    return <ProposalBlock items={primary.items} commitLabel={primary.commitLabel} onPreview={onPreview} isSnapshot={isSnapshot} />;
  }
  // Compare: before/after image pairs
  if (primary.kind === 'compare') {
    return <CompareBlock items={primary.items} onPreview={onPreview} />;
  }

  // Item-list kinds (image-grid, video-grid, ...) use the same tile renderer
  const items = primary.items as api.WorkspaceItem[];
  // Choice classification — decides whether each tile renders a "Pick this"
  // selection button. Cheap, defensive heuristics so storyboards, shot
  // grids, and placeholder-first gen batches are NEVER mistagged as menus.
  //
  // Explicit signal wins: the agent can set `primary.selectable: true|false`
  // on the workspace write to override. When omitted, classification is:
  //
  //   sequence (no Pick) if ANY of:
  //     - any tile has pending=true        (mid-gen placeholder batch)
  //     - any tile has taskId              (gen-bound batch — storyboard/shotlist)
  //     - any tile's label is sequence-shaped  ("01 · …", "Shot 2", "Beat 7", "Act 3", "Clip 04", "Scene 5")
  //     - the workspace phase is gen-stage     ("Generating", "Rendering", "Producing", "Production"-with-gen-context)
  //
  //   choice menu (Pick on every tile) otherwise, when there are ≥2 items.
  //
  // Single-item grids never get Pick — nothing to choose between.
  const explicitSelectable = (primary as unknown as { selectable?: boolean }).selectable;
  const looksSequenceLabel = (s: string): boolean =>
    /^\s*(?:\d{1,2}\s*[·.\-:]|shot\s*\d|beat\s*\d|act\s*\d|clip\s*\d|scene\s*\d|sc[_\-]?\d)/i.test(s);
  // Strict: only ACTIVE-gen states ("Generating", "Rendering"). Don't
  // include "Pre-Production" — that's a planning phase that often hosts
  // the choice menu itself (e.g. "Pre-Production · Pick Your Trope").
  const phaseLooksGen = phase ? /(generating|rendering|generated|rendered)/i.test(phase) : false;
  const anyPending = items.some((it) => it && (it as any).pending === true);
  const anyTaskId = items.some((it) => it && typeof (it as any).taskId === 'string');
  const anySequenceLabel = items.some((it) => typeof it.label === 'string' && looksSequenceLabel(it.label));
  const autoIsChoice = items.length >= 2 && !anyPending && !anyTaskId && !anySequenceLabel && !phaseLooksGen;
  const isChoiceMenu = explicitSelectable === undefined ? autoIsChoice : explicitSelectable;
  const tileImg = (it: api.WorkspaceItem, idx: number, isVideo = false) => {
    // Live-bind resolution: if the tile carries a `taskId`, look up the
    // gen in genMap and override (src from resultPreview, pending from
    // status, plus a `failed` flag for error states). The agent doesn't
    // need to call write_workspace again — tiles fill in real time.
    //
    // A historical snapshot is an immutable view of saved JSON — never let
    // a still-in-memory live gen with the same taskId mutate an archived
    // tile (override its src, flip it to error, or show a live spinner).
    const liveGen = (!isSnapshot && it.taskId) ? genMap.get(it.taskId) : undefined;
    const liveGenRunning = liveGen?.status === 'running';
    // While a gen is actively running, IGNORE the tile's `src` field — the
    // agent often pre-writes a future path (e.g. "assets/refs/doug.png")
    // BEFORE the file exists on disk. Rendering that as an <img> produces
    // the browser's broken-image icon until the auto-bind lands. Once
    // liveGen.status is 'done' (auto-bind has updated the tile's real src
    // via workspace.json), or there's no liveGen at all (gen finished long
    // ago, src is settled), we trust the tile's `src` again.
    const resolvedSrc = liveGenRunning
      ? undefined
      : (it.src || (liveGen?.status === 'done' ? liveGen.resultPreview : undefined));
    const liveGenFailed = liveGen?.status === 'error';
    // Orphan detection: ONLY tiles the agent EXPLICITLY marked as
    // pending count as stuck after the timeout. Text-only concept
    // tiles (no src, no pending, no taskId) are legitimate cards that
    // just describe an idea — they have label + action + dialogue but
    // no media. Pre-v2 they rendered as shimmer placeholders (also a
    // bug); now they fall through to a clean meta-only card below.
    // Orphan-timeout "stuck" detection only makes sense for the live
     // workspace. In a snapshot the gen long since concluded — the tile
     // is frozen mid-flight and would always trip the timeout.
    const isStuck = !isSnapshot
      && !resolvedSrc
      && !liveGen
      && it.pending === true                   // explicit pending only
      && workspaceGeneratedAt !== null
      && nowTick - workspaceGeneratedAt > ORPHAN_THRESHOLD_MS;
    // Persistent failure state set by the server when auto-bind /
    // download / PATCH fails. Survives the in-memory LiveGen's 8s
    // expiry and page refreshes — without this, a tile's failure
    // message disappeared as soon as the LiveGen aged out, leaving
    // a "Stuck" placeholder that gave no clue why it failed.
    const tilePersistedFailed = (it as { failed?: boolean }).failed === true;
    const tilePersistedErrMsg = (it as { errorMessage?: string }).errorMessage;
    const isFailed = tilePersistedFailed || liveGenFailed || isStuck;
    const failedMessage = tilePersistedFailed
      ? (tilePersistedErrMsg ?? 'gen failed')
      : liveGenFailed
        ? (liveGen?.errorMessage ?? 'gen failed')
        : isStuck
          ? 'Stuck — gen died silently. Click × to clear.'
          : null;
    // Placeholder shimmer ONLY when the agent explicitly signaled a
    // pending media slot. Text-only concept tiles (no src, no pending,
    // no taskId) fall through to a meta-only card — no fake spinner.
    const isPlaceholder = !resolvedSrc && !isFailed && (it.pending === true || liveGen?.status === 'running');
    // Reference token for "talk about this": prefer explicit id, fall back to
    // a label slug, else the index. Always wrapped in []  so the agent sees
    // it as a structured reference. Only enable once a real local-asset src
    // exists (CDN urls from live-gen overrides aren't valid talk-about refs).
    const attTarget: TalkAboutTarget | null = it.src
      ? {
          rel: it.src.startsWith('assets/') ? it.src : `assets/${it.src}`,
          kind: isVideo ? 'video' : 'image',
          name: it.label ?? it.src.split('/').pop() ?? 'asset',
        }
      : null;
    // resolvedSrc may be a CDN URL (when coming from live-gen) — `assetUrl`
    // is a passthrough for absolute http(s) URLs, so we can feed it both.
    const previewRel = resolvedSrc ? resolvedSrc.replace(/^assets\//, '') : '';
    return (
    <div key={idx} className="ws-pri-tile-wrap">
      {isFailed ? (
        <div className="ws-pri-tile ws-pri-tile-failed" aria-label={`${it.label ?? 'tile'} — failed`} title={failedMessage ?? undefined}>
          <button
            className="ws-pri-tile-dismiss"
            title="Dismiss — removes this tile from workspace.json"
            aria-label="Dismiss tile"
            onClick={(e) => {
              e.stopPropagation();
              void api.dismissWorkspaceTile(idx);
            }}
          >×</button>
          <div className="ws-pri-tile-failed-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="13"/>
              <line x1="12" y1="16" x2="12" y2="16.01"/>
            </svg>
          </div>
          <div className="ws-pri-tile-failed-text">
            <div className="ws-pri-tile-failed-h">{isStuck ? 'Stuck' : 'Generation failed'}</div>
            {failedMessage && <div className="ws-pri-tile-failed-msg">{failedMessage}</div>}
          </div>
        </div>
      ) : isPlaceholder ? (
        <div className="ws-pri-tile ws-pri-tile-placeholder" aria-label={it.label ?? 'pending'}>
          <span className="ws-pri-tile-spin" />
          {(typeof liveGen?.progressPct === 'number' || typeof liveGen?.progress === 'number' || liveGen?.progressMessage) && (
            <div className="ws-pri-tile-progress" aria-label={liveGen.progressMessage ?? 'working'}>
              {typeof liveGen.progressPct === 'number' ? (
                <div className="ws-pri-tile-progress-num">{liveGen.progressPct}%</div>
              ) : typeof liveGen.progress === 'number' ? (
                // Pika emits an elapsed-seconds heartbeat, not a percentage.
                // Render it as "Xs" so the user sees movement.
                <div className="ws-pri-tile-progress-num">{liveGen.progress}s</div>
              ) : null}
              {liveGen.progressMessage && (
                <div className="ws-pri-tile-progress-msg">{liveGen.progressMessage}</div>
              )}
            </div>
          )}
        </div>
      ) : resolvedSrc ? (
      <button
        className="ws-pri-tile"
        onClick={() => onPreview({ rel: previewRel, kind: isVideo ? 'video' : 'image', name: it.label ?? previewRel.split('/').pop() ?? 'asset' })}
      >
        {isVideo
          ? <HoverScrubVideo src={assetUrl(resolvedSrc)} />
          : <img src={assetUrl(resolvedSrc)} alt={it.label ?? ''} loading="lazy" />
        }
        <MediaBadge isVideo={isVideo} model={it.model ?? liveGen?.model ?? null} />
      </button>
      ) : (
        // Text-only concept card — agent wrote a tile with no src and
        // no pending flag. Just render the meta block below; no media
        // surface, no fake spinner.
        null
      )}
      {attTarget && <TalkAboutButton target={attTarget} />}
      {(it.label || it.action || it.dialogue?.length || it.caption) && (
        <div className="ws-pri-meta">
          {it.label && <div className="ws-pri-label">{it.label}</div>}
          {it.action && <div className="ws-pri-action">{it.action}</div>}
          {it.dialogue && it.dialogue.length > 0 && (
            <div className="ws-pri-dlg">
              {it.dialogue.map((d, i) => (
                <div key={i} className="ws-pri-dlg-line">
                  {d.who && <span className="ws-pri-dlg-who">{d.who}</span>}
                  <span className="ws-pri-dlg-text">{d.line}</span>
                </div>
              ))}
            </div>
          )}
          {it.caption && <div className="ws-pri-caption">{it.caption}</div>}
        </div>
      )}
      {isChoiceMenu && <TilePickButton label={it.label ?? `Option ${idx + 1}`} />}
    </div>
  );
  };

  if (primary.kind === 'image-grid') {
    return <div className="ws-pri-grid">{items.map((it, i) => tileImg(it, i, false))}</div>;
  }
  if (primary.kind === 'video-grid') {
    return <div className="ws-pri-grid">{items.map((it, i) => tileImg(it, i, true))}</div>;
  }
  if (primary.kind === 'two-up-compare') {
    return (
      <div className="ws-pri-twoup">
        {items.slice(0, 2).map((it, i) => (
          <div key={i} className="ws-pri-twoup-half">
            <button
              className="ws-pri-tile"
              onClick={() => onPreview({ rel: (it.src ?? '').replace(/^assets\//, ''), kind: 'image', name: it.label ?? '' })}
            >
              <img src={assetUrl(it.src ?? '')} alt={it.label ?? ''} />
              <MediaBadge isVideo={false} model={it.model ?? (it.taskId && genMap.get(it.taskId)?.model) ?? null} />
            </button>
            {it.label && <div className="ws-pri-label" style={{ fontSize: 12 }}>{it.label}</div>}
            {it.caption && <div className="ws-pri-caption">{it.caption}</div>}
          </div>
        ))}
      </div>
    );
  }
  if (primary.kind === 'single' || primary.kind === 'video-player') {
    const it = items[0];
    const isVideo = primary.kind === 'video-player' || !!it.src?.match(/\.(mp4|mov|webm)$/i);
    return (
      <div className="ws-pri-single">
        <button
          className="ws-pri-tile"
          onClick={() => onPreview({ rel: (it.src ?? '').replace(/^assets\//, ''), kind: isVideo ? 'video' : 'image', name: it.label ?? '' })}
        >
          {isVideo
            ? <HoverScrubVideo src={assetUrl(it.src ?? '')} />
            : <img src={assetUrl(it.src ?? '')} alt={it.label ?? ''} />
          }
          <MediaBadge isVideo={isVideo} model={it.model ?? (it.taskId && genMap.get(it.taskId)?.model) ?? null} />
        </button>
        {it.label && <div className="ws-pri-label" style={{ fontSize: 12 }}>{it.label}</div>}
        {it.caption && <div className="ws-pri-caption">{it.caption}</div>}
      </div>
    );
  }
  return null;
}

/** Proposal block — each row is a decision with disposition + summary +
 *  optional before/after thumbnails + collapsed rationale. Decisions are
 *  read-only for now (round-trip to chat comes next phase); the user reads
 *  the proposal at a glance and replies in chat. */
function ProposalBlock({ items, commitLabel, onPreview, isSnapshot }: { items: api.ProposalItem[]; commitLabel?: string; onPreview: (p: PreviewState) => void; isSnapshot: boolean }) {
  const counts = items.reduce((acc, it) => { acc[it.disposition] = (acc[it.disposition] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  const summary = (['regen', 'change', 'new', 'keep', 'drop'] as const).filter((d) => counts[d]).map((d) => `${counts[d]} ${d}`).join(' · ');
  return (
    <div className="ws-prop">
      <div className="ws-prop-summary">{summary}{commitLabel ? ` · ${commitLabel}` : ''}</div>
      <div className="ws-prop-list">
        {items.map((it) => <ProposalRow key={it.id} item={it} onPreview={onPreview} isSnapshot={isSnapshot} />)}
      </div>
    </div>
  );
}

function ProposalRow({ item, onPreview, isSnapshot }: { item: api.ProposalItem; onPreview: (p: PreviewState) => void; isSnapshot: boolean }) {
  const [rationaleOpen, setRationaleOpen] = useState(false);
  const setChatDraft = useStore((s) => s.setChatDraft);
  const focusChatInput = useStore((s) => s.focusChatInput);
  const previewAsset = (rel: string, label: string) => onPreview({ rel: rel.replace(/^assets\//, ''), kind: rel.match(/\.(mp4|mov|webm)$/i) ? 'video' : 'image', name: label });
  // One-click decisions for this specific row. Fills the chat draft with
  // a pre-written reply that names the item + the verb — the agent can
  // tell which row the user acted on, and the user can still edit before
  // hitting Enter (same don't-auto-submit pattern as AskBlock chips).
  const reply = (verb: 'approve' | 'reject'): string =>
    verb === 'approve'
      ? `Approve "${item.label}" — ${item.disposition} as proposed.`
      : `Reject "${item.label}" — don't do this one.`;
  function fire(verb: 'approve' | 'reject'): void {
    setChatDraft(reply(verb));
    focusChatInput();
  }
  return (
    <div className={`ws-prop-row ws-prop-${item.disposition}`}>
      <div className="ws-prop-head">
        <span className={`ws-prop-pill ws-prop-pill-${item.disposition}`}>{item.disposition}</span>
        <span className="ws-prop-label">{item.label}</span>
        {/* Decisions are actionable only on the live workspace. In a
            historical snapshot the proposal is stale — approving it would
            queue work against a view the agent has already moved past. */}
        {!isSnapshot && (
          <div className="ws-prop-actions">
            <button className="ws-prop-action ws-prop-action-approve" onClick={() => fire('approve')} title={reply('approve')}>
              Approve
            </button>
            <button className="ws-prop-action ws-prop-action-reject" onClick={() => fire('reject')} title={reply('reject')}>
              Reject
            </button>
          </div>
        )}
      </div>
      {item.summary && <div className="ws-prop-summary-line">{item.summary}</div>}
      {(item.fromSrc || item.toSrc || item.fromNote || item.toNote) && (
        <div className="ws-prop-fromto">
          {(item.fromSrc || item.fromNote) && (
            <div className="ws-prop-side ws-prop-from">
              <div className="ws-prop-side-h">From</div>
              {item.fromSrc && (
                <button className="ws-pri-tile" onClick={() => previewAsset(item.fromSrc!, `${item.label} (current)`)}>
                  <img src={assetUrl(item.fromSrc)} alt={`${item.label} current`} loading="lazy" />
                </button>
              )}
              {item.fromNote && <div className="ws-prop-side-note">{item.fromNote}</div>}
            </div>
          )}
          {(item.toSrc || item.toNote) && (
            <div className="ws-prop-side ws-prop-to">
              <div className="ws-prop-side-h">To</div>
              {item.toSrc && (
                <button className="ws-pri-tile" onClick={() => previewAsset(item.toSrc!, `${item.label} (proposed)`)}>
                  <img src={assetUrl(item.toSrc)} alt={`${item.label} proposed`} loading="lazy" />
                </button>
              )}
              {item.toNote && <div className="ws-prop-side-note">{item.toNote}</div>}
            </div>
          )}
        </div>
      )}
      {item.rationale && (
        <button className="ws-prop-rationale-head" onClick={() => setRationaleOpen(!rationaleOpen)}>
          <span className="ws-prop-rationale-chev">{rationaleOpen ? '▾' : '▸'}</span>
          <span>Why</span>
        </button>
      )}
      {item.rationale && rationaleOpen && <div className="ws-prop-rationale">{item.rationale}</div>}
    </div>
  );
}

/** Compare block — side-by-side from/to pairs, no decision affordance.
 *  Defensive: accepts either `fromSrc`/`toSrc` or legacy `beforeSrc`/`afterSrc`
 *  names, and renders a placeholder for any missing image so the agent
 *  can't break the page by omitting a field. */
function CompareBlock({ items, onPreview }: { items: api.CompareItem[]; onPreview: (p: PreviewState) => void }) {
  return (
    <div className="ws-cmp">
      {items.map((it, i) => {
        // Accept legacy names too — the agent occasionally swaps in
        // beforeSrc/afterSrc from older examples.
        const anyIt = it as unknown as { fromSrc?: string; toSrc?: string; beforeSrc?: string; afterSrc?: string };
        const fromSrc = anyIt.fromSrc ?? anyIt.beforeSrc;
        const toSrc = anyIt.toSrc ?? anyIt.afterSrc;
        return (
          <div key={i} className="ws-cmp-row">
            <div className="ws-cmp-head">{it.label}</div>
            <div className="ws-cmp-pair">
              <ComparePane label="From" src={fromSrc} alt={`${it.label} from`} className="ws-cmp-before" onPreview={onPreview} />
              <ComparePane label="To"   src={toSrc}   alt={`${it.label} to`}   className="ws-cmp-after"  onPreview={onPreview} />
            </div>
            {it.note && <div className="ws-cmp-note">{it.note}</div>}
          </div>
        );
      })}
    </div>
  );
}

function ComparePane({ label, src, alt, className, onPreview }: {
  label: string;
  src: string | undefined;
  alt: string;
  className: string;
  onPreview: (p: PreviewState) => void;
}) {
  return (
    <div className={`ws-cmp-side ${className}`}>
      <div className="ws-cmp-side-h">{label}</div>
      {src ? (
        <button className="ws-pri-tile" onClick={() => onPreview({ rel: src.replace(/^assets\//, ''), kind: 'image', name: alt })}>
          <img src={assetUrl(src)} alt={alt} loading="lazy" />
        </button>
      ) : (
        <div className="ws-pri-tile ws-cmp-empty">(no image)</div>
      )}
    </div>
  );
}

export function Workspace() {
  // Subscribe to assetVersions so cache-bust ?v=N actually lands in
  // rendered URLs. Without this, App.tsx bumps the per-path version
  // on `asset-added` but the Workspace render never re-evaluates
  // assetUrl(), so the browser keeps showing the cached image after
  // a regen-to-same-path. Subscribing to the whole map is the
  // cheapest fix — re-renders are bounded by gen frequency, not
  // user interaction.
  useStore((s) => s.assetVersions);
  const [state, setState] = useState<api.WorkspaceState | null | undefined>(undefined);   // undefined = loading
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Snapshot navigation. `snapshots` is the list of historical timestamps
  // (newest first). `viewingStamp` tracks the active archived iteration by
  // its STAMP (not by list index) so when the agent writes a new snapshot
  // and prepends it to the list, the user stays anchored on the iteration
  // they're actually looking at instead of getting silently shifted to a
  // different one. null = viewing the live state.
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [viewingStamp, setViewingStamp] = useState<string | null>(null);
  const [snapshotState, setSnapshotState] = useState<api.WorkspaceState | null>(null);
  // Pulse the card briefly whenever workspace.json changes — visual signal
  // that the agent just touched this surface. Class is removed after 1800ms.
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef<number | null>(null);

  // Live-bind: map of pika gen id → current LiveGen state. Tiles with a
  // `taskId` field look themselves up in here and resolve in real time
  // (running spinner → done with src override → red failed state). On
  // mount we hydrate from /agent/pika-gens; SSE keeps it fresh after.
  const [genMap, setGenMap] = useState<Map<string, api.LiveGen>>(new Map());
  // 60s tick for orphan-detection (re-evaluates "has this tile been
  // pending too long" without depending on incoming SSE events).
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    // Hydrate + then keep periodically re-hydrating from the server's
    // live-gens snapshot. Don't rely on SSE alone — events can be missed
    // on tab focus changes, network blips, or initial load races, and
    // a missed start event makes the tile look orphaned even when the
    // gen is alive on the server. Re-poll every 5s costs nothing
    // (one tiny GET) and keeps STUCK detection honest.
    async function refreshGens(): Promise<void> {
      try {
        const gens = await api.getActivePikaGens();
        setGenMap((m) => {
          const next = new Map(m);
          for (const g of gens) next.set(g.id, g);
          return next;
        });
      } catch { /* offline */ }
    }
    void refreshGens();
    const off = subscribeServerEvents((ev) => {
      if (ev.type !== 'pika-live-gen' || !ev.gen) return;
      const gen = ev.gen as api.LiveGen;
      setGenMap((m) => {
        const next = new Map(m);
        next.set(gen.id, gen);
        return next;
      });
    });
    const pollId = window.setInterval(refreshGens, 5_000);
    const tickId = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => { off(); window.clearInterval(pollId); window.clearInterval(tickId); };
  }, []);

  // Workspace is now ONLY the agent's "what's next" card. The full brief
  // lives in the Plan tab (durable production bible); the complete asset
  // index lives in History. No more redundant drawers underneath.
  //
  // Reload strategy is split so the snapshot cursor doesn't lose its place
  // every time anything in the project changes:
  //   - workspace.json changed → full reload + cursor reset (new iteration
  //     just landed; the user wants to see it)
  //   - project changed       → full reload + reset (different project)
  //   - anything else          → silently refresh state + snapshot list,
  //     but keep the user's cursor where it is
  async function reloadAll(resetCursor: boolean) {
    const [s, h] = await Promise.all([api.getWorkspaceState(), api.getWorkspaceHistory()]);
    setState(s);
    setSnapshots(h.snapshots);
    if (resetCursor) {
      setViewingStamp(null);
      setSnapshotState(null);
    }
  }
  useEffect(() => { void reloadAll(true); }, []);
  useEffect(() => {
    return subscribeServerEvents((ev) => {
      if (ev.type === 'project-changed') {
        void reloadAll(true);
        return;
      }
      if (ev.type === 'asset-added' && ev.relPath === 'workspace.json') {
        // Fresh workspace iteration — pull state + snapshots, snap back to
        // the live view so the user sees what the agent just wrote.
        void reloadAll(true);
        setPulse(true);
        if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
        pulseTimer.current = window.setTimeout(() => setPulse(false), 1800);
        return;
      }
      // Anything else (timeline edits, non-workspace asset-added) doesn't
      // affect the workspace card — silently keep state in sync without
      // disturbing whatever snapshot the user is currently viewing.
      if (ev.type === 'asset-added' || ev.type === 'timeline-changed') {
        void reloadAll(false);
      }
    });
  }, []);

  // Index of the currently-viewed stamp inside the (newest-first) snapshots
  // list. -1 means we're on the live state.
  const cursor = viewingStamp ? snapshots.indexOf(viewingStamp) : -1;

  // Step backwards (older = +1) / forwards (newer = -1) through snapshots.
  // viewingStamp=null means "live"; stamp[0] is the most recent archived
  // iteration. We map by stamp so a new write doesn't shift the user off
  // the snapshot they were inspecting.
  // Snapshot arrows sit at the TRUE viewport vertical center via
  // `position: fixed` + `top: 50%` in CSS — pure CSS, no measurement
  // timing bug. JS only computes the HORIZONTAL anchor (left/right of
  // the workspace column) and applies it as inline px values, so the
  // arrows hug the column edges even as the chat panel or library rail
  // resize.
  //
  // CRITICAL: Workspace renders a "Loading workspace…" placeholder
  // while `state === undefined` — that placeholder's element is NOT
  // the workspace div the ref attaches to. If we used `useRef` +
  // `[]`-dep effect, the effect would run ONCE on mount, see
  // `ref.current === null` (placeholder rendered, real div not yet),
  // and never measure again until a window resize fired. That's the
  // "arrows missing until I resize" bug. The fix is a ref-callback
  // state: `workspaceEl` updates whenever React attaches/detaches the
  // node, and the effect re-runs each time, so the moment the real
  // workspace div mounts we measure it.
  const [workspaceEl, setWorkspaceEl] = useState<HTMLDivElement | null>(null);
  const [arrowX, setArrowX] = useState<{ left: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!workspaceEl) return;
    function update(): void {
      const rect = workspaceEl!.getBoundingClientRect();
      setArrowX({ left: rect.left + 16, right: window.innerWidth - rect.right + 16 });
    }
    update();
    window.addEventListener('resize', update);
    const ro = new ResizeObserver(update);
    ro.observe(workspaceEl);
    return () => {
      window.removeEventListener('resize', update);
      ro.disconnect();
    };
  }, [workspaceEl]);

  async function stepSnapshot(delta: number): Promise<void> {
    const nextCursor = cursor + delta;
    if (nextCursor <= -1) { setViewingStamp(null); setSnapshotState(null); return; }
    if (nextCursor >= snapshots.length) return;
    const stamp = snapshots[nextCursor];
    const snap = await api.getWorkspaceSnapshot(stamp);
    if (snap) { setViewingStamp(stamp); setSnapshotState(snap); }
  }

  // The card always renders either the live state or the active snapshot.
  const viewing = viewingStamp === null ? state : snapshotState;
  const viewingLabel = viewingStamp === null
    ? null
    : viewingStamp.replace(/-/g, ':').replace(/T/, ' ').slice(0, 19);

  if (state === undefined) {
    return <div className="workspace"><div className="ws-loading">Loading workspace…</div></div>;
  }

  return (
    <div className="workspace" ref={setWorkspaceEl}>
      {/* Snapshot stepper. Vertical anchor is pure CSS (position: fixed;
          top: 50%) so the arrows snap to viewport-center on first paint —
          no measurement timing bug. JS computes horizontal `left`/`right`
          from the workspace column's bounding rect (the column doesn't
          span the full viewport — chat panel + library rail flank it).
          Arrows are only rendered once `arrowX` is measured. */}
      {snapshots.length > 0 && arrowX && (
        <>
          <button
            className="ws-step-arrow ws-step-arrow-prev"
            style={{ left: arrowX.left }}
            onClick={() => stepSnapshot(+1)}
            disabled={cursor >= snapshots.length - 1}
            data-tip-below=""
            data-tip="Older iteration"
            aria-label="Previous iteration"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="15 6 9 12 15 18" />
            </svg>
          </button>
          <button
            className="ws-step-arrow ws-step-arrow-next"
            style={{ right: arrowX.right }}
            onClick={() => stepSnapshot(-1)}
            disabled={cursor === -1}
            data-tip-below=""
            data-tip="Newer iteration"
            aria-label="Next iteration"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
          <div className="ws-step-pos">
            {cursor === -1 ? 'current' : `${cursor + 1} of ${snapshots.length}`}
          </div>
        </>
      )}

      <div className="workspace-scroll">
        {viewing ? (
          <div className={`ws-card ${pulse && cursor === -1 ? 'ws-card-pulse' : ''} ${cursor !== -1 ? 'ws-card-snapshot' : ''}`}>
            {cursor !== -1 && (
              <div className="ws-snap-banner">
                Viewing snapshot from {viewingLabel} ·
                <button onClick={() => { setViewingStamp(null); setSnapshotState(null); }}>back to current</button>
              </div>
            )}
            {viewing.phase && <div className="ws-phase">{viewing.phase}</div>}
            {viewing.headline && <h1 className="ws-headline">{viewing.headline}</h1>}
            {viewing.subhead && <p className="ws-subhead">{viewing.subhead}</p>}
            {viewing.body && <div className="ws-body md-body">{renderMarkdown(viewing.body)}</div>}
            {viewing.primary && Array.isArray(viewing.primary.items) && viewing.primary.items.length > 0 && (
              <>
                <ClearStuckBanner
                  items={viewing.primary.items as api.WorkspaceItem[]}
                  genMap={genMap}
                  workspaceGeneratedAt={viewing.generatedAt ? new Date(viewing.generatedAt).getTime() : null}
                  nowTick={nowTick}
                  isSnapshot={cursor !== -1}
                />
                <PrimaryBlock
                  primary={viewing.primary}
                  onPreview={setPreview}
                  genMap={genMap}
                  workspaceGeneratedAt={viewing.generatedAt ? new Date(viewing.generatedAt).getTime() : null}
                  nowTick={nowTick}
                  isSnapshot={cursor !== -1}
                  phase={viewing.phase}
                />
              </>
            )}
            {viewing.ask && <AskBlock ask={viewing.ask} />}
            {viewing.activity && viewing.activity.length > 0 && (
              <div className="ws-activity">
                <div className="ws-activity-h">Recent work</div>
                <ul>{viewing.activity.map((line, i) => <li key={i}>{line}</li>)}</ul>
              </div>
            )}
          </div>
        ) : (
          <div className="ws-card ws-card-empty">
            <div className="ws-phase">No briefing yet</div>
            <h1 className="ws-headline">The agent will write here</h1>
            <p className="ws-subhead">
              Workspace shows what's next. The agent writes <code>workspace.json</code> after each phase
              — a question, a decision, a visual review — so you always know the current step
              without scanning every asset.
            </p>
          </div>
        )}

      </div>

      {preview && <Lightbox preview={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
