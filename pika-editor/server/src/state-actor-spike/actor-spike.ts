/**
 * Actor-pattern spike. Verifies that:
 *   1. N concurrent mutate() calls all land (none lost)
 *   2. Mutations are serialized — each one sees its predecessor's writes
 *   3. A thrown error in one mutate() doesn't poison the queue for the next
 *   4. Long-running work *outside* mutate() doesn't block the actor
 *   5. The race the captions/scene-patch bugs hit today is genuinely impossible
 *
 * Runs against a tempfile, not the real timeline.json. No side effects.
 */
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class FileActor<T> {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly filePath: string,
    private readonly parse: (raw: string) => T,
    private readonly serialize: (doc: T) => string,
    private readonly initial: () => T,
  ) {}

  /**
   * Run `fn` exclusively. Holds the lock during `fn`'s execution only —
   * `fn` is responsible for being fast (compute deltas synchronously,
   * don't fetch/ffmpeg inside).
   */
  async mutate<R>(fn: (cur: T) => { next: T; result: R }): Promise<R> {
    let resolve!: (v: R) => void;
    let reject!: (e: unknown) => void;
    const out = new Promise<R>((res, rej) => { resolve = res; reject = rej; });
    this.queue = this.queue.then(async () => {
      try {
        const raw = existsSync(this.filePath) ? readFileSync(this.filePath, 'utf8') : '';
        const cur = raw ? this.parse(raw) : this.initial();
        const { next, result } = fn(cur);
        const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2,6)}`;
        writeFileSync(tmp, this.serialize(next));
        // Atomic rename
        const fs = await import('node:fs/promises');
        await fs.rename(tmp, this.filePath);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }).catch(() => {/* don't propagate inside the queue chain */});
    return out;
  }
}

interface TestDoc {
  scenes: Array<{ id: string; status: string; videoSrc: string | null }>;
  captions: { rows: Array<{ id: string; text: string }> };
}

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pae-actor-spike-'));
  const filePath = path.join(tmpDir, 'state.json');
  console.log(`spike dir: ${tmpDir}`);

  const actor = new FileActor<TestDoc>(
    filePath,
    (raw) => JSON.parse(raw) as TestDoc,
    (doc) => JSON.stringify(doc, null, 2) + '\n',
    () => ({
      scenes: ['sc_47','sc_48','sc_49','sc_50'].map(id => ({ id, status: 'pending', videoSrc: null })),
      captions: { rows: [] },
    }),
  );

  // ============================================================
  // Test 1: 4 parallel scene patches — exactly the bug we hit today
  // Each "background task" simulates fetch+download (slow) OUTSIDE
  // the lock, then commits ONE delta INSIDE the lock.
  // Expected: all 4 land, no losses.
  // ============================================================
  console.log('\n=== Test 1: 4 parallel scene patches (the real bug) ===');
  const sceneIds = ['sc_47','sc_48','sc_49','sc_50'];
  const fakeDownload = async (sceneId: string): Promise<string> => {
    // Simulate the long-running fetch + write to disk OUTSIDE the lock.
    // Different durations to maximize interleaving.
    const delay = 20 + Math.random() * 80;
    await new Promise(r => setTimeout(r, delay));
    return `assets/pika/${sceneId}.mp4`;
  };

  await Promise.all(sceneIds.map(async (sceneId) => {
    const relPath = await fakeDownload(sceneId);  // <-- slow work OUTSIDE actor
    return actor.mutate((cur) => {                 // <-- fast commit INSIDE actor
      const idx = cur.scenes.findIndex(s => s.id === sceneId);
      if (idx < 0) throw new Error(`scene not found: ${sceneId}`);
      const next: TestDoc = {
        ...cur,
        scenes: cur.scenes.map((s, i) => i === idx
          ? { ...s, status: 'ready', videoSrc: relPath }
          : s),
      };
      return { next, result: relPath };
    });
  }));

  const after = JSON.parse(readFileSync(filePath, 'utf8')) as TestDoc;
  const allReady = after.scenes.every(s => s.status === 'ready' && s.videoSrc !== null);
  console.log(`scenes after: ${JSON.stringify(after.scenes, null, 2)}`);
  if (!allReady) { console.error('❌ Test 1 FAILED — some scenes lost their videoSrc'); process.exit(1); }
  console.log('✓ Test 1 passed: all 4 scenes ready with videoSrc, zero losses');

  // ============================================================
  // Test 2: ordering — each mutate sees its predecessor's writes
  // ============================================================
  console.log('\n=== Test 2: ordering / each mutate sees predecessor ===');
  await actor.mutate(c => ({ next: { ...c, captions: { rows: [] } }, result: null }));  // reset
  const promises: Promise<number>[] = [];
  for (let i = 0; i < 50; i++) {
    promises.push(actor.mutate((cur) => {
      const rows = [...cur.captions.rows, { id: `r_${i}`, text: `row ${i}` }];
      return { next: { ...cur, captions: { rows } }, result: rows.length };
    }));
  }
  const counts = await Promise.all(promises);
  // Each mutate should have seen 1 more row than the last. If serialized,
  // counts === [1, 2, 3, ..., 50] in order.
  const expected = Array.from({ length: 50 }, (_, i) => i + 1);
  const matches = counts.every((c, i) => c === expected[i]);
  const final = JSON.parse(readFileSync(filePath, 'utf8')) as TestDoc;
  console.log(`final row count: ${final.captions.rows.length} (expected 50)`);
  console.log(`mutate return values: [${counts.slice(0,5).join(',')}, ..., ${counts.slice(-5).join(',')}]`);
  if (!matches || final.captions.rows.length !== 50) {
    console.error('❌ Test 2 FAILED — ordering or row count broken');
    process.exit(1);
  }
  console.log('✓ Test 2 passed: 50 serialized mutates, all 50 rows, in order');

  // ============================================================
  // Test 3: thrown error in one mutate must NOT poison the queue
  // ============================================================
  console.log('\n=== Test 3: error in one mutate does not poison queue ===');
  const errPromise = actor.mutate(() => { throw new Error('intentional'); });
  const okPromise = actor.mutate((cur) => {
    return { next: { ...cur, captions: { rows: [...cur.captions.rows, { id: 'after_err', text: 'survived' }] } }, result: 'ok' };
  });

  let errCaught = false;
  try { await errPromise; } catch (e: any) {
    if (e?.message === 'intentional') errCaught = true;
  }
  const okResult = await okPromise;
  const after3 = JSON.parse(readFileSync(filePath, 'utf8')) as TestDoc;
  const survived = after3.captions.rows.some(r => r.id === 'after_err');
  if (!errCaught || okResult !== 'ok' || !survived) {
    console.error(`❌ Test 3 FAILED — errCaught=${errCaught} okResult=${okResult} survived=${survived}`);
    process.exit(1);
  }
  console.log('✓ Test 3 passed: error rejected its own promise, next mutate ran fine');

  // ============================================================
  // Test 4: lock-hold time. Slow work OUTSIDE mutate must not block
  // other mutates. We fire a fast burst alongside a slow-outside-the-lock task.
  // ============================================================
  console.log('\n=== Test 4: slow work outside actor does NOT block fast mutates ===');
  await actor.mutate(c => ({ next: { ...c, captions: { rows: [] } }, result: null }));
  const start = Date.now();
  const slow = (async () => {
    // 500ms of "work" OUTSIDE the actor
    await new Promise(r => setTimeout(r, 500));
    // Then a small commit
    return actor.mutate((cur) => ({
      next: { ...cur, captions: { rows: [...cur.captions.rows, { id: 'slow', text: 'slow' }] } },
      result: Date.now() - start,
    }));
  })();
  const fastPromises: Promise<number>[] = [];
  for (let i = 0; i < 10; i++) {
    fastPromises.push((async () => {
      await actor.mutate((cur) => ({
        next: { ...cur, captions: { rows: [...cur.captions.rows, { id: `fast_${i}`, text: 'fast' }] } },
        result: null,
      }));
      return Date.now() - start;
    })());
  }
  const fastDurations = await Promise.all(fastPromises);
  const slowDuration = await slow;
  const maxFast = Math.max(...fastDurations);
  if (maxFast > 200) {
    console.error(`❌ Test 4 FAILED — fast mutates took up to ${maxFast}ms (should be <200ms)`);
    process.exit(1);
  }
  if (slowDuration < 500) {
    console.error(`❌ Test 4 FAILED — slow mutate finished before its sleep`);
    process.exit(1);
  }
  console.log(`fast mutates max duration: ${maxFast}ms (slow finished at ${slowDuration}ms)`);
  console.log('✓ Test 4 passed: slow OUTSIDE-actor work does not block other mutates');

  // ============================================================
  // Test 5: stress — 200 random mutations across "scenes" and "captions"
  // simulating the editor's real concurrent write load.
  // ============================================================
  console.log('\n=== Test 5: stress — 200 mixed concurrent mutates ===');
  await actor.mutate(c => ({
    next: { scenes: c.scenes.map(s => ({ ...s, status: 'pending', videoSrc: null })), captions: { rows: [] } },
    result: null,
  }));
  const N = 200;
  const stressPromises: Promise<unknown>[] = [];
  let scenePatchIdx = 0;
  for (let i = 0; i < N; i++) {
    if (i % 2 === 0) {
      // scene patch — round-robin across all 4 scenes
      const sceneId = sceneIds[scenePatchIdx++ % sceneIds.length];
      stressPromises.push((async () => {
        await new Promise(r => setTimeout(r, Math.random() * 20));
        return actor.mutate((cur) => {
          const idx = cur.scenes.findIndex(s => s.id === sceneId);
          const next = {
            ...cur,
            scenes: cur.scenes.map((s, si) => si === idx ? { ...s, status: 'ready', videoSrc: `assets/pika/${sceneId}.mp4` } : s),
          };
          return { next, result: null };
        });
      })());
    } else {
      // caption append
      stressPromises.push((async () => {
        await new Promise(r => setTimeout(r, Math.random() * 20));
        return actor.mutate((cur) => ({
          next: { ...cur, captions: { rows: [...cur.captions.rows, { id: `r_${i}`, text: `row ${i}` }] } },
          result: null,
        }));
      })());
    }
  }
  await Promise.all(stressPromises);
  const finalStress = JSON.parse(readFileSync(filePath, 'utf8')) as TestDoc;
  const allScenesReady = finalStress.scenes.every(s => s.status === 'ready' && s.videoSrc !== null);
  const expectedCaptions = N / 2;
  console.log(`scenes ready: ${finalStress.scenes.filter(s => s.status === 'ready').length}/${finalStress.scenes.length}`);
  console.log(`caption rows: ${finalStress.captions.rows.length} (expected ${expectedCaptions})`);
  if (!allScenesReady || finalStress.captions.rows.length !== expectedCaptions) {
    console.error('❌ Test 5 FAILED — stress test had losses');
    process.exit(1);
  }
  console.log('✓ Test 5 passed: 200 concurrent mutates landed cleanly');

  rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n✓ All 5 tests passed. Actor pattern verified end-to-end.');
}

main().catch((err) => {
  console.error('spike crashed:', err);
  process.exit(1);
});
