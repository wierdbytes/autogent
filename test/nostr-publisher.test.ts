import { describe, expect, it } from "vitest";
import { OutboxPublisher, orderForPublish } from "../src/nostr/publisher.js";
import { PUBLISH_TIMEOUT_MS, RelaySupervisor } from "../src/nostr/relay-supervisor.js";
import { KIND, type NostrEvent } from "../src/nostr/types.js";
import { FakeClock } from "../src/runtime/clock.js";
import type { OutboxRecord } from "../src/runtime/ports.js";
import { PublisherOutbox } from "./helpers/fake-outbox.js";
import { FakeRelay } from "./helpers/fake-relay.js";
import { advance, flush } from "./helpers/flush.js";
import { createTestIdentity } from "./helpers/identity.js";

const RELAY_URL = "ws://relay.test:3000";

async function setup(options: { maxAttempts?: number; pollIntervalMs?: number } = {}) {
  const clock = new FakeClock();
  const identity = createTestIdentity(clock);
  const relay = new FakeRelay();
  const supervisor = new RelaySupervisor({
    url: RELAY_URL,
    builder: identity.builder,
    clock,
    socketFactory: relay.factory,
    random: () => 0.5,
  });
  await supervisor.connect();
  await flush();
  const outbox = new PublisherOutbox();
  const publisher = new OutboxPublisher({
    outbox,
    relay: supervisor,
    clock,
    baseRetryMs: 1_000,
    maxAttempts: options.maxAttempts ?? 6,
    pollIntervalMs: options.pollIntervalMs ?? 250,
  });

  const enqueue = (turnId: string, ordinal: number, content: string): NostrEvent => {
    const signed = identity.builder.build({
      kind: KIND.CHAT,
      tags: [["h", "c1"]],
      content,
    });
    outbox.putSigned({
      logicalId: `${turnId}:msg-${ordinal}:${ordinal}`,
      eventId: signed.id,
      kind: signed.kind,
      signedEvent: signed,
      state: "pending",
      attempts: 0,
      nextRetryAt: null,
      lastError: null,
    });
    return signed;
  };

  return { clock, identity, relay, supervisor, outbox, publisher, enqueue };
}

function stub(logicalId: string): OutboxRecord {
  return {
    logicalId,
    eventId: logicalId,
    kind: KIND.CHAT,
    signedEvent: {} as NostrEvent,
    state: "pending",
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
  };
}

describe("publish ordering", () => {
  it("orders each turn by ordinal and keeps turns in arrival order", () => {
    const records = [
      stub("turn-b:msg-0:0"),
      stub("turn-a:msg-2:2"),
      stub("turn-a:msg-0:0"),
      stub("turn-a:msg-1:1"),
      stub("turn-b:msg-1:1"),
    ];
    expect(orderForPublish(records).map((record) => record.logicalId)).toEqual([
      "turn-b:msg-0:0",
      "turn-b:msg-1:1",
      "turn-a:msg-0:0",
      "turn-a:msg-1:1",
      "turn-a:msg-2:2",
    ]);
  });

  it("publishes a turn's outputs in ordinal order", async () => {
    const { publisher, relay, enqueue } = await setup();
    enqueue("t1", 2, "third");
    enqueue("t1", 0, "first");
    enqueue("t1", 1, "second");

    expect(await publisher.drainOnce()).toBe(3);
    expect(relay.received.map((event) => event.content)).toEqual(["first", "second", "third"]);
  });

  it("keeps outbox order while the relay is rate limiting", async () => {
    const { publisher, relay, clock, enqueue } = await setup();
    enqueue("t1", 0, "first");
    enqueue("t1", 1, "second");
    enqueue("t1", 2, "third");

    relay.notice("rate-limited: retry in 5s");
    await flush();

    const pending = publisher.drainOnce();
    await flush();
    expect(relay.received).toHaveLength(0);

    await advance(clock, 5_000);
    expect(await pending).toBe(3);
    expect(relay.received.map((event) => event.content)).toEqual(["first", "second", "third"]);
  });
});

