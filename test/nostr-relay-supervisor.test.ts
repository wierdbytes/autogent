import { beforeEach, describe, expect, it } from "vitest";
import { verifyAuthEvent } from "../src/nostr/nip42.js";
import {
  PUBLISH_TIMEOUT_MS,
  RateLimitGate,
  RelaySupervisor,
  isRateLimitedMessage,
  isTerminalHttpStatus,
  isTerminalRelayMessage,
  retryHintMs,
} from "../src/nostr/relay-supervisor.js";
import { KIND, type NostrEvent } from "../src/nostr/types.js";
import { FakeClock } from "../src/runtime/clock.js";
import type { RelayState } from "../src/runtime/ports.js";
import { FakeRelay } from "./helpers/fake-relay.js";
import { advance, flush } from "./helpers/flush.js";
import { createPeer, createTestIdentity, makeChatEvent } from "./helpers/identity.js";

const RELAY_URL = "ws://relay.test:3000";

interface Harness {
  clock: FakeClock;
  relay: FakeRelay;
  supervisor: RelaySupervisor;
  identity: ReturnType<typeof createTestIdentity>;
  terminals: Error[];
  watermark: number;
}

function setup(): Harness {
  const clock = new FakeClock();
  const identity = createTestIdentity(clock);
  const relay = new FakeRelay();
  const terminals: Error[] = [];
  const supervisor = new RelaySupervisor({
    url: RELAY_URL,
    builder: identity.builder,
    clock,
    socketFactory: relay.factory,
    // Mid-range jitter keeps the ladder at its nominal values.
    random: () => 0.5,
    onTerminal: (error) => terminals.push(error),
  });
  return { clock, relay, supervisor, identity, terminals, watermark: supervisor.startupWatermark };
}

let harness: Harness;

beforeEach(() => {
  harness = setup();
});

/** Captures a rejection so the clock can be advanced before it is inspected. */
function capture(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

describe("NIP-42 handshake", () => {
  it("authenticates, then subscribes, then reports ready", async () => {
    const { supervisor, relay, identity, clock } = harness;
    const states: RelayState[] = [];
    supervisor.onStateChange((state) => states.push(state));
    supervisor.subscribe({ id: "ch-a", filters: [{ kinds: [KIND.CHAT], "#h": ["a"] }], onEvent: () => {} });

    await supervisor.connect();
    await flush();

    expect(supervisor.state).toBe("ready");
    expect(states).toEqual(["connecting", "authenticating", "subscribing", "ready"]);

    const authEvent = relay.current.authEvents[0];
    expect(authEvent).toBeDefined();
    expect(
      verifyAuthEvent(authEvent as NostrEvent, {
        relayUrl: RELAY_URL,
        challenge: relay.challenge,
        agentPubkey: identity.agentPubkey,
        now: Math.floor(clock.now() / 1000),
      }),
    ).toEqual({ ok: true });

    const frames = relay.current.sent.map((frame) => frame[0]);
    expect(frames.indexOf("AUTH")).toBeLessThan(frames.indexOf("REQ"));
  });

  it("treats a restricted: rejection as terminal and stops retrying", async () => {
    const { supervisor, relay, clock, terminals } = harness;
    relay.authVerdict = () => ({ ok: false, message: "restricted: agent not provisioned" });

    await expect(supervisor.connect()).rejects.toThrow(/restricted: agent not provisioned/);
    await advance(clock, 120_000);

    expect(relay.connectionCount).toBe(1);
    // `failed`, not `disconnected`: a caller must be able to tell a permanently
    // dead supervisor from one that is merely between reconnect attempts.
    expect(supervisor.state).toBe("failed");
    expect(terminals).toHaveLength(1);
    await expect(supervisor.connect()).rejects.toThrow(/restricted/);
  });

  it("reports the terminal failure to a listener that subscribes afterwards", async () => {
    const { supervisor, relay } = harness;
    relay.authVerdict = () => ({ ok: false, message: "restricted: revoked" });
    await expect(supervisor.connect()).rejects.toThrow(/revoked/);

    const late: Error[] = [];
    supervisor.onTerminal((error) => late.push(error));
    expect(late).toHaveLength(1);
    expect(late[0]?.message).toMatch(/revoked/);
  });

  it("retries a transient error: rejection", async () => {
    const { supervisor, relay, clock } = harness;
    let attempts = 0;
    relay.authVerdict = () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, message: "error: auth backend unavailable" }
        : { ok: true, message: "" };
    };

    const connected = supervisor.connect();
    await flush();
    expect(relay.connectionCount).toBe(1);

    await advance(clock, 1_000);
    await connected;
    expect(relay.connectionCount).toBe(2);
    expect(supervisor.state).toBe("ready");
  });

  it("gives up when the relay opens a socket but never sends a challenge", async () => {
    const { supervisor, relay, clock } = harness;
    relay.sendChallenge = false;
    const rejected = capture(supervisor.connect());
    await flush();

    await advance(clock, 20_000);
    expect(relay.connectionCount).toBe(1);
    await advance(clock, 1_000);
    expect(relay.connectionCount).toBe(2);

    for (const backoff of [2_000, 4_000, 8_000]) {
      await advance(clock, 20_000);
      await advance(clock, backoff);
    }
    expect(relay.connectionCount).toBe(5);

    await advance(clock, 20_000);
    const error = await rejected;
    expect(error.message).toMatch(/relay unreachable after 5 attempts/);
  });
});

