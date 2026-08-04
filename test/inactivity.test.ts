import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/runtime/clock.js";
import { InactivityMonitor } from "../src/runtime/inactivity.js";
import { Semaphore } from "../src/runtime/scheduler.js";

function monitor(options: { busy?: () => boolean; limitSec?: number } = {}) {
  const clock = new FakeClock();
  let expired = 0;
  const m = new InactivityMonitor({
    clock,
    isBusy: options.busy ?? (() => false),
    onExpire: () => {
      expired += 1;
    },
  });
  m.arm(options.limitSec ?? 100);
  return { clock, m, expiredCount: () => expired };
}

describe("InactivityMonitor", () => {
  it("fires after the ceiling with no activity", async () => {
    const { clock, expiredCount } = monitor({ limitSec: 100 });
    await clock.advance(99_000);
    expect(expiredCount()).toBe(0);
    await clock.advance(2_000);
    expect(expiredCount()).toBe(1);
  });

  it("fires exactly once", async () => {
    const { clock, expiredCount } = monitor({ limitSec: 10 });
    await clock.advance(60_000);
    expect(expiredCount()).toBe(1);
  });

  it("is pushed back by activity", async () => {
    const { clock, m, expiredCount } = monitor({ limitSec: 100 });
    await clock.advance(90_000);
    m.noteActivity();
    await clock.advance(90_000);
    expect(expiredCount()).toBe(0);
    await clock.advance(20_000);
    expect(expiredCount()).toBe(1);
  });

  it("never fires while a turn is in flight, however long it runs", async () => {
    let busy = true;
    const { clock, expiredCount } = monitor({ limitSec: 100, busy: () => busy });
    await clock.advance(500_000);
    expect(expiredCount()).toBe(0);
    // The long turn also counts as activity: a fresh window starts when it ends.
    busy = false;
    await clock.advance(99_000);
    expect(expiredCount()).toBe(0);
    await clock.advance(2_000);
    expect(expiredCount()).toBe(1);
  });

  it("treats zero as indefinite", async () => {
    const { clock, expiredCount, m } = monitor({ limitSec: 0 });
    m.arm(0);
    await clock.advance(10_000_000);
    expect(expiredCount()).toBe(0);
  });

  it("re-arms hot to a new ceiling", async () => {
    const { clock, m, expiredCount } = monitor({ limitSec: 1_000 });
    m.arm(10);
    await clock.advance(11_000);
    expect(expiredCount()).toBe(1);
  });

  it("stops cleanly", async () => {
    const { clock, m, expiredCount } = monitor({ limitSec: 10 });
    m.stop();
    await clock.advance(60_000);
    expect(expiredCount()).toBe(0);
  });
});

describe("Semaphore.setPermits", () => {
  it("wakes waiters when the ceiling grows", async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    let acquired = false;
    const waiter = semaphore.acquire().then((release) => {
      acquired = true;
      return release;
    });
    expect(semaphore.waiting).toBe(1);

    semaphore.setPermits(2);
    const release = await waiter;
    expect(acquired).toBe(true);
    release();
    first();
  });

  it("shrinking never revokes a held permit but binds as they release", async () => {
    const semaphore = new Semaphore(3);
    const a = await semaphore.acquire();
    const b = await semaphore.acquire();
    const c = await semaphore.acquire();

    semaphore.setPermits(1);
    let acquired = false;
    void semaphore.acquire().then((release) => {
      acquired = true;
      release();
    });

    // Releasing two permits only pays down the deficit (3 held, ceiling 1).
    a();
    b();
    await Promise.resolve();
    expect(acquired).toBe(false);

    // The third release brings held to 0 < ceiling 1 — the waiter runs.
    c();
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(true);
  });
});
