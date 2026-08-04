/**
 * `exit-after-inactivity` (remote plan §6.2.5, invariant I5).
 *
 * A deliberately dumb timer, independent of the scheduler and the session
 * pool: the spec's lesson is that a reaper which asks "did the pool wake up?"
 * inherits every pool bug. Activity is defined narrowly — a dispatched inbound
 * event or a settling turn — and raw relay traffic (heartbeats, presence of
 * others, replayed history) does not count.
 *
 * Zero is the legal "run indefinitely": the monitor simply never arms.
 */

import type { Clock, Logger } from "./ports.js";
import { nullLogger } from "./logger.js";

export interface InactivityMonitorOptions {
  clock: Clock;
  /** True while any turn is in flight; the timer never fires under load. */
  isBusy(): boolean;
  /** Invoked exactly once, on expiry. Expected to start a graceful shutdown. */
  onExpire(): void;
  logger?: Logger;
}

export class InactivityMonitor {
  readonly #clock: Clock;
  readonly #isBusy: () => boolean;
  readonly #onExpire: () => void;
  readonly #logger: Logger;
  #limitMs = 0;
  #lastActivity = 0;
  #cancel: (() => void) | null = null;
  #expired = false;
  #stopped = false;

  constructor(options: InactivityMonitorOptions) {
    this.#clock = options.clock;
    this.#isBusy = options.isBusy;
    this.#onExpire = options.onExpire;
    this.#logger = options.logger ?? nullLogger;
  }

  /** (Re)arms with a new ceiling. 0 disarms. Hot-updatable from the core engram. */
  arm(inactivitySec: number): void {
    if (this.#stopped || this.#expired) return;
    this.#limitMs = Math.max(0, inactivitySec) * 1000;
    this.#lastActivity = this.#clock.now();
    this.#reschedule();
    if (this.#limitMs > 0) {
      this.#logger.info("inactivity exit armed", { inactivitySec });
    }
  }

  /** Records agent-relevant activity: a dispatched event or a settled turn. */
  noteActivity(): void {
    this.#lastActivity = this.#clock.now();
  }

  stop(): void {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
  }

  #reschedule(): void {
    this.#cancel?.();
    this.#cancel = null;
    if (this.#limitMs <= 0) return;
    const remaining = Math.max(this.#lastActivity + this.#limitMs - this.#clock.now(), 0);
    this.#cancel = this.#clock.setTimeout(() => this.#check(), remaining);
  }

  #check(): void {
    if (this.#stopped || this.#expired || this.#limitMs <= 0) return;
    const idleFor = this.#clock.now() - this.#lastActivity;
    // A turn in flight is activity by definition, even if nothing has been
    // dispatched for a while — a long-running turn must not kill the process.
    if (this.#isBusy() || idleFor < this.#limitMs) {
      if (this.#isBusy()) this.#lastActivity = this.#clock.now();
      this.#reschedule();
      return;
    }
    this.#expired = true;
    this.#logger.info("inactivity ceiling reached; requesting shutdown", {
      idleForSec: Math.round(idleFor / 1000),
    });
    this.#onExpire();
  }
}
