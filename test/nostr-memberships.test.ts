import { describe, expect, it } from "vitest";
import type { SubscribeMode } from "../src/config.js";
import {
  CONTROL_SUB_ID,
  MEMBERSHIP_SUB_ID,
  MembershipManager,
  type ChannelInfo,
  channelFilter,
  parseChannelMetadata,
} from "../src/nostr/memberships.js";
import { RelaySupervisor } from "../src/nostr/relay-supervisor.js";
import { KIND, type NostrEvent } from "../src/nostr/types.js";
import { FakeClock } from "../src/runtime/clock.js";
import { FakeRelay } from "./helpers/fake-relay.js";
import { flush } from "./helpers/flush.js";
import {
  createPeer,
  createTestIdentity,
  makeChannelMetadata,
  makeChatEvent,
  makeMembership,
  makeMembershipNotice,
} from "./helpers/identity.js";

const RELAY_URL = "ws://relay.test:3000";

async function setup(options: { mode?: SubscribeMode; allowlist?: string[] } = {}) {
  const clock = new FakeClock();
  const identity = createTestIdentity(clock);
  const relay = new FakeRelay();
  const relayOwner = createPeer();
  const supervisor = new RelaySupervisor({
    url: RELAY_URL,
    builder: identity.builder,
    clock,
    socketFactory: relay.factory,
    random: () => 0.5,
  });
  const messages: Array<{ event: NostrEvent; channel: ChannelInfo }> = [];
  const controls: NostrEvent[] = [];
  const added: ChannelInfo[] = [];
  const removed: string[] = [];
  const manager = new MembershipManager({
    relay: supervisor,
    agentPubkey: identity.agentPubkey,
    subscribeMode: options.mode ?? "mentions",
    channelAllowlist: options.allowlist,
    onMessage: (event, channel) => messages.push({ event, channel }),
    onControl: (event) => controls.push(event),
    onChannelAdded: (channel) => added.push(channel),
    onChannelRemoved: (channelId) => removed.push(channelId),
  });

  await supervisor.connect();
  await flush();
  return {
    clock,
    identity,
    relay,
    relayOwner,
    supervisor,
    manager,
    messages,
    controls,
    added,
    removed,
    watermark: supervisor.startupWatermark,
  };
}

describe("channel metadata", () => {
  it("detects the channel type in priority order", () => {
    const peer = createPeer();
    const at = 1_700_000_000;
    const parse = (markers: string[][]) =>
      parseChannelMetadata(
        makeChannelMetadata(peer.signer, { channelId: "c1", name: "General", markers, created_at: at }),
      );

    expect(parse([])).toMatchObject({ channelId: "c1", name: "General", type: "stream" });
    expect(parse([["t", "public"]])?.type).toBe("stream");
    expect(parse([["private"]])?.type).toBe("private");
    expect(parse([["t", "private"]])?.type).toBe("private");
    expect(parse([["hidden"]])?.type).toBe("dm");
    expect(parse([["t", "dm"]])?.type).toBe("dm");
    // A channel marked both ways is treated as the stricter of the two.
    expect(parse([["private"], ["hidden"]])?.type).toBe("dm");
    expect(parse([["archived", "true"]])?.archived).toBe(true);
  });

  it("rejects events that are not usable channel metadata", () => {
    const peer = createPeer();
    const at = 1_700_000_000;
    expect(parseChannelMetadata(makeChatEvent(peer.signer, { channelId: "c1", created_at: at }))).toBeNull();
    expect(
      parseChannelMetadata(
        peer.signer.sign({
          pubkey: peer.pubkey,
          kind: KIND.CHANNEL_METADATA,
          tags: [["name", "no d tag"]],
          content: "",
          created_at: at,
        }),
      ),
    ).toBeNull();
  });

  it("only narrows to mentions when configured to", () => {
    expect(channelFilter("c1", "agent", "mentions")).toEqual({
      kinds: [KIND.CHAT, KIND.STREAM_REMINDER, KIND.WORKFLOW_APPROVAL_REQUESTED],
      "#h": ["c1"],
      "#p": ["agent"],
    });
    expect(channelFilter("c1", "agent", "all")).toEqual({
      kinds: [KIND.CHAT, KIND.STREAM_REMINDER, KIND.WORKFLOW_APPROVAL_REQUESTED],
      "#h": ["c1"],
    });
  });
});