describe("reconnect", () => {
  it("re-authenticates and replays every registered subscription", async () => {
    const { supervisor, relay, clock, watermark } = harness;
    const peer = createPeer();
    const received: NostrEvent[] = [];
    supervisor.subscribe({
      id: "ch-a",
      filters: [{ kinds: [KIND.CHAT], "#h": ["a"] }],
      onEvent: (event) => received.push(event),
    });
    supervisor.subscribe({
      id: "membership-notif",
      filters: [{ kinds: [KIND.MEMBERSHIP_ADDED], "#p": [harness.identity.agentPubkey] }],
      onEvent: () => {},
    });
    await supervisor.connect();
    await flush();

    expect(relay.reqFor("ch-a", 0)[0]?.filters).toEqual([
      { kinds: [KIND.CHAT], "#h": ["a"], since: watermark },
    ]);

    const chat = makeChatEvent(peer.signer, { channelId: "a", created_at: watermark + 100 });
    relay.emit(chat);
    await flush();
    expect(received).toHaveLength(1);

    relay.drop();
    await flush();
    expect(supervisor.state).toBe("backing_off");

    await advance(clock, 1_000);
    expect(relay.connectionCount).toBe(2);
    expect(supervisor.state).toBe("ready");
    expect(relay.current.authEvents).toHaveLength(1);

    const frames = relay.current.sent.map((frame) => frame[0]);
    expect(frames.indexOf("AUTH")).toBeLessThan(frames.indexOf("REQ"));
    expect(relay.current.reqs.map((req) => req.id).sort()).toEqual(["ch-a", "membership-notif"]);
    expect(relay.reqFor("ch-a")[0]?.filters[0]?.since).toBe(chat.created_at - 5);
  });

  it("does not re-deliver events replayed inside the overlap window", async () => {
    const { supervisor, relay, clock, watermark } = harness;
    const peer = createPeer();
    const received: NostrEvent[] = [];
    supervisor.subscribe({
      id: "ch-a",
      filters: [{ kinds: [KIND.CHAT], "#h": ["a"] }],
      onEvent: (event) => received.push(event),
    });
    await supervisor.connect();
    await flush();

    relay.emit(makeChatEvent(peer.signer, { channelId: "a", created_at: watermark + 10 }));
    relay.emit(makeChatEvent(peer.signer, { channelId: "a", created_at: watermark + 11 }));
    await flush();
    expect(received).toHaveLength(2);

    relay.drop();
    await advance(clock, 1_000);

    // The new REQ rewinds 5s, so the relay replays both events; the dedup set
    // must absorb them.
    expect(relay.reqFor("ch-a")[0]?.filters[0]?.since).toBe(watermark + 6);
    expect(received).toHaveLength(2);
  });

  it("keeps the startup watermark so the connect window has no blind spot", async () => {
    const { supervisor, relay, watermark } = harness;
    const peer = createPeer();
    const received: NostrEvent[] = [];
    // Published while the agent was still opening its socket.
    relay.store(makeChatEvent(peer.signer, { channelId: "a", created_at: watermark + 2 }));
    relay.store(makeChatEvent(peer.signer, { channelId: "a", created_at: watermark - 60 }));

    supervisor.subscribe({
      id: "ch-a",
      filters: [{ kinds: [KIND.CHAT], "#h": ["a"] }],
      onEvent: (event) => received.push(event),
    });
    await supervisor.connect();
    await flush();

    expect(received.map((event) => event.created_at)).toEqual([watermark + 2]);
  });

  it("re-requests a subscription the relay closed transiently but not permanently", async () => {
    const { supervisor, relay } = harness;
    const closures: string[] = [];
    supervisor.subscribe({
      id: "ch-a",
      filters: [{ kinds: [KIND.CHAT], "#h": ["a"] }],
      onEvent: () => {},
      onClosed: (reason) => closures.push(reason),
    });
    supervisor.subscribe({
      id: "ch-b",
      filters: [{ kinds: [KIND.CHAT], "#h": ["b"] }],
      onEvent: () => {},
    });
    await supervisor.connect();
    await flush();

    relay.closeSubscription("ch-a", "error: shard restarting");
    relay.closeSubscription("ch-b", "blocked: channel is closed");
    await flush();

    expect(closures).toEqual(["error: shard restarting"]);
    expect(relay.reqFor("ch-a")).toHaveLength(2);
    expect(relay.reqFor("ch-b")).toHaveLength(1);
  });

  it("stops delivering after a subscription is closed locally", async () => {
    const { supervisor, relay, watermark } = harness;
    const peer = createPeer();
    const received: NostrEvent[] = [];
    const subscription = supervisor.subscribe({
      id: "ch-a",
      filters: [{ kinds: [KIND.CHAT], "#h": ["a"] }],
      onEvent: (event) => received.push(event),
    });
    await supervisor.connect();
    await flush();

    subscription.close();
    await flush();
    expect(relay.current.sent).toContainEqual(["CLOSE", "ch-a"]);

    relay.emit(makeChatEvent(peer.signer, { channelId: "a", created_at: watermark + 5 }));
    await flush();
    expect(received).toHaveLength(0);
  });
});

