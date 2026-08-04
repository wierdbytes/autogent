import { describe, expect, it } from "vitest";
import {
  REPLAY_SKEW_SEC,
  SEEN_ROTATE_AT,
  SeenEventIds,
  SubscriptionRegistry,
} from "../src/nostr/subscriptions.js";
import { KIND, type NostrEvent } from "../src/nostr/types.js";
import { createPeer, makeChatEvent } from "./helpers/identity.js";

const WATERMARK = 1_700_000_000;

function registry(): SubscriptionRegistry {
  return new SubscriptionRegistry(WATERMARK);
}

describe("seen-id set", () => {
  it("rejects a repeat and keeps two generations", () => {
    const seen = new SeenEventIds(4);
    expect(seen.admit("a")).toBe(true);
    expect(seen.admit("a")).toBe(false);
    expect(seen.has("a")).toBe(true);

    seen.admit("b");
    seen.admit("c");
    // The fourth entry rotates the live generation into the previous one.
    seen.admit("d");
    expect(seen.size).toBe(4);
    expect(seen.admit("a")).toBe(false);

    seen.admit("e");
    seen.admit("f");
    seen.admit("g");
    seen.admit("h");
    // "a".."d" have now been evicted with the older generation.
    expect(seen.size).toBe(4);
    expect(seen.admit("a")).toBe(true);
  });

  it("bounds itself at twice the rotation threshold", () => {
    const seen = new SeenEventIds(SEEN_ROTATE_AT);
    for (let index = 0; index < SEEN_ROTATE_AT * 3; index += 1) seen.admit(`id-${index}`);
    expect(seen.size).toBeLessThanOrEqual(SEEN_ROTATE_AT * 2);
  });
});

describe("replay floor", () => {
  it("starts at the startup watermark and ignores a caller-supplied since", () => {
    const subscriptions = registry();
    const record = subscriptions.add({
      id: "ch-a",
      filters: [{ kinds: [KIND.CHAT], "#h": ["a"], since: 1 }],
      onEvent: () => {},
    });
    expect(subscriptions.filtersFor(record)).toEqual([
      { kinds: [KIND.CHAT], "#h": ["a"], since: WATERMARK },
    ]);
  });

  it("rewinds by the skew tolerance once events have been delivered", () => {
    const peer = createPeer();
    const subscriptions = registry();
    const record = subscriptions.add({ id: "ch-a", filters: [{ kinds: [KIND.CHAT] }], onEvent: () => {} });

    subscriptions.deliver("ch-a", makeChatEvent(peer.signer, { channelId: "a", created_at: WATERMARK + 40 }));
    subscriptions.deliver("ch-a", makeChatEvent(peer.signer, { channelId: "a", created_at: WATERMARK + 20 }));

    expect(record.lastSeen).toBe(WATERMARK + 40);
    expect(record.since(WATERMARK)).toBe(WATERMARK + 40 - REPLAY_SKEW_SEC);
  });

  it("rewinds to the oldest dropped event and clears the gap on EOSE", () => {
    const peer = createPeer();
    const subscriptions = registry();
    const record = subscriptions.add({
      id: "ch-a",
      filters: [{ kinds: [KIND.CHAT] }],
      onEvent: (event) => {
        if (event.created_at === WATERMARK + 30) throw new Error("consumer rejected the event");
      },
    });

    subscriptions.deliver("ch-a", makeChatEvent(peer.signer, { channelId: "a", created_at: WATERMARK + 50 }));
    expect(() =>
      subscriptions.deliver("ch-a", makeChatEvent(peer.signer, { channelId: "a", created_at: WATERMARK + 30 })),
    ).toThrow(/consumer rejected/);

    expect(record.since(WATERMARK)).toBe(WATERMARK + 30);

    record.noteReplayComplete();
    expect(record.since(WATERMARK)).toBe(WATERMARK + 50 - REPLAY_SKEW_SEC);
  });
});

describe("registry delivery", () => {
  it("delivers once per event id across reconnect replays", () => {
    const peer = createPeer();
    const subscriptions = registry();
    const received: NostrEvent[] = [];
    subscriptions.add({
      id: "ch-a",
      filters: [{ kinds: [KIND.CHAT] }],
      onEvent: (event) => received.push(event),
    });

    const event = makeChatEvent(peer.signer, { channelId: "a", created_at: WATERMARK + 1 });
    expect(subscriptions.deliver("ch-a", event)).toBe(true);
    expect(subscriptions.deliver("ch-a", event)).toBe(false);
    expect(received).toHaveLength(1);
  });

  it("ignores events for a subscription that was removed", () => {
    const peer = createPeer();
    const subscriptions = registry();
    let calls = 0;
    subscriptions.add({ id: "ch-a", filters: [{ kinds: [KIND.CHAT] }], onEvent: () => (calls += 1) });
    subscriptions.remove("ch-a");

    const event = makeChatEvent(peer.signer, { channelId: "a", created_at: WATERMARK + 1 });
    expect(subscriptions.deliver("ch-a", event)).toBe(false);
    expect(calls).toBe(0);
  });
});
