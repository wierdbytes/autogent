/**
 * Remote (engram-configured) runtime behaviour: degraded fail-closed mode,
 * hot core-config application and provider-auth updates (remote plan §3, §6.2).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { defaultConfig, type AgentConfig } from "../src/config.js";
import { EngramClient } from "../src/nostr/engram-client.js";
import { createEventBuilder } from "../src/nostr/event-builder.js";
import {
  CORE_SLUG,
  PROVIDER_AUTH_SLUG,
  deriveEngramDTag,
} from "../src/nostr/nip-ae.js";
import { signAttestation } from "../src/nostr/nip-oa.js";
import { createSigner, type Signer } from "../src/nostr/signer.js";
import { KIND, type NostrEvent, type NostrTag } from "../src/nostr/types.js";
import { AppRuntime } from "../src/runtime/app-runtime.js";
import { systemClock } from "../src/runtime/clock.js";
import { nullLogger } from "../src/runtime/logger.js";
import { readLocalAuth } from "../src/runtime/provider-auth.js";
import { openInMemoryDatabase, type AgentState } from "../src/state/database.js";
import { FakeRelayPort } from "./helpers/fake-relay-port.js";
import { FakeSession } from "./helpers/fakes.js";

const CHANNEL = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Polls until `predicate` holds. The engram handlers run real fs I/O, whose
 * completion is not bounded by a fixed number of microtask rounds.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface RemoteHarness {
  runtime: AppRuntime;
  relay: FakeRelayPort;
  state: AgentState;
  signer: Signer;
  agentSecret: Uint8Array;
  ownerPubkey: string;
  stateDir: string;
  engramEvent(slug: string, body: unknown, createdAt: number): NostrEvent;
  chatFrom(secret: Uint8Array, content: string): NostrEvent;
}

async function bootRemote(options: {
  missing?: { core: boolean; providerAuth: boolean };
  config?: Partial<AgentConfig>;
}): Promise<RemoteHarness> {
  const agentSecret = generateSecretKey();
  const signer = createSigner(new Uint8Array(agentSecret));
  const ownerSecret = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerSecret);
  const authTag = signAttestation(ownerSecret, signer.publicKey, "");
  const stateDir = mkdtempSync(join(tmpdir(), "autogent-remote-"));

  const relayOperator = generateSecretKey();
  const relay = new FakeRelayPort();
  relay.queryResponders.push((filters) => {
    const kinds = filters[0]?.kinds ?? [];
    if (kinds.includes(KIND.CHANNEL_MEMBER)) {
      return [
        finalizeEvent(
          {
            kind: KIND.CHANNEL_MEMBER,
            created_at: 1_700_000_000,
            tags: [
              ["d", CHANNEL],
              ["p", signer.publicKey],
            ],
            content: "",
          },
          relayOperator,
        ) as NostrEvent,
      ];
    }
    if (kinds.includes(KIND.CHANNEL_METADATA)) {
      return [
        finalizeEvent(
          {
            kind: KIND.CHANNEL_METADATA,
            created_at: 1_700_000_000,
            tags: [
              ["d", CHANNEL],
              ["name", "general"],
            ] as NostrTag[],
            content: "",
          },
          relayOperator,
        ) as NostrEvent,
      ];
    }
    return [];
  });
  relay.queryResponders.push(() => []);

  const state = openInMemoryDatabase();
  const session = new FakeSession("session-remote");
  const builder = createEventBuilder({ signer, authTag, clock: systemClock });
  const engrams = new EngramClient({ relay, signer, builder, clock: systemClock });

  const baseConfig: AgentConfig = {
    ...defaultConfig(),
    relayId: "test",
    stateDir,
    security: { ...defaultConfig().security, respondTo: "anyone" },
    presence: { enabled: true, heartbeatSec: 3600 },
    scheduler: { ...defaultConfig().scheduler, contextMessageLimit: 0 },
    remote: { engramConfig: true },
    ...options.config,
  };

  const runtime = new AppRuntime({
    config: baseConfig,
    signer,
    ownerPubkey,
    authTag,
    logger: nullLogger,
    clock: systemClock,
    relay,
    state,
    sessions: {
      acquire: async () => session,
      release: async () => {},
      rotate: async () => session,
      disposeAll: async () => {},
    },
    remote: {
      engrams,
      baseConfig,
      missing: options.missing ?? { core: false, providerAuth: false },
      coreHeadCreatedAt: 0,
      authHeadCreatedAt: 0,
    },
  });

  await runtime.start();
  await settle();

  return {
    runtime,
    relay,
    state,
    signer,
    agentSecret,
    ownerPubkey,
    stateDir,
    engramEvent(slug, body, createdAt) {
      return finalizeEvent(
        {
          kind: KIND.ENGRAM,
          created_at: createdAt,
          tags: [
            ["d", deriveEngramDTag(signer, ownerPubkey, slug)],
            ["p", ownerPubkey],
          ],
          content: signer.encrypt(ownerPubkey, JSON.stringify(body)),
        },
        agentSecret,
      ) as NostrEvent;
    },
    chatFrom(secret, content) {
      return finalizeEvent(
        {
          kind: KIND.CHAT,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["h", CHANNEL],
            ["p", signer.publicKey],
          ],
          content,
        },
        secret,
      ) as NostrEvent;
    },
  };
}

describe("degraded mode", () => {
  let harness: RemoteHarness;

  afterEach(async () => {
    await harness.runtime.stop("test");
    rmSync(harness.stateDir, { recursive: true, force: true });
  });

  it("publishes degraded presence and refuses prompts while heads are missing", async () => {
    harness = await bootRemote({ missing: { core: true, providerAuth: true } });
    expect(harness.runtime.degraded).toBe(true);
    expect(harness.relay.ephemeral.at(-1)?.content).toBe("degraded");

    const event = harness.chatFrom(generateSecretKey(), "hello?");
    harness.relay.deliver(event);
    await settle();
    expect(harness.state.inbox.get(event.id)?.disposition).toBe("rejected");
  });

  it("leaves degraded mode when both heads arrive over the subscription", async () => {
    harness = await bootRemote({ missing: { core: true, providerAuth: true } });

    harness.relay.deliver(
      harness.engramEvent(CORE_SLUG, { slug: "core", profile: JSON.stringify({ v: 1 }) }, 1_800_000_000),
    );
    await settle();
    expect(harness.runtime.degraded).toBe(true); // auth still missing

    harness.relay.deliver(
      harness.engramEvent(
        PROVIDER_AUTH_SLUG,
        { slug: PROVIDER_AUTH_SLUG, value: '{"anthropic":{"type":"oauth"}}' },
        1_800_000_001,
      ),
    );
    await waitFor(() => !harness.runtime.degraded);
    expect(harness.runtime.degraded).toBe(false);
    expect(harness.relay.ephemeral.at(-1)?.content).toBe("online");
    expect(await readLocalAuth(harness.stateDir)).toBe('{"anthropic":{"type":"oauth"}}');

    const event = harness.chatFrom(generateSecretKey(), "now?");
    harness.relay.deliver(event);
    await settle();
    expect(harness.state.inbox.get(event.id)?.disposition).not.toBe("rejected");
  });

  it("degrades when the owner tombstones provider-auth", async () => {
    harness = await bootRemote({ missing: { core: false, providerAuth: false } });
    expect(harness.runtime.degraded).toBe(false);

    harness.relay.deliver(
      harness.engramEvent(PROVIDER_AUTH_SLUG, { slug: PROVIDER_AUTH_SLUG, value: null }, 1_800_000_000),
    );
    await waitFor(() => harness.runtime.degraded);
    expect(harness.runtime.degraded).toBe(true);
    expect(harness.relay.ephemeral.at(-1)?.content).toBe("degraded");
  });
});

describe("hot core-config application", () => {
  let harness: RemoteHarness;

  afterEach(async () => {
    await harness.runtime.stop("test");
    rmSync(harness.stateDir, { recursive: true, force: true });
  });

  it("applies a respond_to change immediately", async () => {
    harness = await bootRemote({ missing: { core: false, providerAuth: false } });

    // Base config answers anyone; the engram tightens to owner-only.
    harness.relay.deliver(
      harness.engramEvent(
        CORE_SLUG,
        { slug: "core", profile: JSON.stringify({ v: 1, respond_to: "owner-only" }) },
        1_800_000_000,
      ),
    );
    await settle();

    const stranger = harness.chatFrom(generateSecretKey(), "hi");
    harness.relay.deliver(stranger);
    await settle();
    expect(harness.state.inbox.get(stranger.id)?.disposition).toBe("rejected");
  });

  it("ignores stale and malformed heads", async () => {
    harness = await bootRemote({ missing: { core: false, providerAuth: false } });

    // Malformed config: rejected, gate unchanged (still anyone).
    harness.relay.deliver(
      harness.engramEvent(
        CORE_SLUG,
        { slug: "core", profile: JSON.stringify({ v: 1, respond_to: "everyone" }) },
        1_800_000_000,
      ),
    );
    await settle();

    const stranger = harness.chatFrom(generateSecretKey(), "hi");
    harness.relay.deliver(stranger);
    await settle();
    expect(harness.state.inbox.get(stranger.id)?.disposition).not.toBe("rejected");
  });
});
