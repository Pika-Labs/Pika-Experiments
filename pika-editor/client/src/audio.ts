/**
 * Web Audio engine for the unified-audio timeline. Single AudioContext for
 * the whole app; preloads buffers; schedules per-clip playback through a
 * per-track gain graph:
 *
 *   source ─► clipGain ─► trackGain[id] ─► masterGain ─► destination
 *
 * Track gains are created/torn down dynamically as the timeline's
 * `audioTracks` array grows or shrinks. The mixer slider for a track
 * adjusts the corresponding GainNode live without rescheduling.
 */
import type { Timeline, AudioClip } from './types';

interface ScheduledNode { source: AudioBufferSourceNode; gain: GainNode }

class AudioEngine {
  ctx: AudioContext | null = null;
  buffers = new Map<string, AudioBuffer>();
  masterGain: GainNode | null = null;
  /** Gain nodes keyed by AudioTrack.id. Created on demand. */
  trackGains = new Map<string, GainNode>();
  scheduled: ScheduledNode[] = [];
  private startedCtxTime = 0;
  private startedPlayhead = 0;

  ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1;
      this.masterGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Get-or-create a GainNode for the given track. The node is wired into
   *  the master mixer immediately so it survives across play() calls. */
  trackGain(trackId: string): GainNode {
    const ctx = this.ensureCtx();
    let g = this.trackGains.get(trackId);
    if (!g) {
      g = ctx.createGain();
      g.gain.value = 1;
      g.connect(this.masterGain!);
      this.trackGains.set(trackId, g);
    }
    return g;
  }

  /** Set a track's gain in dB. Lerps over 10ms so live slider updates
   *  don't click. Safe to call before play() — value persists. */
  setTrackGainDb(trackId: string, db: number): void {
    const ctx = this.ctx;
    const g = this.trackGain(trackId);
    if (!ctx) return;
    g.gain.setTargetAtTime(Math.pow(10, db / 20), ctx.currentTime, 0.01);
  }

  async load(rel: string): Promise<AudioBuffer> {
    if (this.buffers.has(rel)) return this.buffers.get(rel)!;
    const ctx = this.ensureCtx();
    const url = '/asset/' + rel.replace(/^assets\//, '');
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr);
    this.buffers.set(rel, buf);
    return buf;
  }

  /** Pre-fetch + pre-decode every audio source in the timeline so the
   *  first call to play() doesn't pay the load/decode cost. Safe to call
   *  repeatedly — `load()` is idempotent. */
  warmup(timeline: Timeline): void {
    if (!timeline) return;
    this.ensureCtx();
    const srcs = new Set<string>();
    for (const tr of timeline.audioTracks ?? []) {
      for (const c of tr.clips) {
        if (c.src) srcs.add(c.src);
      }
    }
    for (const s of srcs) {
      if (!this.buffers.has(s)) {
        void this.load(s).catch(() => { /* missing/pending — fine */ });
      }
    }
  }

  stop(): void {
    for (const s of this.scheduled) {
      try { s.source.stop(); } catch { /* already stopped */ }
      s.source.disconnect();
      s.gain.disconnect();
    }
    this.scheduled = [];
  }

  async play(timeline: Timeline, fromPlayhead: number): Promise<void> {
    if (!timeline) return;
    this.stop();
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    // Sync track gains from timeline state before scheduling.
    for (const tr of timeline.audioTracks ?? []) this.setTrackGainDb(tr.id, tr.gain ?? 0);

    // Load all buffers before anchoring startedCtxTime, otherwise the
    // load delay would land scheduled events in the past = audio lag.
    // CRITICAL: each load is wrapped in its own catch — one corrupt or
    // missing file (e.g. a 78-byte ffmpeg-failed sfx_*.wav) must NOT
    // reject the whole Promise.all and block playback for every other
    // clip. The schedule loop below just skips clips whose buffer
    // didn't load.
    const srcs = new Set<string>();
    for (const tr of timeline.audioTracks ?? []) {
      for (const c of tr.clips) if (c.src) srcs.add(c.src);
    }
    await Promise.all(Array.from(srcs).map((s) =>
      this.load(s).catch((err) => {
        console.warn(`[audio] skipping ${s} — ${err?.message ?? err}`);
      })
    ));

    this.startedCtxTime = ctx.currentTime;
    this.startedPlayhead = fromPlayhead;

    for (const tr of timeline.audioTracks ?? []) {
      const out = this.trackGain(tr.id);
      for (const c of tr.clips) {
        if (!c.src) continue;
        const buf = this.buffers.get(c.src);
        if (!buf) continue;
        this.scheduleClip(ctx, buf, c, fromPlayhead, out);
      }
    }
  }

  private async scheduleClip(ctx: AudioContext, buf: AudioBuffer, clip: AudioClip, fromPlayhead: number, trackOut: AudioNode): Promise<void> {
    const dur = clip.out - clip.in;
    const masterStart = clip.start;
    const masterEnd = clip.start + dur;
    if (masterEnd <= fromPlayhead) return;

    const offsetIntoClip = Math.max(0, fromPlayhead - masterStart);
    const sourceStart = clip.in + offsetIntoClip;
    const sourceDuration = dur - offsetIntoClip;
    const ctxStartAt = this.startedCtxTime + Math.max(0, masterStart - fromPlayhead);

    const source = ctx.createBufferSource();
    source.buffer = buf;
    const gain = ctx.createGain();
    const baseGainDb = clip.gain ?? 0;
    const linear = Math.pow(10, baseGainDb / 20);
    gain.gain.setValueAtTime(clip.fadeIn > 0 ? 0 : linear, ctxStartAt);
    if (clip.fadeIn > 0)  gain.gain.linearRampToValueAtTime(linear, ctxStartAt + clip.fadeIn);
    if (clip.fadeOut > 0) {
      const fadeOutAt = ctxStartAt + sourceDuration - clip.fadeOut;
      gain.gain.setValueAtTime(linear, fadeOutAt);
      gain.gain.linearRampToValueAtTime(0, ctxStartAt + sourceDuration);
    }
    source.connect(gain).connect(trackOut);
    source.start(ctxStartAt, sourceStart, sourceDuration);
    this.scheduled.push({ source, gain });
  }
}

export const audio = new AudioEngine();