describe("membership discovery", () => {
  it("opens the notification, control and per-channel subscriptions", async () => {
    const harness = await setup();
    const { relay, relayOwner, identity, manager, watermark } = harness;
    const at = watermark - 100;
    relay.store(
      makeMembership(relayOwner.signer, { channelId: "c1", agentPubkey: identity.agentPubkey, created_at: at }),
      makeMembership(relayOwner.signer, { channelId: "c2", agentPubkey: identity.agentPubkey, created_at: at }),
      makeChannelMetadata(relayOwner.signer, { channelId: "c1", name: "General", created_at: at }),
      makeChannelMetadata(relayOwner.signer, {
        channelId: "c2",
        name: "Secret",
        markers: [["hidden"]],
        created_at: at,
      }),
    );

    await manager.start();
    await flush();

    expect(relay.reqFor(MEMBERSHIP_SUB_ID)[0]?.filters).toEqual([
      {
        kinds: [KIND.MEMBERSHIP_ADDED, KIND.MEMBERSHIP_REMOVED],
        "#p": [identity.agentPubkey],
        since: watermark,
      },
    ]);
    expect(relay.reqFor(CONTROL_SUB_ID)[0]?.filters).toEqual([
      { kinds: [KIND.OBSERVER], "#p": [identity.agentPubkey], since: watermark },
    ]);
    expect(relay.reqFor("ch-c1")[0]?.filters).toEqual([
      {
        kinds: [KIND.CHAT, KIND.STREAM_REMINDER, KIND.WORKFLOW_APPROVAL_REQUESTED],
        "#h": ["c1"],
        "#p": [identity.agentPubkey],
        since: watermark,
      },
    ]);
    expect(manager.channels().map((channel) => [channel.channelId, channel.type])).toEqual([
      ["c1", "stream"],
      ["c2", "dm"],
    ]);
    expect(harness.added.map((channel) => channel.channelId)).toEqual(["c1", "c2"]);
  });

  it("never subscribes to an archived channel", async () => {
    const { relay, relayOwner, identity, manager, watermark } = await setup();
    const at = watermark - 100;
    relay.store(
      makeMembership(relayOwner.signer, { channelId: "c1", agentPubkey: identity.agentPubkey, created_at: at }),
      makeChannelMetadata(relayOwner.signer, {
        channelId: "c1",
        markers: [["archived", "true"]],
        created_at: at,
      }),
    );

    await manager.start();
    await flush();

    expect(relay.reqFor("ch-c1")).toHaveLength(0);
    expect(manager.get("c1")?.archived).toBe(true);
  });

  it("honours the configured channel allowlist", async () => {
    const { relay, relayOwner, identity, manager, watermark } = await setup({ allowlist: ["c2"] });
    const at = watermark - 100;
    relay.store(
      makeMembership(relayOwner.signer, { channelId: "c1", agentPubkey: identity.agentPubkey, created_at: at }),
      makeMembership(relayOwner.signer, { channelId: "c2", agentPubkey: identity.agentPubkey, created_at: at }),
      makeChannelMetadata(relayOwner.signer, { channelId: "c1", created_at: at }),
      makeChannelMetadata(relayOwner.signer, { channelId: "c2", created_at: at }),
    );

    await manager.start();
    await flush();

    expect(manager.channels().map((channel) => channel.channelId)).toEqual(["c2"]);
    expect(relay.reqFor("ch-c1")).toHaveLength(0);
    expect(relay.reqFor("ch-c2")).toHaveLength(1);
  });

  it("routes channel messages with the resolved channel", async () => {
    const harness = await setup();
    const { relay, relayOwner, identity, manager, watermark } = harness;
    const at = watermark - 100;
    const peer = createPeer();
    relay.store(
      makeMembership(relayOwner.signer, { channelId: "c1", agentPubkey: identity.agentPubkey, created_at: at }),
      makeChannelMetadata(relayOwner.signer, { channelId: "c1", name: "General", created_at: at }),
    );
    await manager.start();
    await flush();

    relay.emit(
      makeChatEvent(peer.signer, {
        channelId: "c1",
        mention: identity.agentPubkey,
        content: "ping",
        created_at: watermark + 5,
      }),
    );
    await flush();

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]?.event.content).toBe("ping");
    expect(harness.messages[0]?.channel).toMatchObject({ channelId: "c1", name: "General" });
  });

  it("delivers owner control frames on their own subscription", async () => {
    const harness = await setup();
    const { relay, identity, manager, watermark } = harness;
    await manager.start();
    await flush();

    relay.emit(
      identity.builder.build({
        kind: KIND.OBSERVER,
        tags: [["p", identity.agentPubkey]],
        content: "ciphertext",
        created_at: watermark + 5,
      }),
    );
    await flush();

    expect(harness.controls).toHaveLength(1);
  });
});

