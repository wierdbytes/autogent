import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { AppRuntime } from "../src/runtime/app-runtime.js";
import { defaultConfig, type AgentConfig } from "../src/config.js";
import { createSigner } from "../src/nostr/signer.js";
import { signAttestation } from "../src/nostr/nip-oa.js";
import { KIND, tagValue, tagsNamed, type NostrEvent, type NostrTag } from "../src/nostr/types.js";
import { openInMemoryDatabase, type AgentState } from "../src/state/database.js";
import { nullLogger } from "../src/runtime/logger.js";
import { systemClock } from "../src/runtime/clock.js";
import { FakeRelayPort } from "./helpers/fake-relay-port.js";
import { FakeSession } from "./helpers/fakes.js";

const CHANNEL = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Waits for pending microtasks and timers to settle. */
async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function channelMetadataEvent(secret: Uint8Array, type: "stream" | "dm"): NostrEvent {
  const tags: NostrTag[] = [
    ["d", CHANNEL],
    ["name", "general"],
  ];
  if (type === "dm") tags.push(["t", "dm"]);
  return finalizeEvent(
    { kind: KIND.CHANNEL_METADATA, created_at: 1_700_000_000, tags, content: "" },
    secret,
  ) as NostrEvent;
}

function membershipNotice(
  secret: Uint8Array,
  kind: number,
  channelId: string,
  agentPubkey: string,
): NostrEvent {
  return finalizeEvent(
    {
      kind,
      created_at: 1_700_000_100,
      tags: [
        ["p", agentPubkey],
        ["h", channelId],
      ],
      content: "",
    },
    secret,
  ) as NostrEvent;
}

/** The channel set as the newest published kind 10100 describes it. */
function rosterChannelIds(relay: FakeRelayPort): string[] {
  const roster = relay.published.filter((event) => event.kind === KIND.AGENT_PROFILE).at(-1);
  expect(roster).toBeDefined();
  return JSON.parse((roster as NostrEvent).content).channel_ids as string[];
}

function membershipEvent(secret: Uint8Array, agentPubkey: string): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND.CHANNEL_MEMBER,
      created_at: 1_700_000_000,
      tags: [
        ["d", CHANNEL],
        ["p", agentPubkey],
      ],
      content: "",
    },
    secret,
  ) as NostrEvent;
}

interface Harness {
  runtime: AppRuntime;
  relay: FakeRelayPort;
  state: AgentState;
  session: FakeSession;
  ownerPubkey: string;
  ownerSecret: Uint8Array;
  agentPubkey: string;
  chatFrom(secret: Uint8Array, content: string, extraTags?: NostrTag[]): NostrEvent;
}

async function boot(overrides: Partial<AgentConfig> = {}): Promise<Harness> {
  const agentSecret = generateSecretKey();
  const signer = createSigner(agentSecret);
  const ownerSecret = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerSecret);
  const authTag = signAttestation(ownerSecret, signer.publicKey, "");

  const relayOperator = generateSecretKey();
  const relay = new FakeRelayPort();
  relay.queryResponders.push((filters) => {
    const kinds = filters[0]?.kinds ?? [];
    if (kinds.includes(KIND.CHANNEL_MEMBER)) return [membershipEvent(relayOperator, signer.publicKey)];
    if (kinds.includes(KIND.CHANNEL_METADATA)) return [channelMetadataEvent(relayOperator, "stream")];
    return [];
  });
  relay.queryResponders.push(() => []);

  const state = openInMemoryDatabase();
  const session = new FakeSession("session-int");

  const config: AgentConfig = {
    ...defaultConfig(),
    relayId: "test",
    security: { ...defaultConfig().security, respondTo: "anyone" },
    presence: { enabled: false, heartbeatSec: 60 },
    scheduler: { ...defaultConfig().scheduler, contextMessageLimit: 0 },
    ...overrides,
  };

  const runtime = new AppRuntime({
    config,
    signer,
    ownerPubkey,
    authTag,
    logger: nullLogger,
    clock: systemClock,
    relay,
    state,
    // A scripted session stands in for the SDK: this test covers the wiring
    // between relay, gate, actor and outbox, not Pi itself.
    sessions: {
      acquire: async () => session,
      release: async () => {},
      releaseForChannel: async () => {},
      disposeAll: async () => {},
    },
  });

  await runtime.start();
  await settle();

  return {
    runtime,
    relay,
    state,
    session,
    ownerPubkey,
    ownerSecret,
    agentPubkey: signer.publicKey,
    chatFrom(secret, content, extraTags = []) {
      return finalizeEvent(
        {
          kind: KIND.CHAT,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["h", CHANNEL], ["p", signer.publicKey], ...extraTags],
          content,
        },
        secret,
      ) as NostrEvent;
    },
  };
}

