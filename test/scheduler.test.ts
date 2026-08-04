import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/runtime/scheduler.js";

describe("Semaphore", () => {
  it("hands out up to its permit count without blocking", async () => {
    const semaphore = new Semaphore(2);
    await semaphore.acquire();
    await semaphore.acquire();
    expect(semaphore.available).toBe(0);
  });

  it("makes the next caller wait until a permit is released", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();

    let acquired = false;
    const pending = semaphore.acquire().then((next) => {
      acquired = true;
      return next;
    });

    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(semaphore.waiting).toBe(1);

    release();
    await pending;
    expect(acquired).toBe(true);
  });

  it("serves waiters in arrival order so a busy channel cannot starve a quiet one", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const order: number[] = [];

    const waiters = [1, 2, 3].map((id) =>
      semaphore.acquire().then((next) => {
        order.push(id);
        next();
      }),
    );

    release();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it("ignores a repeated release, so a permit cannot be duplicated", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    release();
    release();
    expect(semaphore.available).toBe(1);
  });

  it("refuses a zero-permit configuration", () => {
    expect(() => new Semaphore(0)).toThrow(/at least one permit/);
  });
});
