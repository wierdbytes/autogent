/**
 * Global concurrency limit across channels (plan §5.3, §15).
 *
 * Each channel actor is already single-flight on its own. This adds a ceiling on
 * how many channels may hold a running turn at once, so a busy community cannot
 * spawn unbounded concurrent model calls.
 *
 * Waiters are served first-come-first-served; without that, a chatty channel
 * could starve a quiet one indefinitely.
 */

export class Semaphore {
  #available: number;
  #permits: number;
  readonly #waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error("semaphore needs at least one permit");
    this.#available = permits;
    this.#permits = permits;
  }

  get permits(): number {
    return this.#permits;
  }

  /**
   * Resizes the ceiling at runtime (core-record hot update, remote plan §3.3).
   *
   * Growth wakes as many waiters as new permits exist. Shrinking never revokes
   * a permit already held — running turns finish; the lower ceiling binds as
   * they release (available may go negative in the interim, which simply means
   * no waiter is served until the deficit clears).
   */
  setPermits(permits: number): void {
    if (permits < 1) throw new Error("semaphore needs at least one permit");
    const delta = permits - this.#permits;
    this.#permits = permits;
    this.#available += delta;
    while (this.#available > 0 && this.#waiters.length > 0) {
      this.#available -= 1;
      this.#waiters.shift()?.();
    }
  }

  get available(): number {
    return this.#available;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#release();
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    return this.#release();
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A shrink may have driven `available` negative; the released permit then
      // pays down the deficit instead of waking a waiter.
      if (this.#available < 0) {
        this.#available += 1;
        return;
      }
      const next = this.#waiters.shift();
      if (next) {
        next();
        return;
      }
      this.#available += 1;
    };
  }
}
