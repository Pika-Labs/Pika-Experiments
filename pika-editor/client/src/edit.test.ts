/**
 * Unit tests for the pure timeline math in edit.ts. These are the most
 * load-bearing functions in the whole client — any subtle bug here corrupts
 * the user's timeline state. We test the contract, not the implementation:
 * shape of the returned timeline and the precise rule each op encodes.
 */
import { describe, it, expect } from 'vitest';
import * as edit from './edit';
import type { Timeline, Clip } from './types';

function makeClip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1', trackId: 'v1', sceneId: 's1',
    start: 5, in: 0, out: 4, rate: 1, fadeIn: 0, fadeOut: 0,
    smoothFps: false, linkId: null, comments: [], ...over,
  };
}

function makeTimeline(clips: Clip[] = []): Timeline {
  return {
    version: 2, name: 'test', aspect: '16:9', resolution: '1080p', fps: 24,
    duration: 30, bpm: null, downbeats: [], beats: [],
    music: null, sfx: { gain: 0, clips: [] },
    audioTracks: [],
    tracks: [
      { id: 'v1', kind: 'video', clips, label: null },
      { id: 'v2', kind: 'overlay', clips: [], label: null },
    ],
    captions: {
      enabled: false,
      defaultStyle: {
        font: 'Telka', size: 48, weight: 800, color: '#ffffff',
        bgEnabled: true, bg: '#000000', xPct: 50, yPct: 85,
        padX: 16, padY: 8, radius: 8, textCase: 'none', align: 'center',
        outline: { enabled: false, color: '#000000', width: 0 },
        shadow: { enabled: false, color: '#000000', blur: 0, dx: 0, dy: 0 },
      },
      rows: [],
    },
    scenes: [{ id: 's1', kind: 'pika-gen', prompt: '', model: 'kling', refs: [], status: 'ready', videoSrc: 'x.mp4', errorMessage: null, naturalDuration: 10, sourceFps: 24, costCredits: null }],
    floatingComments: [],
    render: { preset: 'standard', lastJobs: [] },
  };
}

describe('snap', () => {
  it('snaps within tolerance', () => {
    expect(edit.snap(5.02, [5], 0.05)).toBe(5);
  });
  it('does not snap outside tolerance', () => {
    expect(edit.snap(5.1, [5], 0.025)).toBe(5.1);
  });
  it('returns input rounded when beats array is empty', () => {
    expect(edit.snap(5.123456, [], 0.05)).toBe(5.123);
  });
});

describe('moveClip', () => {
  it('moves to absolute start', () => {
    const tl = makeTimeline([makeClip()]);
    const next = edit.moveClip(tl, 'c1', 10, [], false);
    expect(next.tracks[0].clips[0].start).toBe(10);
  });
  it('clamps to >= 0', () => {
    const tl = makeTimeline([makeClip({ start: 2 })]);
    const next = edit.moveClip(tl, 'c1', -5, [], false);
    expect(next.tracks[0].clips[0].start).toBe(0);
  });
  it('snaps to beat when enabled', () => {
    const tl = makeTimeline([makeClip()]);
    const next = edit.moveClip(tl, 'c1', 10.01, [10], true);
    expect(next.tracks[0].clips[0].start).toBe(10);
  });
  it('blocks at next clip start (no overlap)', () => {
    const tl = makeTimeline([
      makeClip({ id: 'a', start: 0, out: 3 }),                     // 0..3
      makeClip({ id: 'b', start: 10, out: 3 }),                    // 10..13
    ]);
    // Drag 'a' toward 'b' — should clamp at b.start - a.dur = 10 - 3 = 7
    const next = edit.moveClip(tl, 'a', 100, [], false);
    expect(next.tracks[0].clips[0].start).toBe(7);
  });
});

describe('trimRight', () => {
  it('extends within source duration', () => {
    const tl = makeTimeline([makeClip({ out: 4 })]);          // source naturalDuration is 10
    const next = edit.trimRight(tl, 'c1', 2, [], false);
    expect(next.tracks[0].clips[0].out).toBe(6);
  });
  it('clamps at source duration', () => {
    const tl = makeTimeline([makeClip({ out: 4 })]);          // src dur = 10, in = 0
    const next = edit.trimRight(tl, 'c1', 20, [], false);     // try to extend by 20s
    // Max end = clip.start + (sourceDur - clip.in) / rate = 5 + 10 = 15
    // So newOut = clip.in + (15 - 5) = 10
    expect(next.tracks[0].clips[0].out).toBe(10);
  });
  it('does not go below 0.05s of master duration', () => {
    const tl = makeTimeline([makeClip({ out: 4 })]);
    const next = edit.trimRight(tl, 'c1', -10, [], false);
    const c = next.tracks[0].clips[0];
    expect(c.out - c.in).toBeGreaterThanOrEqual(0.04);  // allow small rounding
  });
});

describe('trimLeft', () => {
  it('moves start + in together', () => {
    const tl = makeTimeline([makeClip({ start: 5, in: 2, out: 6 })]);
    const next = edit.trimLeft(tl, 'c1', 1, [], false);
    const c = next.tracks[0].clips[0];
    expect(c.start).toBe(6);
    expect(c.in).toBe(3);
  });
  it("doesn't expose negative source time", () => {
    const tl = makeTimeline([makeClip({ start: 5, in: 0, out: 4 })]);
    // Try to trim left by -10s; should clamp because in can't go below 0.
    const next = edit.trimLeft(tl, 'c1', -10, [], false);
    const c = next.tracks[0].clips[0];
    expect(c.in).toBeGreaterThanOrEqual(0);
    expect(c.start).toBeGreaterThanOrEqual(0);
  });
});

describe('splitClip', () => {
  it('splits at the requested master time', () => {
    const tl = makeTimeline([makeClip({ start: 5, in: 0, out: 6 })]);   // 5..11 master
    const next = edit.splitClip(tl, 'c1', 8);
    expect(next.tracks[0].clips).toHaveLength(2);
    const [left, right] = next.tracks[0].clips;
    expect(left.out).toBe(3);                                            // local 0..3
    expect(right.start).toBe(8);
    expect(right.in).toBe(3);
  });
  it('returns the timeline unchanged if atTime is outside the clip', () => {
    const tl = makeTimeline([makeClip()]);
    const next = edit.splitClip(tl, 'c1', 100);
    expect(next).toBe(tl);
  });
});

describe('slipClip', () => {
  it('preserves master timing', () => {
    const tl = makeTimeline([makeClip({ start: 5, in: 1, out: 5 })]);   // 4s master
    const next = edit.slipClip(tl, 'c1', 1);
    const c = next.tracks[0].clips[0];
    expect(c.start).toBe(5);
    expect(c.out - c.in).toBe(4);   // window length preserved
  });
});

describe('rippleDelete', () => {
  it('removes the clip and shifts downstream', () => {
    // Clip master duration = (out - in) / rate, so to make a 2s clip we set
    // in=0 out=2 (or in=3 out=5). Three clips: a=3s, b=2s, c=3s, butted up.
    const tl = makeTimeline([
      makeClip({ id: 'a', start: 0, in: 0, out: 3 }),  // 0..3 master
      makeClip({ id: 'b', start: 3, in: 0, out: 2 }),  // 3..5 master
      makeClip({ id: 'c', start: 5, in: 0, out: 3 }),  // 5..8 master
    ]);
    const next = edit.rippleDelete(tl, 'b');
    expect(next.tracks[0].clips.map((c) => c.id)).toEqual(['a', 'c']);
    expect(next.tracks[0].clips[1].start).toBe(3);    // c shifted left by b's master dur (2s)
  });
});