describe("backoff", () => {
  it("walks the ladder and gives up after the bounded startup attempts", async () => {
    const { supervisor, relay, clock } = harness;
    relay.handshakeStatus = 503;

    const rejected = capture(supervisor.connect());
    await flush();
    expect(relay.connectionCount).toBe(1);

    await advance(clock, 999);
    expect(relay.connectionCount).toBe(1);
    await advance(clock, 1);
    expect(relay.connectionCount).toBe(2);

    await advance(clock, 2_000);
    expect(relay.connectionCount).toBe(3);
    await advance(clock, 4_000);
    expect(relay.connectionCount).toBe(4);
    await advance(clock, 8_000);
    expect(relay.connectionCount).toBe(5);

    const error = await rejected;
    expect(error.message).toMatch(/relay unreachable after 5 attempts/);
    await advance(clock, 60_000);
    expect(relay.connectionCount).toBe(5);
  });

  it("reconnects without bound once a connection has succeeded", async () => {
    const { supervisor, relay, clock } = harness;
    await supervisor.connect();
    await flush();

    relay.handshakeStatus = 503;
    relay.drop();
    await flush();

    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 16_000].entries()) {
      await advance(clock, delay);
      expect(relay.connectionCount).toBe(2 + index);
    }
  });

  it("resets the ladder after 60s of stable connection", async () => {
    const { supervisor, relay, clock } = harness;
    await supervisor.connect();
    await flush();

    relay.drop();
    await advance(clock, 1_000);
    expect(relay.connectionCount).toBe(2);

    // Second failure inside the stability window escalates to 2s.
    relay.drop();
    await advance(clock, 1_999);
    expect(relay.connectionCount).toBe(2);
    await advance(clock, 1);
    expect(relay.connectionCount).toBe(3);

    await advance(clock, 60_000);
    relay.drop();
    await advance(clock, 999);
    expect(relay.connectionCount).toBe(3);
    await advance(clock, 1);
    expect(relay.connectionCount).toBe(4);
  });

  it("classifies HTTP handshake failures", async () => {
    expect(isTerminalHttpStatus(403)).toBe(true);
    expect(isTerminalHttpStatus(404)).toBe(true);
    expect(isTerminalHttpStatus(408)).toBe(false);
    expect(isTerminalHttpStatus(429)).toBe(false);
    expect(isTerminalHttpStatus(500)).toBe(false);
    expect(isTerminalHttpStatus(503)).toBe(false);

    const { supervisor, relay, clock } = harness;
    relay.handshakeStatus = 403;
    await expect(supervisor.connect()).rejects.toThrow(/HTTP 403/);
    await advance(clock, 60_000);
    expect(relay.connectionCount).toBe(1);
  });

  it("times out a socket that never opens", async () => {
    const { supervisor, relay, clock } = harness;
    relay.stall = true;
    const connected = supervisor.connect();
    await flush();

    await advance(clock, 29_999);
    expect(relay.connectionCount).toBe(1);
    await advance(clock, 1);
    await advance(clock, 1_000);
    expect(relay.connectionCount).toBe(2);

    relay.stall = false;
    await advance(clock, 30_000);
    await advance(clock, 2_000);
    await connected;
    expect(relay.connectionCount).toBe(3);
    expect(supervisor.state).toBe("ready");
  });
});

