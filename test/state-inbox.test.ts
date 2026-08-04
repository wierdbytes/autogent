import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatEvent, inboxRecord, openTestStore, turnRecord, type TestStore } from "./state-fixtures.js";

let store: TestStore;

beforeEach(() => {
  store = openTestStore();
});

afterEach(() => {
  store.close();
});

describe("inbox dedup", () => {
  it("accepts an event id once", () => {
    const record = inboxRecord({ eventId: "event-1" });
    expect(store.state.inbox.insertIfAbsent(record)).toBe(true);
    expect(store.state.inbox.insertIfAbsent(record)).toBe(false);
    expect(store.state.inbox.pendingForChannel("channel-1")).toHaveLength(1);
  });

  it("keeps the first copy when a relay replays an already-processed event", () => {
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "event-1", receivedAt: 10 }));
    store.state.inbox.setDisposition("event-1", "completed");

    const replay = inboxRecord({ eventId: "event-1", receivedAt: 999, disposition: "queued" });
    expect(store.state.inbox.insertIfAbsent(replay)).toBe(false);

    const stored = store.state.inbox.get("event-1");
    expect(stored?.receivedAt).toBe(10);
    expect(stored?.disposition).toBe("completed");
  });

  it("round-trips the raw event", () => {
    const event = chatEvent("event-1", { tags: [["h", "channel-1"], ["e", "root", "", "root"]] });
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "event-1", rawEvent: event }));
    expect(store.state.inbox.get("event-1")?.rawEvent).toEqual(event);
  });
});

describe("steer race", () => {
  beforeEach(() => {
    store.state.turns.create(turnRecord({ turnId: "turn-1" }));
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "steer-1", receivedAt: 20 }));
    store.state.turns.addInput("turn-1", "steer-1", "steer", 1);
    store.state.inbox.assignToTurn("steer-1", "turn-1", 1, "steer_pending");
  });

  it("moves a rejected handoff back to the queue without a second insert", () => {
    expect(store.state.inbox.releaseSteerPending("steer-1")).toBe(true);

    const row = store.state.inbox.get("steer-1");
    expect(row?.disposition).toBe("queued");
    expect(row?.turnId).toBeNull();
    expect(row?.inputOrdinal).toBeNull();
    expect(store.state.turns.inputs("turn-1")).toHaveLength(0);
    expect(store.state.inbox.pendingForChannel("channel-1")).toHaveLength(1);
  });

  it("is idempotent", () => {
    expect(store.state.inbox.releaseSteerPending("steer-1")).toBe(true);
    expect(store.state.inbox.releaseSteerPending("steer-1")).toBe(false);
    expect(store.state.inbox.get("steer-1")?.disposition).toBe("queued");
    expect(store.state.inbox.pendingForChannel("channel-1")).toHaveLength(1);
  });

  it("leaves a delivered steer alone", () => {
    store.state.inbox.setDisposition("steer-1", "steer_delivered");
    store.state.turns.markInputDelivered("turn-1", "steer-1", 25);

    expect(store.state.inbox.releaseSteerPending("steer-1")).toBe(false);
    expect(store.state.inbox.get("steer-1")?.disposition).toBe("steer_delivered");
    expect(store.state.turns.inputs("turn-1")).toHaveLength(1);
  });

  it("frees the ordinal for the next steer", () => {
    store.state.inbox.releaseSteerPending("steer-1");
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "steer-2", receivedAt: 30 }));

    expect(() => store.state.turns.addInput("turn-1", "steer-2", "steer", 1)).not.toThrow();
  });
});

describe("channel queues", () => {
  beforeEach(() => {
    store.state.turns.create(turnRecord({ turnId: "turn-1" }));
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "primary", receivedAt: 10 }));
    store.state.turns.addInput("turn-1", "primary", "primary", 0);
    store.state.inbox.assignToTurn("primary", "turn-1", 0, "prompted");
    store.state.turns.markInputDelivered("turn-1", "primary", 11);

    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "queued-later", receivedAt: 30 }));
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "queued-early", receivedAt: 20 }));
    store.state.inbox.insertIfAbsent(
      inboxRecord({ eventId: "other-channel", channelId: "channel-2", receivedAt: 40 }),
    );
  });

  it("returns undelivered inputs oldest first", () => {
    expect(store.state.inbox.pendingForChannel("channel-1").map((r) => r.eventId)).toEqual([
      "queued-early",
      "queued-later",
    ]);
  });

  it("includes delivered but unanswered inputs in the unsettled view", () => {
    expect(store.state.inbox.unsettledForChannel("channel-1").map((r) => r.eventId)).toEqual([
      "primary",
      "queued-early",
      "queued-later",
    ]);
  });

  it("lists every channel that still owes an answer", () => {
    expect(store.state.inbox.unsettledChannels()).toEqual(["channel-1", "channel-2"]);
  });

  it("settles only the delivered inputs of a turn", () => {
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "steer-pending", receivedAt: 35 }));
    store.state.turns.addInput("turn-1", "steer-pending", "steer", 1);
    store.state.inbox.assignToTurn("steer-pending", "turn-1", 1, "steer_pending");

    store.state.inbox.completeTurnInputs("turn-1");

    expect(store.state.inbox.get("primary")?.disposition).toBe("completed");
    expect(store.state.inbox.get("steer-pending")?.disposition).toBe("steer_pending");
  });
});
