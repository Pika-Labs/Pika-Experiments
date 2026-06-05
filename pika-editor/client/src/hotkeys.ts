import { useEffect } from 'react';
import { useStore } from './store';
import type { Timeline } from './types';
import { effectiveDuration } from './edit';

/**
 * Sorted, deduped list of every clip edge on VIDEO lanes only (V1/V2 —
 * `kind === 'video' | 'overlay'`). Used for ↑/↓ cut-navigation. Audio
 * clips (music, VO, SFX) are intentionally excluded so cut-jumping
 * follows the EDITORIAL beats, not the underlying audio waveform —
 * matches what Premiere/Resolve users expect from ↑/↓. Exported so
 * the Preview transport buttons share the same edge logic.
 */
export function collectVideoEdges(t: Timeline): number[] {
  const set = new Set<number>([0, effectiveDuration(t)]);
  const add = (v: number) => { if (v >= 0) set.add(Math.round(v * 1000) / 1000); };
  for (const tr of t.tracks) for (const c of tr.clips) {
    add(c.start);
    add(c.start + (c.out - c.in));
  }
  return [...set].sort((a, b) => a - b);
}

// Global keydown handler. Mounted once at the App root. We deliberately do
// NOT intercept keys while typing into an input/textarea — that would break
// prompt editing in the inspector.
export function useGlobalHotkeys(): void {
  useEffect(() => {
    function isEditable(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (isEditable(e.target)) return;
      const cmd = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      const s = useStore.getState();

      // Tool switches — Premiere convention:
      //   V = Selection (Move/Trim)
      //   C = Razor (blade — splits clips at click point)
      //   B = Ripple Edit
      //   Y = Slip
      //   N = Comment / annotation (Premiere has no exact equivalent; we
      //       put it here to avoid stomping the canonical V/C/B/Y)
      //   S = Snap toggle
      if (!cmd && !shift) {
        if (e.key === 'v' || e.key === 'V') { s.setTool('select'); e.preventDefault(); return; }
        if (e.key === 'c' || e.key === 'C') { s.setTool('blade'); e.preventDefault(); return; }
        if (e.key === 'b' || e.key === 'B') { s.setTool('ripple'); e.preventDefault(); return; }
        if (e.key === 'y' || e.key === 'Y') { s.setTool('slip'); e.preventDefault(); return; }
        if (e.key === 'n' || e.key === 'N') { s.setTool('comment'); e.preventDefault(); return; }
        if (e.key === 's' || e.key === 'S') { s.toggleSnap(); e.preventDefault(); return; }
      }

      // Transport
      if (e.key === ' ') { s.togglePlay(); e.preventDefault(); return; }
      if (!cmd && e.key === 'j') { s.setPlayhead(Math.max(0, s.playhead - 1)); e.preventDefault(); return; }
      if (!cmd && e.key === 'k') { if (s.playing) s.togglePlay(); e.preventDefault(); return; }
      if (!cmd && e.key === 'l') { s.setPlayhead(s.playhead + 1); e.preventDefault(); return; }

      // Frame nudge — Premiere convention:
      //   ←/→        : ±1 frame
      //   Shift+←/→  : ±10 frames
      if (!cmd && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const fps = s.timeline?.fps ?? 24;
        const step = (1 / fps) * (shift ? 10 : 1);
        s.setPlayhead(s.playhead + (e.key === 'ArrowRight' ? step : -step));
        e.preventDefault(); return;
      }

      // Cut navigation — jump the playhead to the nearest VIDEO clip
      // edge (V1/V2) in the direction pressed. Audio lanes are skipped
      // so ↑/↓ follows the editorial cuts, not the waveform.
      // Premiere binds this to ↑/↓.
      if (!cmd && !shift && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const t = s.timeline;
        if (!t) return;
        const edges = collectVideoEdges(t);
        const ph = s.playhead;
        const EPS = 0.001;
        if (e.key === 'ArrowUp') {
          // Previous cut
          const prev = [...edges].reverse().find((x) => x < ph - EPS);
          if (prev !== undefined) s.setPlayhead(prev);
        } else {
          // Next cut
          const nxt = edges.find((x) => x > ph + EPS);
          if (nxt !== undefined) s.setPlayhead(nxt);
        }
        e.preventDefault(); return;
      }

      // Home / End — jump to timeline start / end.
      if (!cmd && e.key === 'Home') {
        s.setPlayhead(0);
        e.preventDefault(); return;
      }
      if (!cmd && e.key === 'End') {
        s.setPlayhead(s.timeline ? effectiveDuration(s.timeline) : 0);
        e.preventDefault(); return;
      }

      // Undo / redo
      if (cmd && !shift && (e.key === 'z' || e.key === 'Z')) { s.undo(); e.preventDefault(); return; }
      if (cmd && shift && (e.key === 'z' || e.key === 'Z')) { s.redo(); e.preventDefault(); return; }
      if (cmd && (e.key === 'y' || e.key === 'Y')) { s.redo(); e.preventDefault(); return; }

      // Copy / paste
      if (cmd && (e.key === 'c' || e.key === 'C')) {
        if (s.selectedClipIds.length === 0) return;
        s.copyClips();
        e.preventDefault();
        return;
      }
      if (cmd && (e.key === 'v' || e.key === 'V')) {
        if (s.clipboard.length === 0) return;
        s.pasteClips();
        e.preventDefault();
        return;
      }
      if (cmd && (e.key === 'd' || e.key === 'D')) {
        // Duplicate in-place = copy + paste at current playhead.
        if (s.selectedClipIds.length === 0) return;
        s.copyClips();
        s.pasteClips();
        e.preventDefault();
        return;
      }

      // Zoom: 0 fits, − / = / + zoom in/out. Work without modifier so the
      // user can hit them straight from the timeline. ⌘+modifier variants
      // still work too (caught by the same key check since cmd is just a
      // flag — the e.key string is the same).
      if (e.key === '=' || e.key === '+') { (window as any).__paeZoomIn?.(); e.preventDefault(); return; }
      if (e.key === '-') { (window as any).__paeZoomOut?.(); e.preventDefault(); return; }
      if (e.key === '0') { (window as any).__paeZoomFit?.(); e.preventDefault(); return; }

      // Delete / ripple-delete — works on V1/V2 clips, music clips, SFX
      // clips, and caption rows. Each store action is a no-op if the id
      // doesn't match its domain, so dispatching to all is safe and lets
      // the user delete mixed selections in one keystroke.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // Caption row selected? Delete it. Captions and clips use separate
        // selection state (selectedCaptionId vs selectedClipIds) so they
        // can't both be active — handle captions first because they're
        // the more recent selection when set.
        if (s.selectedCaptionId) {
          s.deleteCaptionRow(s.selectedCaptionId);
          e.preventDefault();
          return;
        }
        const ids = s.selectedClipIds;
        if (ids.length === 0) return;
        const tl = s.timeline;
        for (const id of ids) {
          const isVideoClip = tl?.tracks.some((tr) => tr.clips.some((c) => c.id === id));
          const isAudioClip = tl?.audioTracks.some((tr) => tr.clips.some((c) => c.id === id));
          const isCaptionRow = tl?.captions.rows.some((r) => r.id === id);
          if (isVideoClip) {
            if (shift) s.rippleDelete(id); else s.deleteClip(id);
          } else if (isAudioClip) {
            s.deleteAudioClip(id);
          } else if (isCaptionRow) {
            s.deleteCaptionRow(id);
          }
        }
        e.preventDefault();
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
