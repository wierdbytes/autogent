import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chatEvent,
  openTestStore,
  outboxRecord,
  outputIntent,
  turnRecord,
  type TestStore,
} from "./state-fixtures.js";

let store: TestStore;

beforeEach(() => {
  store = openTestStore();
  store.state.turns.create(turnRecord({ turnId: "turn-a", startedAt: 100 }));
  store.state.turns.create(turnRecord({ turnId: "turn-b", startedAt: 200 }));
});

afterEach(() => {
  store.close();
});

/** Records an intent and immediately signs it, advancing the clock like the publisher does. */
function sign(turnId: string, ordinal: number, eventId: string): void {
  const logicalId = `${turnId}:msg-${ordinal}:${ordinal}`;
  store.state.outbox.putIntent(outputIntent({ logicalId, turnId, ordinal }));
  store.advance();
  store.state.outbox.putSigned(outboxRecord({ logicalId, eventId }));
  store.advance();
}

describe("output intents", () => {
  it("is idempotent on the logical id", () => {
    const intent = outputIntent({ logicalId: "turn-a:msg-1:0", turnId: "turn-a", content: "first" });
    expect(store.state.outbox.putIntent(intent)).toBe(true);
    expect(store.state.outbox.putIntent({ ...intent, content: "second" })).toBe(false);

    const stored = store.state.outbox.intentsForTurn("turn-a");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toBe("first");
    expect(stored[0]?.participantPubkeys).toEqual(["a".repeat(64)]);
  });

  it("returns a turn's intents in ordinal order", () => {
    for (const ordinal of [2, 0, 1]) {
      store.state.outbox.putIntent(
        outputIntent({ logicalId: `turn-a:msg:${ordinal}`, turnId: "turn-a", ordinal }),
      );
    }
    expect(store.state.outbox.intentsForTurn("turn-a").map((i) => i.ordinal)).toEqual([0, 1, 2]);
  });

  it("only reports intents that were never signed", () => {
    store.state.outbox.putIntent(outputIntent({ logicalId: "turn-a:msg:0", turnId: "turn-a" }));
    store.state.outbox.putIntent(
      outputIntent({ logicalId: "turn-a:msg:1", turnId: "turn-a", ordinal: 1 }),
    );
    store.state.outbox.putSigned(outboxRecord({ logicalId: "turn-a:msg:1", eventId: "signed-1" }));

    expect(store.state.outbox.unsignedIntents().map((i) => i.logicalId)).toEqual(["turn-a:msg:0"]);
  });
});

describe("putSigned", () => {
  it("keeps the first signature when called twice", () => {
    store.state.outbox.putIntent(outputIntent({ logicalId: "turn-a:msg:0", turnId: "turn-a" }));
    const first = outboxRecord({ logicalId: "turn-a:msg:0", eventId: "event-first" });
    store.state.outbox.putSigned(first);
    store.state.outbox.putSigned(
      outboxRecord({
        logicalId: "turn-a:msg:0",
        eventId: "event-second",
        signedEvent: chatEvent("event-second"),
      }),
    );

    const due = store.state.outbox.duePublishes(10_000);
    expect(due).toHaveLength(1);
    expect(due[0]?.eventId).toBe("event-first");
    expect(due[0]?.signedEvent).toEqual(first.signedEvent);
    expect(store.state.outbox.intentsForTurn("turn-a")[0]?.state).toBe("signed");
  });

  it("does not resurrect an already published row", () => {
    store.state.outbox.putIntent(outputIntent({ logicalId: "turn-a:msg:0", turnId: "turn-a" }));
    store.state.outbox.putSigned(outboxRecord({ logicalId: "turn-a:msg:0", eventId: "event-1" }));
    store.state.outbox.markPublished("turn-a:msg:0");
    store.state.outbox.putSigned(outboxRecord({ logicalId: "turn-a:msg:0", eventId: "event-1" }));

    expect(store.state.outbox.duePublishes(10_000)).toHaveLength(0);
    expect(store.state.outbox.unpublished()).toHaveLength(0);
  });
});