describe("boot sequence", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await boot();
  });

  afterEach(async () => {
    await harness.runtime.stop("test");
  });

  it("reaches running and publishes its profile before going live", () => {
    expect(harness.runtime.phase).toBe("running");
    const kinds = harness.relay.published.map((event) => event.kind);
    expect(kinds).toContain(KIND.METADATA);
    // Desktop's roster comes from kind 10100; kind 0 alone would leave the
    // agent invisible in the stock UI.
    expect(kinds).toContain(KIND.AGENT_PROFILE);
  });

  it("carries exactly one NIP-OA auth tag on every published event", () => {
    expect(harness.relay.published.length).toBeGreaterThan(0);
    for (const event of harness.relay.published) {
      expect(tagsNamed(event, "auth")).toHaveLength(1);
    }
  });

  it("subscribes to the discovered channel, membership changes and control frames", () => {
    const ids = [...harness.relay.subscriptions.keys()];
    expect(ids).toContain(`ch-${CHANNEL}`);
    expect(ids).toContain("membership-notif");
    expect(ids).toContain("agent-observer-control");
  });

  it("stops cleanly and closes its subscriptions", async () => {
    await harness.runtime.stop("test");
    expect(harness.runtime.phase).toBe("stopped");
    expect(harness.relay.subscriptions.size).toBe(0);
  });
});

describe("inbound gating", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await boot();
  });

  afterEach(async () => {
    await harness.runtime.stop("test");
  });

  it("ignores its own events, so it cannot answer itself", async () => {
    const selfEvent = harness.relay.published[0];
    expect(selfEvent).toBeDefined();
    harness.relay.deliver(selfEvent as NostrEvent);
    await settle();
    expect(harness.state.inbox.get((selfEvent as NostrEvent).id)).toBeUndefined();
  });

  it("records an accepted message once, even when the relay replays it", async () => {
    const event = harness.chatFrom(generateSecretKey(), "@agent hello");
    harness.relay.deliver(event);
    harness.relay.deliver(event);
    await settle();

    const stored = harness.state.inbox.get(event.id);
    expect(stored).toBeDefined();
    expect(stored?.channelId).toBe(CHANNEL);
  });

  it("rejects an event whose signature does not verify", async () => {
    const event = harness.chatFrom(generateSecretKey(), "forged");
    // Round-tripped through JSON, exactly as an event arrives off the wire, so
    // no library-side verification cache can travel with it.
    const forged = JSON.parse(
      JSON.stringify({ ...event, content: "tampered after signing" }),
    ) as NostrEvent;
    harness.relay.deliver(forged);
    await settle();
    expect(harness.state.inbox.get(forged.id)).toBeUndefined();
  });

  it("rejects an event whose id does not match its content", async () => {
    const event = harness.chatFrom(generateSecretKey(), "original");
    const rewritten: NostrEvent = { ...event, content: "swapped" };
    harness.relay.deliver(rewritten);
    await settle();
    expect(harness.state.inbox.get(rewritten.id)).toBeUndefined();
  });

  it("refuses a non-owner when respondTo is owner-only", async () => {
    await harness.runtime.stop("test");
    harness = await boot({
      security: { ...defaultConfig().security, respondTo: "owner-only" },
    });

    const event = harness.chatFrom(generateSecretKey(), "let me in");
    harness.relay.deliver(event);
    await settle();

    expect(harness.state.inbox.get(event.id)?.disposition).toBe("rejected");
  });

  it("accepts the owner when respondTo is owner-only", async () => {
    await harness.runtime.stop("test");
    harness = await boot({
      security: { ...defaultConfig().security, respondTo: "owner-only" },
    });

    const event = harness.chatFrom(harness.ownerSecret, "do the thing");
    harness.relay.deliver(event);
    await settle();

    expect(harness.state.inbox.get(event.id)?.disposition).not.toBe("rejected");
  });
});

