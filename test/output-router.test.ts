import { describe, expect, it } from "vitest";
import { OutputRouter, buildReplyTags, splitMessage, byteLength } from "../src/runtime/output-router.js";
import { createTurnContext, withSteeringInput } from "../src/runtime/turn-context.js";
import { tagsNamed, tagValue } from "../src/nostr/types.js";
import { FakeEventBuilder, FakeOutbox, USER_A_PUBKEY, USER_B_PUBKEY } from "./helpers/fakes.js";

const ROOT = "a".repeat(64);
const TRIGGER = "b".repeat(64);

function context() {
  return createTurnContext({
    turnId: "turn-1",
    channelId: "chan-1",
    threadRootEventId: ROOT,
    primaryTriggerEventId: TRIGGER,
    primaryAuthorPubkey: USER_A_PUBKEY,
    startedAtMs: 1_000,
    primaryCreatedAt: 1,
  });
}

function router(overrides: { maxMessageBytes?: number; oversizePolicy?: "split" | "truncate" | "reject" } = {}) {
  const outbox = new FakeOutbox();
  let notified = 0;
  const instance = new OutputRouter({
    outbox,
    builder: new FakeEventBuilder(),
    config: {
      maxMessageBytes: overrides.maxMessageBytes ?? 16_000,
      oversizePolicy: overrides.oversizePolicy ?? "split",
    },
    now: () => 1_000,
    notify: () => {
      notified += 1;
    },
  });
  return { instance, outbox, notified: () => notified };
}

describe("reply tags", () => {
  it("marks root and reply separately for a nested thread", () => {
    const tags = buildReplyTags(context());
    expect(tags).toContainEqual(["e", ROOT, "", "root"]);
    expect(tags).toContainEqual(["e", TRIGGER, "", "reply"]);
    expect(tags).toContainEqual(["h", "chan-1"]);
  });

  it("uses a single root marker when the trigger is itself the root", () => {
    const top = createTurnContext({
      turnId: "turn-1",
      channelId: "chan-1",
      threadRootEventId: TRIGGER,
      primaryTriggerEventId: TRIGGER,
      primaryAuthorPubkey: USER_A_PUBKEY,
      startedAtMs: 1_000,
      primaryCreatedAt: 1,
    });
    const markers = buildReplyTags(top).filter((tag) => tag[0] === "e");
    expect(markers).toEqual([["e", TRIGGER, "", "root"]]);
  });

  it("deduplicates participants and keeps the anchor after steering", () => {
    let turn = context();
    turn = withSteeringInput(turn, { eventId: "c".repeat(64), authorPubkey: USER_B_PUBKEY, createdAt: 2 });
    turn = withSteeringInput(turn, { eventId: "d".repeat(64), authorPubkey: USER_A_PUBKEY, createdAt: 3 });

    const tags = buildReplyTags(turn);
    const recipients = tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]);
    expect(recipients).toEqual([USER_A_PUBKEY, USER_B_PUBKEY]);
    expect(tags).toContainEqual(["e", TRIGGER, "", "reply"]);
  });
});

describe("turn context immutability", () => {
  it("ignores a duplicate steering input", () => {
    const turn = context();
    const once = withSteeringInput(turn, { eventId: "c".repeat(64), authorPubkey: USER_B_PUBKEY, createdAt: 2 });
    const twice = withSteeringInput(once, { eventId: "c".repeat(64), authorPubkey: USER_B_PUBKEY, createdAt: 2 });
    expect(twice).toBe(once);
    expect(twice.inputs).toHaveLength(2);
  });

  it("never rewrites the reply anchor", () => {
    const turn = withSteeringInput(context(), {
      eventId: "c".repeat(64),
      authorPubkey: USER_B_PUBKEY,
      createdAt: 2,
    });
    expect(turn.primaryTriggerEventId).toBe(TRIGGER);
    expect(turn.threadRootEventId).toBe(ROOT);
  });
});

