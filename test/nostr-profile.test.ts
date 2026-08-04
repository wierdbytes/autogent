import { describe, expect, it } from "vitest";
import { PresencePublisher } from "../src/nostr/presence.js";
import {
  ProfileReconciler,
  agentProfileContent,
  metadataContent,
  profileFingerprint,
  type AgentProfileSnapshot,
} from "../src/nostr/profile.js";
import { RelaySupervisor } from "../src/nostr/relay-supervisor.js";
import { toNostrTag } from "../src/nostr/nip-oa.js";
import { KIND } from "../src/nostr/types.js";
import { FakeClock } from "../src/runtime/clock.js";
import { FakeRelay } from "./helpers/fake-relay.js";
import { advance, flush } from "./helpers/flush.js";
import { createTestIdentity } from "./helpers/identity.js";

const RELAY_URL = "ws://relay.test:3000";

const PROFILE = { name: "Pi Agent", about: "Autonomous Pi SDK agent" };
const SNAPSHOT: AgentProfileSnapshot = {
  status: "online",
  capabilities: ["chat"],
  channels: ["General"],
  channelIds: ["c1"],
};

async function setup() {
  const clock = new FakeClock();
  const identity = createTestIdentity(clock);
  const relay = new FakeRelay();
  // Published events are kept so a second reconcile sees its own work.
  relay.fanOutPublished = true;
  const supervisor = new RelaySupervisor({
    url: RELAY_URL,
    builder: identity.builder,
    clock,
    socketFactory: relay.factory,
    random: () => 0.5,
  });
  await supervisor.connect();
  await flush();
  const reconciler = new ProfileReconciler({
    relay: supervisor,
    builder: identity.builder,
    profile: PROFILE,
  });
  return { clock, identity, relay, supervisor, reconciler };
}

describe("profile fingerprint", () => {
  it("ignores created_at and serialisation order", () => {
    const base = {
      kind: KIND.METADATA,
      content: JSON.stringify({ name: "Pi", about: "x" }),
      tags: [
        ["auth", "a".repeat(64), "", "b".repeat(128)],
        ["client", "pi"],
      ],
    };
    const shuffled = {
      kind: KIND.METADATA,
      content: JSON.stringify({ about: "x", name: "Pi" }),
      tags: [
        ["client", "pi"],
        ["auth", "a".repeat(64), "", "b".repeat(128)],
      ],
    };
    expect(profileFingerprint(base)).toBe(profileFingerprint(shuffled));
    expect(profileFingerprint({ ...base, content: JSON.stringify({ name: "Other", about: "x" }) })).not.toBe(
      profileFingerprint(base),
    );
  });
});

describe("profile content", () => {
  it("keeps kind 0 to the NIP-01 shape", () => {
    expect(JSON.parse(metadataContent(PROFILE))).toEqual({
      name: "Pi Agent",
      about: "Autonomous Pi SDK agent",
    });
    expect(JSON.parse(metadataContent({ ...PROFILE, picture: "https://x/y.png" }))).toMatchObject({
      picture: "https://x/y.png",
    });
  });

  it("carries every field Buzz Desktop's agent roster reads", () => {
    expect(JSON.parse(agentProfileContent(PROFILE, SNAPSHOT))).toMatchObject({
      name: "Pi Agent",
      display_name: "Pi Agent",
      agent_type: "agent",
      status: "online",
      capabilities: ["chat"],
      channels: ["General"],
      channel_ids: ["c1"],
    });
  });
});