describe("owner controls", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await boot();
  });

  afterEach(async () => {
    await harness.runtime.stop("test");
  });

  it("shuts down on an owner !shutdown, and ignores it from anyone else", async () => {
    const impostor = harness.chatFrom(generateSecretKey(), "!shutdown");
    harness.relay.deliver(impostor);
    await settle();
    expect(harness.runtime.phase).toBe("running");

    harness.relay.deliver(harness.chatFrom(harness.ownerSecret, "!shutdown"));
    await settle();
    expect(harness.runtime.phase).toBe("stopped");
  });

  it("shuts down when the relay fails terminally", async () => {
    harness.relay.failTerminally(new Error("restricted: attestation revoked"));
    await settle();
    expect(harness.runtime.phase).toBe("stopped");
  });
});

describe("telemetry routing", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await boot();
  });

  afterEach(async () => {
    await harness.runtime.stop("test");
  });

  it("encrypts observer frames to the owner alone", async () => {
    harness.relay.deliver(harness.chatFrom(harness.ownerSecret, "hello"));
    await settle();

    const frames = harness.relay.ephemeral.filter((event) => event.kind === KIND.OBSERVER);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(tagValue(frame, "p")).toBe(harness.ownerPubkey);
      expect(tagValue(frame, "agent")).toBe(harness.agentPubkey);
      expect(tagValue(frame, "frame")).toBe("telemetry");
      expect(frame.content).not.toContain("hello");
    }
  });
});

describe("end to end", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await boot();
  });

  afterEach(async () => {
    await harness.runtime.stop("test");
  });

  it("carries a mention all the way to a published reply anchored on the user", async () => {
    const userSecret = generateSecretKey();
    const trigger = harness.chatFrom(userSecret, "@agent what is the status?");
    harness.relay.deliver(trigger);
    await settle();

    expect(harness.session.prompts).toHaveLength(1);
    expect(harness.session.prompts[0]).toContain("Content:\n@agent what is the status?");

    harness.session.emitAssistantMessage("m1", "All green.");
    harness.session.emit({ type: "agent_settled" });
    await settle(40);

    const replies = harness.relay.published.filter(
      (event) => event.kind === KIND.CHAT && event.content === "All green.",
    );
    expect(replies).toHaveLength(1);

    const reply = replies[0] as NostrEvent;
    expect(tagValue(reply, "h")).toBe(CHANNEL);
    expect(reply.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1]).toBe(trigger.id);
    expect(tagsNamed(reply, "p").map((tag) => tag[1])).toEqual([getPublicKey(userSecret)]);
    expect(tagsNamed(reply, "auth")).toHaveLength(1);
  });

  it("publishes an encrypted usage metric once the turn settles", async () => {
    harness.relay.deliver(harness.chatFrom(harness.ownerSecret, "go"));
    await settle();

    harness.session.emit({
      type: "message_end",
      messageId: "m1",
      role: "assistant",
      text: "done",
      usage: { input: 100, output: 20, total: 120, cacheRead: null, cacheWrite: null, costUsd: 0.01 },
    });
    harness.session.emit({ type: "agent_settled" });
    await settle(40);

    const metrics = harness.relay.published.filter((event) => event.kind === KIND.USAGE_METRIC);
    expect(metrics).toHaveLength(1);

    const metric = metrics[0] as NostrEvent;
    expect(tagValue(metric, "p")).toBe(harness.ownerPubkey);
    // The channel must not be inferable from the tags: it lives inside the
    // encrypted payload so per-channel activity rates do not leak.
    expect(tagValue(metric, "h")).toBeUndefined();
    expect(metric.content).not.toContain("done");
  });

  it("stores one signed event whose id survives a failed publish", async () => {
    // Retry *timing* is covered against a fake clock in the publisher's own
    // tests; what matters here is that a failure never mints a second event id,
    // which is what makes relay-side dedup give us effectively-once delivery.
    harness.relay.publishVerdict = (event) =>
      event.kind === KIND.CHAT
        ? { ok: false, message: "error: relay busy", terminal: false }
        : { ok: true, message: "", terminal: false };

    harness.relay.deliver(harness.chatFrom(harness.ownerSecret, "go"));
    await settle();
    harness.session.emitAssistantMessage("m1", "retried reply");
    await settle(40);

    const chat = harness.state.outbox
      .duePublishes(Number.MAX_SAFE_INTEGER)
      .filter((record) => record.kind === KIND.CHAT);
    expect(chat).toHaveLength(1);

    const record = chat[0];
    expect(record?.state).not.toBe("published");
    expect(record?.attempts).toBeGreaterThan(0);
    expect(record?.signedEvent.id).toBe(record?.eventId);
    expect(record?.signedEvent.content).toBe("retried reply");

    harness.relay.publishVerdict = () => ({ ok: true, message: "", terminal: false });
  });
});