describe("publish", () => {
  it("classifies relay rejections", async () => {
    const { supervisor, identity } = harness;
    await supervisor.connect();
    await flush();
    const event = identity.builder.build({ kind: KIND.CHAT, tags: [["h", "a"]], content: "hi" });

    harness.relay.eventVerdict = () => ({ ok: true, message: "" });
    expect(await supervisor.publish(event)).toEqual({ ok: true, message: "", terminal: false });

    harness.relay.eventVerdict = () => ({ ok: false, message: "invalid: bad signature" });
    expect(await supervisor.publish(event)).toEqual({
      ok: false,
      message: "invalid: bad signature",
      terminal: true,
    });

    harness.relay.eventVerdict = () => ({ ok: false, message: "error: storage busy" });
    expect(await supervisor.publish(event)).toEqual({
      ok: false,
      message: "error: storage busy",
      terminal: false,
    });
  });

  it("reports a lost OK as a transient failure", async () => {
    const { supervisor, relay, clock, identity } = harness;
    await supervisor.connect();
    await flush();
    relay.eventVerdict = () => null;

    const event = identity.builder.build({ kind: KIND.CHAT, tags: [["h", "a"]], content: "hi" });
    const pending = supervisor.publish(event);
    await flush();
    await advance(clock, PUBLISH_TIMEOUT_MS);

    expect(await pending).toEqual({
      ok: false,
      message: "timeout: relay never acknowledged the event",
      terminal: false,
    });
    expect(relay.received).toHaveLength(1);
  });

  it("fails a publish attempted while disconnected instead of hanging", async () => {
    const { supervisor, relay, clock, identity } = harness;
    await supervisor.connect();
    await flush();
    relay.stall = true;
    relay.drop();
    await flush();

    const event = identity.builder.build({ kind: KIND.CHAT, tags: [["h", "a"]], content: "hi" });
    const pending = supervisor.publish(event);
    await advance(clock, PUBLISH_TIMEOUT_MS);
    expect(await pending).toMatchObject({ ok: false, terminal: false });
  });

  it("ignores an OK from a socket the connect timeout abandoned", async () => {
    const { supervisor, relay, clock, identity } = harness;
    relay.stall = true;
    const connected = supervisor.connect();
    await flush();
    const zombie = relay.current;

    await advance(clock, 30_000);
    relay.stall = false;
    await advance(clock, 1_000);
    await connected;
    expect(relay.connectionCount).toBe(2);

    relay.eventVerdict = () => null;
    const event = identity.builder.build({ kind: KIND.CHAT, tags: [["h", "a"]], content: "hi" });
    const pending = supervisor.publish(event);
    await flush();

    zombie.sendWhileClosing(["OK", event.id, false, "restricted: stale socket"]);
    await flush();
    expect(supervisor.state).toBe("ready");

    await advance(clock, PUBLISH_TIMEOUT_MS);
    expect(await pending).toEqual({
      ok: false,
      message: "timeout: relay never acknowledged the event",
      terminal: false,
    });
  });

  it("drops ephemeral events when the relay is not ready", async () => {
    const { supervisor, relay, identity } = harness;
    const event = identity.builder.build({ kind: KIND.PRESENCE, tags: [], content: "online" });

    supervisor.publishEphemeral(event);
    expect(relay.connections).toHaveLength(0);

    await supervisor.connect();
    await flush();
    supervisor.publishEphemeral(event);
    await flush();
    expect(relay.received).toHaveLength(1);
  });
});