describe("unknown metadata", () => {
  it("fails closed to dm and does not cache the guess", async () => {
    const { relay, relayOwner, identity, manager, watermark } = await setup();
    const at = watermark - 100;
    relay.store(
      makeMembership(relayOwner.signer, { channelId: "c1", agentPubkey: identity.agentPubkey, created_at: at }),
    );

    await manager.start();
    await flush();

    expect(manager.get("c1")).toMatchObject({ type: "dm", metadataKnown: false });
    expect(await manager.resolveType("c1")).toBe("dm");
    expect(manager.get("c1")?.metadataKnown).toBe(false);

    // Once the metadata shows up, the channel is reclassified and cached.
    relay.store(makeChannelMetadata(relayOwner.signer, { channelId: "c1", created_at: at }));
    expect(await manager.resolveType("c1")).toBe("stream");
    expect(manager.get("c1")).toMatchObject({ type: "stream", metadataKnown: true });

    const queriesBefore = relay.current.reqs.filter((req) => req.id.startsWith("q")).length;
    expect(await manager.resolveType("c1")).toBe("stream");
    expect(relay.current.reqs.filter((req) => req.id.startsWith("q")).length).toBe(queriesBefore);
  });
});

describe("dynamic membership", () => {
  it("opens a subscription when membership is granted", async () => {
    const harness = await setup();
    const { relay, relayOwner, identity, manager, watermark } = harness;
    await manager.start();
    await flush();
    expect(relay.reqFor("ch-c9")).toHaveLength(0);

    relay.store(
      makeChannelMetadata(relayOwner.signer, { channelId: "c9", name: "New", created_at: watermark }),
    );
    relay.emit(
      makeMembershipNotice(relayOwner.signer, {
        kind: KIND.MEMBERSHIP_ADDED,
        channelId: "c9",
        agentPubkey: identity.agentPubkey,
        created_at: watermark + 1,
      }),
    );
    await flush();

    expect(relay.reqFor("ch-c9")).toHaveLength(1);
    expect(harness.added.map((channel) => channel.channelId)).toEqual(["c9"]);
    expect(manager.get("c9")).toMatchObject({ name: "New", type: "stream" });
  });

  it("closes the subscription when membership is revoked", async () => {
    const harness = await setup();
    const { relay, relayOwner, identity, manager, watermark } = harness;
    const peer = createPeer();
    relay.store(
      makeMembership(relayOwner.signer, {
        channelId: "c1",
        agentPubkey: identity.agentPubkey,
        created_at: watermark - 100,
      }),
      makeChannelMetadata(relayOwner.signer, { channelId: "c1", created_at: watermark - 100 }),
    );
    await manager.start();
    await flush();

    relay.emit(
      makeMembershipNotice(relayOwner.signer, {
        kind: KIND.MEMBERSHIP_REMOVED,
        channelId: "c1",
        agentPubkey: identity.agentPubkey,
        created_at: watermark + 1,
      }),
    );
    await flush();

    expect(harness.removed).toEqual(["c1"]);
    expect(manager.get("c1")).toBeUndefined();
    expect(relay.current.sent).toContainEqual(["CLOSE", "ch-c1"]);

    relay.emit(
      makeChatEvent(peer.signer, {
        channelId: "c1",
        mention: identity.agentPubkey,
        created_at: watermark + 2,
      }),
    );
    await flush();
    expect(harness.messages).toHaveLength(0);
  });

  it("stops every subscription it owns", async () => {
    const { relay, relayOwner, identity, manager, watermark } = await setup();
    relay.store(
      makeMembership(relayOwner.signer, {
        channelId: "c1",
        agentPubkey: identity.agentPubkey,
        created_at: watermark - 100,
      }),
      makeChannelMetadata(relayOwner.signer, { channelId: "c1", created_at: watermark - 100 }),
    );
    await manager.start();
    await flush();

    manager.stop();
    await flush();

    const closed = relay.current.sent
      .filter((frame) => frame[0] === "CLOSE")
      .map((frame) => frame[1]);
    expect(closed).toEqual(expect.arrayContaining(["ch-c1", MEMBERSHIP_SUB_ID, CONTROL_SUB_ID]));
  });
});
