import type { Clock } from "./ports.js";

/** Wall-clock implementation used in production. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    // Never hold the process open for a pending timer.
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  setInterval(fn, ms) {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/**
 * Deterministic clock for tests.
 *
 * Time only moves when `advance()` is called, so scheduler races (settle vs
 * steer, backoff ladders, liveness heartbeats) are reproducible instead of
 * timing-dependent.
 */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<
    number,
    { at: number; fn: () => void; intervalMs: number | null; seq: number }
  >();

  constructor(startMs = 1_700_000_000_000) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const cancel = this.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        cancel();
        reject(new DOMException("aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.#seq++;
    this.#timers.set(id, { at: this.#now + ms, fn, intervalMs: null, seq: id });
    return () => this.#timers.delete(id);
  }

  setInterval(fn: () => void, ms: number): () => void {
    const id = this.#seq++;
    this.#timers.set(id, { at: this.#now + ms, fn, intervalMs: ms, seq: id });
    return () => this.#timers.delete(id);
  }

  /** Moves time forward, firing due timers in scheduled order. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq);
      if (due.length === 0) break;
      const [id, timer] = due[0] as [number, { at: number; fn: () => void; intervalMs: number | null; seq: number }];
      this.#now = timer.at;
      if (timer.intervalMs === null) {
        this.#timers.delete(id);
      } else {
        this.#timers.set(id, { ...timer, at: timer.at + timer.intervalMs });
      }
      timer.fn();
      // Let promise continuations scheduled by the callback run before the
      // next timer fires, so awaited work observes the new time.
      await Promise.resolve();
    }
    this.#now = target;
    await Promise.resolve();
  }

  get pendingTimerCount(): number {
    return this.#timers.size;
  }
}