describe("recording outputs", () => {
  it("records one signed chat event per message", () => {
    const { instance, outbox } = router();
    instance.record(context(), "m1", "hello");
    instance.record(context(), "m2", "world");

    const events = outbox.publishedChatEvents();
    expect(events.map((event) => event.content)).toEqual(["hello", "world"]);
    expect(events.every((event) => tagValue(event, "h") === "chan-1")).toBe(true);
  });

  it("drops empty and whitespace-only messages", () => {
    const { instance, outbox } = router();
    expect(instance.record(context(), "m1", "")).toHaveLength(0);
    expect(instance.record(context(), "m2", "   \n ")).toHaveLength(0);
    expect(outbox.publishedChatEvents()).toHaveLength(0);
  });

  it("is idempotent for the same message, so a replay cannot double-publish", () => {
    const { instance, outbox } = router();
    const first = instance.record(context(), "m1", "hello");
    const replay = instance.record(context(), "m1", "hello");
    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(0);
    expect(outbox.publishedChatEvents()).toHaveLength(1);
  });

  it("signs once and keeps the same event id across retries", () => {
    const { instance, outbox } = router();
    const [recorded] = instance.record(context(), "m1", "hello");
    const stored = outbox.signed.get(recorded!.intent.logicalId);
    expect(stored?.eventId).toBe(recorded!.event.id);
    outbox.markFailed(recorded!.intent.logicalId, "lost OK", 0);
    expect(outbox.signed.get(recorded!.intent.logicalId)?.eventId).toBe(recorded!.event.id);
  });
});

describe("oversize handling", () => {
  const long = `${"x".repeat(400)}\n\n${"y".repeat(400)}\n\n${"z".repeat(400)}`;

  it("splits on paragraph boundaries and preserves every chunk", () => {
    const chunks = splitMessage(long, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(byteLength(chunk)).toBeLessThanOrEqual(500);
    expect(chunks.join("").replace(/\s/g, "")).toBe(long.replace(/\s/g, ""));
  });

  it("keeps split chunks ordered under one turn", () => {
    const { instance, outbox } = router({ maxMessageBytes: 500 });
    const recorded = instance.record(context(), "m1", long);
    expect(recorded.length).toBeGreaterThan(1);
    expect(recorded.map((item) => item.intent.ordinal)).toEqual(
      recorded.map((_, index) => index),
    );
    expect(outbox.publishedChatEvents()).toHaveLength(recorded.length);
  });

  it("gives each chunk a replay-stable logical id", () => {
    const { instance } = router({ maxMessageBytes: 500 });
    const recorded = instance.record(context(), "m1", long);
    expect(recorded.map((item) => item.intent.logicalId)).toEqual(
      recorded.map((_, index) => `turn-1:m1:${index}`),
    );
  });

  it("truncates with a marker when configured to", () => {
    const { instance, outbox } = router({ maxMessageBytes: 500, oversizePolicy: "truncate" });
    instance.record(context(), "m1", long);
    const [event] = outbox.publishedChatEvents();
    expect(outbox.publishedChatEvents()).toHaveLength(1);
    expect(event?.content).toContain("[truncated]");
  });

  it("publishes nothing when configured to reject", () => {
    const { instance, outbox } = router({ maxMessageBytes: 500, oversizePolicy: "reject" });
    expect(instance.record(context(), "m1", long)).toHaveLength(0);
    expect(outbox.publishedChatEvents()).toHaveLength(0);
  });

  it("splits multi-byte text without corrupting code points", () => {
    const emoji = "😀".repeat(200);
    for (const chunk of splitMessage(emoji, 100)) {
      expect(chunk).not.toContain("\uFFFD");
      expect(byteLength(chunk)).toBeLessThanOrEqual(100);
    }
  });
});

describe("publisher notification", () => {
  it("signals the publisher exactly once per recording batch", () => {
    const { instance, notified } = router({ maxMessageBytes: 500 });
    instance.record(context(), "m1", "short");
    expect(notified()).toBe(1);
    instance.record(context(), "m2", "");
    expect(notified()).toBe(1);
  });
});

describe("tag hygiene", () => {
  it("never carries tags over from the triggering event", () => {
    const { instance, outbox } = router();
    instance.record(context(), "m1", "hello");
    const [event] = outbox.publishedChatEvents();
    const names = new Set(event!.tags.map((tag) => tag[0]));
    expect([...names].sort()).toEqual(["e", "h", "p"]);
    expect(tagsNamed(event!, "h")).toHaveLength(1);
  });
});
