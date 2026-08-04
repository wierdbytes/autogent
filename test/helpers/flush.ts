import type { FakeClock } from "../../src/runtime/clock.js";

/**
 * Drains the microtask queue.
 *
 * The fake relay answers on microtasks, so a single macrotask hop lets every
 * pending continuation run to completion before assertions.
 */
export async function flush(rounds = 2): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Advances fake time and lets the work it unblocked settle.
 *
 * Flushing first matters: a real event loop always runs pending microtasks
 * before the next timer, so callbacks that arm a timer must get their turn
 * before time moves.
 */
export async function advance(clock: FakeClock, ms: number, rounds = 2): Promise<void> {
  await flush(rounds);
  await clock.advance(ms);
  await flush(rounds);
}