describe("duePublishes", () => {
  it("emits a turn's outputs in ordinal order regardless of signing order", () => {
    sign("turn-a", 2, "event-a2");
    sign("turn-a", 1, "event-a1");
    sign("turn-a", 0, "event-a0");
    sign("turn-b", 0, "event-b0");

    expect(store.state.outbox.duePublishes(store.now()).map((r) => r.eventId)).toEqual([
      "event-a0",
      "event-a1",
      "event-a2",
      "event-b0",
    ]);
  });

  it("orders events without an intent by age", () => {
    store.state.outbox.putSigned(outboxRecord({ logicalId: "usage:1", eventId: "event-usage" }));
    store.advance();
    sign("turn-a", 0, "event-a0");

    expect(store.state.outbox.duePublishes(store.now()).map((r) => r.eventId)).toEqual([
      "event-usage",
      "event-a0",
    ]);
  });

  it("excludes rows whose retry time has not arrived", () => {
    sign("turn-a", 0, "event-a0");
    sign("turn-b", 0, "event-b0");
    store.state.outbox.markFailed("turn-a:msg-0:0", "rate-limited", 5_000);

    expect(store.state.outbox.duePublishes(4_999).map((r) => r.eventId)).toEqual(["event-b0"]);
    expect(store.state.outbox.duePublishes(5_000).map((r) => r.eventId)).toEqual([
      "event-a0",
      "event-b0",
    ]);
  });

  it("ignores backoff when listing everything the relay still owes", () => {
    sign("turn-a", 0, "event-a0");
    store.state.outbox.markFailed("turn-a:msg-0:0", "rate-limited", 999_999);

    expect(store.state.outbox.duePublishes(store.now())).toHaveLength(0);
    expect(store.state.outbox.unpublished().map((r) => r.eventId)).toEqual(["event-a0"]);
  });

  it("drops rows once they are published or dead-lettered", () => {
    sign("turn-a", 0, "event-a0");
    sign("turn-a", 1, "event-a1");
    store.state.outbox.markPublished("turn-a:msg-0:0");
    store.state.outbox.markDeadLetter("turn-a:msg-1:1", "revoked attestation");

    expect(store.state.outbox.duePublishes(store.now())).toHaveLength(0);
    const intents = store.state.outbox.intentsForTurn("turn-a");
    expect(intents.map((i) => i.state)).toEqual(["published", "abandoned"]);
  });
});

describe("failure bookkeeping", () => {
  it("counts attempts and records the last error", () => {
    sign("turn-a", 0, "event-a0");
    store.state.outbox.markFailed("turn-a:msg-0:0", "connection reset", null);
    store.state.outbox.markFailed("turn-a:msg-0:0", "rate-limited", null);

    const record = store.state.outbox.unpublished()[0];
    expect(record?.attempts).toBe(2);
    expect(record?.lastError).toBe("rate-limited");
    expect(record?.state).toBe("failed");
  });

  it("cannot fail a row the relay already acknowledged", () => {
    sign("turn-a", 0, "event-a0");
    store.state.outbox.markPublished("turn-a:msg-0:0");
    store.state.outbox.markFailed("turn-a:msg-0:0", "late timeout", null);

    expect(store.state.outbox.unpublished()).toHaveLength(0);
  });
});

describe("turn output timestamps", () => {
  it("reports when a turn last produced output", () => {
    expect(store.state.outbox.latestIntentAt("turn-a")).toBeNull();
    store.state.outbox.putIntent(outputIntent({ logicalId: "turn-a:msg:0", turnId: "turn-a" }));
    const first = store.now();
    store.advance(50);
    store.state.outbox.putIntent(
      outputIntent({ logicalId: "turn-a:msg:1", turnId: "turn-a", ordinal: 1 }),
    );

    expect(store.state.outbox.latestIntentAt("turn-a")).toBe(first + 50);
  });
});