describe("rate limiting", () => {
  it("parks REQs and drains them at 125ms spacing", async () => {
    const { supervisor, relay, clock } = harness;
    await supervisor.connect();
    await flush();
    const before = relay.current.reqs.length;

    relay.notice("rate-limited: too many subscriptions, retry in 5s");
    await flush();

    for (const id of ["s1", "s2", "s3"]) {
      supervisor.subscribe({ id, filters: [{ kinds: [KIND.CHAT], "#h": [id] }], onEvent: () => {} });
    }
    await flush();
    expect(relay.current.reqs.length).toBe(before);

    await advance(clock, 4_999);
    expect(relay.current.reqs.length).toBe(before);
    await advance(clock, 1);
    expect(relay.current.reqs.length).toBe(before + 1);

    await advance(clock, 124);
    expect(relay.current.reqs.length).toBe(before + 1);
    await advance(clock, 1);
    expect(relay.current.reqs.length).toBe(before + 2);

    await advance(clock, 125);
    expect(relay.current.reqs.length).toBe(before + 3);
    expect(relay.current.reqs.slice(before).map((req) => req.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("drops ephemeral publishes while gated but preserves durable order", async () => {
    const { supervisor, relay, clock, identity } = harness;
    await supervisor.connect();
    await flush();

    relay.notice("rate-limited: retry in 5s");
    await flush();

    supervisor.publishEphemeral(
      identity.builder.build({ kind: KIND.PRESENCE, tags: [], content: "online" }),
    );
    await flush();
    expect(relay.received).toHaveLength(0);

    const events = [1, 2, 3].map((n) =>
      identity.builder.build({ kind: KIND.CHAT, tags: [["h", "a"]], content: `m${n}` }),
    );
    const results = (async () => {
      const collected = [];
      for (const event of events) collected.push(await supervisor.publish(event));
      return collected;
    })();
    await flush();
    expect(relay.received).toHaveLength(0);

    await advance(clock, 5_000);
    expect((await results).every((result) => result.ok)).toBe(true);
    expect(relay.received.map((event) => event.content)).toEqual(["m1", "m2", "m3"]);
  });

  it("never shortens an armed deadline", () => {
    const clock = new FakeClock();
    const gate = new RateLimitGate(clock);

    expect(gate.arm("NOTICE: everything is fine")).toBe(false);
    expect(gate.arm("rate-limited: slow down")).toBe(true);
    expect(gate.deadline).toBe(clock.now() + 5_000);

    gate.arm("rate-limited: retry in 30s");
    expect(gate.deadline).toBe(clock.now() + 30_000);
    gate.arm("rate-limited: retry in 5s");
    expect(gate.deadline).toBe(clock.now() + 30_000);
  });

  it("clamps short retry hints up to the default", () => {
    const clock = new FakeClock();
    expect(retryHintMs("rate-limited: retry in 12s")).toBe(12_000);
    expect(retryHintMs("rate-limited: slow down")).toBeNull();

    const gate = new RateLimitGate(clock);
    gate.arm("rate-limited: retry in 1s");
    expect(gate.deadline).toBe(clock.now() + 5_000);

    const other = new RateLimitGate(clock);
    other.arm("rate-limited: retry in 3s");
    expect(other.deadline).toBe(clock.now() + 3_000);
  });
});

describe("query", () => {
  it("collects until EOSE and closes the subscription", async () => {
    const { supervisor, relay, identity, watermark } = harness;
    const peer = createPeer();
    relay.store(
      makeChatEvent(peer.signer, { channelId: "a", created_at: watermark - 5 }),
      identity.builder.build({ kind: KIND.METADATA, tags: [], content: "{}" }),
    );
    await supervisor.connect();
    await flush();

    const events = await supervisor.query([{ kinds: [KIND.METADATA] }]);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe(KIND.METADATA);
    expect(relay.current.sent.filter((frame) => frame[0] === "CLOSE")).toHaveLength(1);
  });

  it("returns what it has when the relay never sends EOSE", async () => {
    const { supervisor, relay, clock, identity } = harness;
    relay.autoEose = false;
    relay.store(identity.builder.build({ kind: KIND.METADATA, tags: [], content: "{}" }));
    await supervisor.connect();
    await flush();

    const pending = supervisor.query([{ kinds: [KIND.METADATA] }], 5_000);
    await flush();
    await advance(clock, 5_000);
    expect(await pending).toHaveLength(1);
  });
});

describe("message classification", () => {
  it("treats provisioning failures as terminal and everything else as transient", () => {
    for (const message of [
      "invalid: bad signature",
      "auth-required: we only accept authenticated users",
      "restricted: not allowed to publish",
      "blocked: pubkey is banned",
      "INVALID: uppercase counts too",
    ]) {
      expect(isTerminalRelayMessage(message)).toBe(true);
    }
    for (const message of ["error: could not connect to the database", "rate-limited: slow down", ""]) {
      expect(isTerminalRelayMessage(message)).toBe(false);
    }

    expect(isRateLimitedMessage("rate-limited: retry in 5s")).toBe(true);
    expect(isRateLimitedMessage("error: rate-limited: retry in 5s")).toBe(true);
    expect(isRateLimitedMessage("error: storage busy")).toBe(false);
  });
});

describe("shutdown", () => {
  it("stops reconnecting once closed", async () => {
    const { supervisor, relay, clock } = harness;
    await supervisor.connect();
    await flush();

    await supervisor.close();
    expect(supervisor.state).toBe("disconnected");

    await advance(clock, 120_000);
    expect(relay.connectionCount).toBe(1);
  });
});