describe("retry", () => {
  it("re-sends the identical signed event after a lost OK", async () => {
    const { publisher, relay, clock, outbox, enqueue } = await setup();
    const signed = enqueue("t1", 0, "only");
    relay.eventVerdict = () => null;

    const pending = publisher.drainOnce();
    await advance(clock, PUBLISH_TIMEOUT_MS);
    expect(await pending).toBe(0);

    const failed = outbox.get("t1:msg-0:0");
    expect(failed).toMatchObject({ state: "failed", attempts: 1 });
    expect(failed?.nextRetryAt).toBe(clock.now() + 1_000);

    relay.eventVerdict = () => ({ ok: true, message: "" });
    await advance(clock, 1_000);
    expect(await publisher.drainOnce()).toBe(1);

    expect(relay.received).toHaveLength(2);
    expect(relay.received[0]?.id).toBe(signed.id);
    expect(relay.received[1]?.id).toBe(signed.id);
    expect(relay.received[0]?.sig).toBe(relay.received[1]?.sig);
    expect(outbox.get("t1:msg-0:0")?.state).toBe("published");
  });

  it("does not become due before its retry deadline", async () => {
    const { publisher, relay, clock, enqueue } = await setup();
    enqueue("t1", 0, "only");
    relay.eventVerdict = () => ({ ok: false, message: "error: storage busy" });

    await publisher.drainOnce();
    expect(relay.received).toHaveLength(1);

    await advance(clock, 999);
    await publisher.drainOnce();
    expect(relay.received).toHaveLength(1);

    await advance(clock, 1);
    await publisher.drainOnce();
    expect(relay.received).toHaveLength(2);
  });

  it("backs off exponentially between attempts", async () => {
    const { publisher, clock, outbox, relay, enqueue } = await setup();
    enqueue("t1", 0, "only");
    relay.eventVerdict = () => ({ ok: false, message: "error: storage busy" });

    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await publisher.drainOnce();
      const delay = (outbox.get("t1:msg-0:0")?.nextRetryAt ?? clock.now()) - clock.now();
      delays.push(delay);
      await advance(clock, delay);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  it("blocks later outputs of the same turn but not other turns", async () => {
    const { publisher, relay, outbox, enqueue } = await setup();
    enqueue("t1", 0, "t1-first");
    enqueue("t1", 1, "t1-second");
    enqueue("t2", 0, "t2-first");
    relay.eventVerdict = (event) =>
      event.content === "t1-first" ? { ok: false, message: "error: storage busy" } : { ok: true, message: "" };

    expect(await publisher.drainOnce()).toBe(1);
    expect(relay.received.map((event) => event.content)).toEqual(["t1-first", "t2-first"]);
    expect(outbox.get("t1:msg-1:1")?.state).toBe("pending");
    expect(outbox.get("t2:msg-0:0")?.state).toBe("published");
  });
});

describe("dead letter", () => {
  it("gives up immediately on a terminal rejection", async () => {
    const { publisher, relay, outbox, enqueue } = await setup();
    enqueue("t1", 0, "only");
    relay.eventVerdict = () => ({ ok: false, message: "invalid: bad signature" });

    expect(await publisher.drainOnce()).toBe(0);
    expect(outbox.get("t1:msg-0:0")).toMatchObject({
      state: "dead_letter",
      lastError: "invalid: bad signature",
    });

    await publisher.drainOnce();
    expect(relay.received).toHaveLength(1);
  });

  it("gives up after the attempt bound", async () => {
    const { publisher, relay, clock, outbox, enqueue } = await setup({ maxAttempts: 3 });
    enqueue("t1", 0, "only");
    relay.eventVerdict = () => ({ ok: false, message: "error: storage busy" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await publisher.drainOnce();
      await advance(clock, 10_000);
    }

    expect(relay.received).toHaveLength(3);
    expect(outbox.get("t1:msg-0:0")).toMatchObject({ state: "dead_letter", attempts: 3 });
  });
});

describe("publisher loop", () => {
  it("drains new work on its poll interval and stops cleanly", async () => {
    const { publisher, relay, clock, enqueue } = await setup({ pollIntervalMs: 250 });
    publisher.start();
    await flush();

    enqueue("t1", 0, "first");
    await advance(clock, 250);
    expect(relay.received.map((event) => event.content)).toEqual(["first"]);

    enqueue("t1", 1, "second");
    await advance(clock, 250);
    expect(relay.received.map((event) => event.content)).toEqual(["first", "second"]);

    await publisher.stop();
    enqueue("t1", 2, "third");
    await advance(clock, 5_000);
    expect(relay.received).toHaveLength(2);
  });
});
