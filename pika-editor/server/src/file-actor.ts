/**
 * FileActor — single-writer serialization for a JSON file.
 *
 * Why this exists: the editor's previous architecture had N writers all doing
 * `readFile → mutate → writeFile` against the same shared JSON file. When two
 * writers raced, the later writer overwrote the earlier writer's snapshot,
 * silently losing the earlier mutation. That's why captions disappeared,
 * scenes ended up `ready` with no `videoSrc`, and workspace tiles got stuck.
 *
 * Contract:
 *
 *   actor.mutate((current) => ({ next, result }))
 *
 * The actor:
 *   1. Acquires its FIFO Promise-chain lock.
 *   2. Reads the file fresh (or returns the initial doc if absent).
 *   3. Parses + validates (caller-supplied parse fn).
 *   4. Calls `fn(current)` — this MUST be synchronous-ish and fast. Compute
 *      deltas; do not fetch/ffmpeg/await network inside `fn`.
 *   5. Serializes the returned `next` and atomically writes (tmp + rename).
 *   6. Broadcasts the file-changed SSE (caller-supplied).
 *   7. Resolves the caller's Promise with `result`.
 *
 * Lock-hold is bounded by `fn`'s synchronous work plus a parse + serialize +
 * rename — typically <10ms even for a large timeline. Long-running work
 * (Pika polling, ffmpeg, fetch) must happen OUTSIDE `mutate` and then commit
 * its small delta inside. This is what makes the pattern fit 15-minute
 * background gens without blocking other writers.
 *
 * Error semantics: if `fn` throws or the write fails, the caller's `mutate`
 * promise rejects with that error. The queue continues processing subsequent
 * mutates as if the error hadn't happened — no poisoning.
 *
 * Verified by `state-actor-spike/actor-spike.ts`: 5 tests covering parallel
 * patches, ordering, error isolation, lock-hold time, and a 200-mutate stress
 * test. All pass with zero losses.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface FileActorOptions<T> {
  /** Absolute path to the file the actor owns. */
  filePath: () => string;
  /** Parse a raw string from disk into the doc type. */
  parse: (raw: string) => T;
  /** Serialize a doc back to its on-disk string form (incl. trailing newline). */
  serialize: (doc: T) => string;
  /** Called when the file doesn't exist yet. Should NEVER throw. */
  initial: () => T;
  /** Called after every successful commit. Use for SSE broadcasts. */
  onCommit?: (next: T) => void;
}

export class FileActor<T> {
  private queue: Promise<unknown> = Promise.resolve();
  private paused = false;
  private pauseGate: Promise<void> = Promise.resolve();
  private resolvePauseGate: (() => void) | null = null;
  constructor(private readonly opts: FileActorOptions<T>) {}

  /**
   * Acquire the lock, run `fn` against the current state, commit, broadcast.
   * Returns whatever `fn` puts in `result`.
   */
  async mutate<R>(fn: (cur: T) => { next: T; result: R } | Promise<{ next: T; result: R }>): Promise<R> {
    let resolveOut!: (v: R) => void;
    let rejectOut!: (e: unknown) => void;
    const out = new Promise<R>((res, rej) => { resolveOut = res; rejectOut = rej; });
    this.queue = this.queue.then(async () => {
      try {
        // Honor pause() — wait until resume() before reading/writing.
        if (this.paused) await this.pauseGate;
        const filePath = this.opts.filePath();
        const cur = existsSync(filePath)
          ? this.opts.parse(readFileSync(filePath, 'utf8'))
          : this.opts.initial();
        const { next, result } = await fn(cur);
        // Atomic write
        mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
        writeFileSync(tmp, this.opts.serialize(next));
        renameSync(tmp, filePath);
        // Side-effect: SSE broadcast (or any post-commit hook).
        if (this.opts.onCommit) {
          try { this.opts.onCommit(next); }
          catch (broadcastErr) {
            // A bad listener must not break the actor's contract.
            // eslint-disable-next-line no-console
            console.error('[FileActor] onCommit threw (non-fatal):', broadcastErr);
          }
        }
        resolveOut(result);
      } catch (err) {
        rejectOut(err);
      }
    }).catch(() => { /* error already delivered via rejectOut; swallow in queue chain */ });
    return out;
  }

  /**
   * Read the current state without acquiring the lock. The result reflects
   * whatever has been committed up to this call. If a write is in flight
   * inside `mutate`, this read may return the pre-write state — that's
   * acceptable for routes that only need a recent snapshot. Use `mutate`
   * (which always reads fresh inside the lock) when the read must be
   * causally consistent with a subsequent write.
   */
  read(): T {
    const filePath = this.opts.filePath();
    return existsSync(filePath)
      ? this.opts.parse(readFileSync(filePath, 'utf8'))
      : this.opts.initial();
  }

  /**
   * Pause the actor before an external rewrite of the file (e.g. git
   * checkout during `POST /versions/:sha/restore`). All in-flight mutates
   * complete first; subsequent mutates wait until `resume()` is called.
   * On resume, the actor re-reads fresh — so the external rewrite's
   * contents become the new baseline.
   */
  async pause(): Promise<void> {
    // Wait for the current queue to drain
    await this.queue.catch(() => undefined);
    if (this.paused) return;
    this.paused = true;
    this.pauseGate = new Promise<void>((res) => { this.resolvePauseGate = res; });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.resolvePauseGate) {
      this.resolvePauseGate();
      this.resolvePauseGate = null;
    }
  }
}