describe("roster entry", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await boot();
  });

  afterEach(async () => {
    await harness.runtime.stop("test");
  });

  // Desktop reads `channel_ids` out of this event and refuses to stop an agent
  // it believes is in no channel — Stop for a provider-deployed agent is a
  // `!shutdown` message that needs a channel to go to.
  it("publishes the discovered channel set once boot completes", () => {
    expect(rosterChannelIds(harness.relay)).toEqual([CHANNEL]);
  });

  it("republishes the roster when a membership is granted", async () => {
    const granted = "11111111-2222-3333-4444-555555555555";
    harness.relay.deliver(
      membershipNotice(generateSecretKey(), KIND.MEMBERSHIP_ADDED, granted, harness.agentPubkey),
    );
    await settle();

    expect(rosterChannelIds(harness.relay)).toEqual([granted, CHANNEL].sort());
  });

  it("republishes the roster when a membership is revoked", async () => {
    harness.relay.deliver(
      membershipNotice(generateSecretKey(), KIND.MEMBERSHIP_REMOVED, CHANNEL, harness.agentPubkey),
    );
    await settle();

    expect(rosterChannelIds(harness.relay)).toEqual([]);
  });

  it("does not republish when a grant repeats a channel it already has", async () => {
    const before = harness.relay.published.filter(
      (event) => event.kind === KIND.AGENT_PROFILE,
    ).length;

    harness.relay.deliver(
      membershipNotice(generateSecretKey(), KIND.MEMBERSHIP_ADDED, CHANNEL, harness.agentPubkey),
    );
    await settle();

    const after = harness.relay.published.filter(
      (event) => event.kind === KIND.AGENT_PROFILE,
    ).length;
    expect(after).toBe(before);
  });
});

describe("roster farewell", () => {
  it("leaves the roster saying offline, with its channels intact", async () => {
    const harness = await boot();
    await harness.runtime.stop("test");

    const roster = harness.relay.published
      .filter((event) => event.kind === KIND.AGENT_PROFILE)
      .at(-1);
    expect(roster).toBeDefined();

    const content = JSON.parse((roster as NostrEvent).content);
    // Offline, but still findable: Desktop needs the channel to send `!shutdown`
    // to, and it reads that from the last entry the relay kept.
    expect(content.status).toBe("offline");
    expect(content.channel_ids).toEqual([CHANNEL]);
  });

  it("stops cleanly even when the relay refuses the farewell", async () => {
    const harness = await boot();
    harness.relay.publishVerdict = (event) =>
      event.kind === KIND.AGENT_PROFILE
        ? { ok: false, message: "error: no", terminal: false }
        : { ok: true, message: "", terminal: false };

    await harness.runtime.stop("test");
    expect(harness.runtime.phase).toBe("stopped");
  });
});
