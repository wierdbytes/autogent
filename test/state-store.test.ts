import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/state/database.js";
import { SCHEMA_VERSION } from "../src/state/migrations.js";
import { inboxRecord, openTestStore, turnRecord, type TestStore } from "./state-fixtures.js";

let store: TestStore;

beforeEach(() => {
  store = openTestStore();
});

afterEach(() => {
  store.close();
});

describe("database file", () => {
  it("persists in WAL mode and reopens without re-running migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-state-"));
    const path = join(dir, "agent.sqlite");
    try {
      const first = openDatabase(path);
      first.inbox.insertIfAbsent(inboxRecord({ eventId: "event-1" }));
      first.close();

      const probe = new Database(path);
      expect(probe.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(probe.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      probe.close();

      const second = openDatabase(path);
      expect(second.inbox.get("event-1")?.eventId).toBe("event-1");
      expect(second.inbox.insertIfAbsent(inboxRecord({ eventId: "event-1" }))).toBe(false);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("transactions", () => {
  it("rolls back every write when the body throws", () => {
    expect(() =>
      store.state.transaction(() => {
        store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "event-1" }));
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(store.state.inbox.get("event-1")).toBeUndefined();
  });

  it("nests", () => {
    store.state.transaction(() => {
      store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "outer" }));
      store.state.transaction(() => {
        store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "inner" }));
      });
    });

    expect(store.state.inbox.get("inner")?.eventId).toBe("inner");
  });

  it("enforces foreign keys", () => {
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "event-1" }));
    expect(() => store.state.turns.addInput("missing-turn", "event-1", "primary", 0)).toThrow(
      /FOREIGN KEY/i,
    );
  });
});

describe("turns", () => {
  it("stamps the settle time once", () => {
    store.state.turns.create(turnRecord({ turnId: "turn-1" }));
    store.advance(500);
    const settledAt = store.now();
    store.state.turns.setState("turn-1", "settled");
    store.advance(500);
    store.state.turns.setState("turn-1", "completed", "drained");

    const turn = store.state.turns.get("turn-1");
    expect(turn?.state).toBe("completed");
    expect(turn?.settledAt).toBe(settledAt);
    expect(turn?.stopReason).toBe("drained");
  });

  it("lists only turns a crash could have cut short", () => {
    store.state.turns.create(turnRecord({ turnId: "turn-running", startedAt: 10 }));
    store.state.turns.create(
      turnRecord({ turnId: "turn-settling", state: "settling", startedAt: 20 }),
    );
    store.state.turns.create(turnRecord({ turnId: "turn-done", state: "completed", startedAt: 5 }));

    expect(store.state.turns.unfinished().map((t) => t.turnId)).toEqual([
      "turn-running",
      "turn-settling",
    ]);
  });

  it("keeps input order and delivery state", () => {
    store.state.turns.create(turnRecord({ turnId: "turn-1" }));
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "primary" }));
    store.state.inbox.insertIfAbsent(inboxRecord({ eventId: "steer" }));
    store.state.turns.addInput("turn-1", "primary", "primary", 0);
    store.state.turns.addInput("turn-1", "steer", "steer", 1);
    store.state.turns.addInput("turn-1", "steer", "steer", 1);
    store.state.turns.markInputDelivered("turn-1", "primary", 42);

    expect(store.state.turns.inputs("turn-1")).toEqual([
      { eventId: "primary", role: "primary", ordinal: 0, deliveredAt: 42 },
      { eventId: "steer", role: "steer", ordinal: 1, deliveredAt: null },
    ]);
  });
});

describe("channels", () => {
  const base = {
    relayId: "relay-1",
    channelId: "channel-1",
    status: "active",
    name: "General",
    channelType: "stream",
    piSessionId: null,
    piSessionPath: null,
    lastSeenCreatedAt: null,
  } as const;

  it("refreshes metadata without detaching the Pi session", () => {
    store.state.channels.upsert({ ...base });
    store.state.channels.setPiSession("relay-1", "channel-1", "session-1", "/tmp/session-1.json");
    store.state.channels.upsert({ ...base, name: "Renamed" });

    const channel = store.state.channels.get("relay-1", "channel-1");
    expect(channel?.name).toBe("Renamed");
    expect(channel?.piSessionId).toBe("session-1");
    expect(channel?.piSessionPath).toBe("/tmp/session-1.json");
  });

  it("never rewinds the last seen watermark", () => {
    store.state.channels.upsert({ ...base });
    store.state.channels.setLastSeen("relay-1", "channel-1", 500);
    store.state.channels.setLastSeen("relay-1", "channel-1", 100);

    expect(store.state.channels.get("relay-1", "channel-1")?.lastSeenCreatedAt).toBe(500);
  });

  it("lists active channels of a relay only", () => {
    store.state.channels.upsert({ ...base });
    store.state.channels.upsert({ ...base, channelId: "channel-2" });
    store.state.channels.upsert({ ...base, relayId: "relay-2", channelId: "channel-3" });
    store.state.channels.setStatus("relay-1", "channel-2", "removed");

    expect(store.state.channels.active("relay-1").map((c) => c.channelId)).toEqual(["channel-1"]);
  });
});

describe("session state", () => {
  it("hands out observer sequence numbers per session", () => {
    expect(store.state.sessions.nextObserverSeq("session-a")).toBe(1);
    expect(store.state.sessions.nextObserverSeq("session-a")).toBe(2);
    expect(store.state.sessions.nextObserverSeq("session-b")).toBe(1);
    expect(store.state.sessions.nextObserverSeq("session-a")).toBe(3);
  });

  it("round-trips usage baselines", () => {
    expect(store.state.sessions.getUsageBaseline("session-a")).toBeUndefined();
    store.state.sessions.setUsageBaseline("session-a", 3, { input: 10, output: 4 });
    store.state.sessions.setUsageBaseline("session-a", 4, { input: 20, output: 8 });

    expect(store.state.sessions.getUsageBaseline("session-a")).toEqual({
      turnSeq: 4,
      counters: { input: 20, output: 8 },
    });
  });
});