describe("profile reconciliation", () => {
  it("publishes kind 0 and kind 10100 when the relay has neither", async () => {
    const { reconciler, relay, identity } = await setup();

    expect(await reconciler.reconcile(SNAPSHOT)).toEqual({
      metadataPublished: true,
      agentProfilePublished: true,
    });

    const kinds = relay.received.map((event) => event.kind);
    expect(kinds).toEqual([KIND.METADATA, KIND.AGENT_PROFILE]);
    for (const event of relay.received) {
      expect(event.pubkey).toBe(identity.agentPubkey);
      expect(event.tags.filter((tag) => tag[0] === "auth")).toHaveLength(1);
    }
  });

  it("stays quiet when the published profile is already current", async () => {
    const { reconciler, relay, clock } = await setup();
    await reconciler.reconcile(SNAPSHOT);
    const published = relay.received.length;

    await advance(clock, 3_600_000);
    expect(await reconciler.reconcile(SNAPSHOT)).toEqual({
      metadataPublished: false,
      agentProfilePublished: false,
    });
    expect(relay.received).toHaveLength(published);
  });

  it("republishes kind 10100 when the roster snapshot drifts", async () => {
    const { reconciler, relay } = await setup();
    await reconciler.reconcile(SNAPSHOT);
    const published = relay.received.length;

    const outcome = await reconciler.reconcile({
      ...SNAPSHOT,
      channels: ["General", "Ops"],
      channelIds: ["c1", "c2"],
    });

    expect(outcome).toEqual({ metadataPublished: false, agentProfilePublished: true });
    expect(relay.received).toHaveLength(published + 1);
    expect(relay.received.at(-1)?.kind).toBe(KIND.AGENT_PROFILE);
  });

  it("republishes a profile that carries no owner attestation", async () => {
    const { reconciler, relay, identity, clock } = await setup();
    relay.store(
      identity.signer.sign({
        pubkey: identity.agentPubkey,
        kind: KIND.METADATA,
        tags: [],
        content: metadataContent(PROFILE),
        created_at: Math.floor(clock.now() / 1000) - 10,
      }),
    );

    const outcome = await reconciler.reconcile(SNAPSHOT);
    expect(outcome.metadataPublished).toBe(true);
  });

  it("republishes a profile attested by the wrong owner", async () => {
    const { reconciler, relay, identity, clock } = await setup();
    const otherOwner = createTestIdentity(clock);
    relay.store(
      identity.signer.sign({
        pubkey: identity.agentPubkey,
        kind: KIND.METADATA,
        tags: [toNostrTag(otherOwner.authTag)],
        content: metadataContent(PROFILE),
        created_at: Math.floor(clock.now() / 1000) - 10,
      }),
    );

    expect((await reconciler.reconcile(SNAPSHOT)).metadataPublished).toBe(true);
  });

  it("surfaces a relay rejection instead of reporting success", async () => {
    const { reconciler, relay } = await setup();
    relay.eventVerdict = () => ({ ok: false, message: "restricted: not your identity" });

    await expect(reconciler.reconcile(SNAPSHOT)).rejects.toThrow(/restricted: not your identity/);
  });
});

describe("presence", () => {
  async function presenceSetup() {
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
    const presence = new PresencePublisher({
      relay: supervisor,
      builder: identity.builder,
      clock,
      heartbeatSec: 60,
    });
    return { clock, relay, presence, identity };
  }

  it("announces online and heartbeats every 60s", async () => {
    const { clock, relay, presence } = await presenceSetup();
    presence.online();
    await flush();

    expect(relay.received).toHaveLength(1);
    expect(relay.received[0]?.kind).toBe(KIND.PRESENCE);
    expect(relay.received[0]?.content).toBe("online");
    // Presence is agent-wide, so it carries no channel tag.
    expect(relay.received[0]?.tags.some((tag) => tag[0] === "h")).toBe(false);

    await advance(clock, 59_999);
    expect(relay.received).toHaveLength(1);
    await advance(clock, 1);
    expect(relay.received).toHaveLength(2);
    await advance(clock, 60_000);
    expect(relay.received).toHaveLength(3);
  });

  it("publishes offline once and stops the heartbeat", async () => {
    const { clock, relay, presence } = await presenceSetup();
    presence.online();
    await flush();

    presence.offline();
    await flush();
    expect(relay.received.at(-1)?.content).toBe("offline");
    expect(presence.status).toBe("offline");

    const total = relay.received.length;
    await advance(clock, 180_000);
    expect(relay.received).toHaveLength(total);
  });

  it("does not wait for an OK, so a silent relay never blocks it", async () => {
    const { relay, presence } = await presenceSetup();
    relay.eventVerdict = () => null;
    presence.online();
    await flush();
    expect(relay.received).toHaveLength(1);
    expect(presence.status).toBe("online");
  });

  it("is dropped rather than queued while the relay is rate limiting", async () => {
    const { relay, presence } = await presenceSetup();
    relay.notice("rate-limited: retry in 10s");
    await flush();

    presence.online();
    await flush();
    expect(relay.received).toHaveLength(0);
  });
});
