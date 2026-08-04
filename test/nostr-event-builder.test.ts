import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createEventBuilder } from "../src/nostr/event-builder.js";
import { AUTH_TAG_NAME, extractAuthTag, signAttestation } from "../src/nostr/nip-oa.js";
import { buildAuthEvent, normalizeRelayUrl, verifyAuthEvent } from "../src/nostr/nip42.js";
import { createSigner, verifyNostrEvent } from "../src/nostr/signer.js";
import { AGENT_PUBLISHED_KINDS, KIND, tagValue } from "../src/nostr/types.js";
import { FakeClock } from "../src/runtime/clock.js";
import { createTestIdentity } from "./helpers/identity.js";

const RELAY_URL = "ws://relay.test:3000";

describe("event builder", () => {
  it("injects exactly one verified auth tag", () => {
    const clock = new FakeClock();
    const identity = createTestIdentity(clock);
    const event = identity.builder.build({ kind: KIND.CHAT, tags: [["h", "c1"]], content: "hi" });

    const authTags = event.tags.filter((tag) => tag[0] === AUTH_TAG_NAME);
    expect(authTags).toHaveLength(1);
    expect(extractAuthTag(event.tags)).toEqual(identity.authTag);
    expect(event.pubkey).toBe(identity.agentPubkey);
    expect(verifyNostrEvent(event)).toBe(true);
  });

  it("rejects a caller-supplied auth tag", () => {
    const clock = new FakeClock();
    const identity = createTestIdentity(clock);
    const foreign = signAttestation(generateSecretKey(), identity.agentPubkey, "");

    expect(() =>
      identity.builder.build({
        kind: KIND.CHAT,
        tags: [["h", "c1"], [AUTH_TAG_NAME, foreign.ownerPubkey, "", foreign.signature]],
        content: "hi",
      }),
    ).toThrow(/must not supply an auth tag/);
  });

  it("refuses to construct when conditions do not cover every published kind", () => {
    const clock = new FakeClock();
    const signer = createSigner(generateSecretKey());
    const ownerSecret = generateSecretKey();
    const authTag = signAttestation(ownerSecret, signer.publicKey, "kind=9");

    expect(() => createEventBuilder({ signer, authTag, clock })).toThrow(
      /do not cover kinds/,
    );
    // The uncovered kinds are named so the operator can fix the attestation.
    const kinds = AGENT_PUBLISHED_KINDS.filter((kind) => kind !== KIND.CHAT);
    for (const kind of kinds) {
      expect(() => createEventBuilder({ signer, authTag, clock })).toThrow(
        new RegExp(String(kind)),
      );
    }
  });

  it("refuses to construct when the attestation binds another agent", () => {
    const clock = new FakeClock();
    const signer = createSigner(generateSecretKey());
    const strangerPubkey = getPublicKey(generateSecretKey());
    const authTag = signAttestation(generateSecretKey(), strangerPubkey, "");

    expect(() => createEventBuilder({ signer, authTag, clock })).toThrow(/does not verify/);
  });

  it("fails fast once an expiring attestation has lapsed", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const nowSec = Math.floor(clock.now() / 1000);
    const signer = createSigner(generateSecretKey());
    const authTag = signAttestation(
      generateSecretKey(),
      signer.publicKey,
      `created_at<${nowSec + 60}`,
    );
    const builder = createEventBuilder({ signer, authTag, clock });

    expect(builder.build({ kind: KIND.CHAT, tags: [], content: "in time" }).kind).toBe(KIND.CHAT);
    expect(() =>
      builder.build({ kind: KIND.CHAT, tags: [], content: "too late", created_at: nowSec + 120 }),
    ).toThrow(/does not authorise kind/);
  });

  it("stamps created_at from the injected clock", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const identity = createTestIdentity(clock);
    const event = identity.builder.build({ kind: KIND.CHAT, tags: [], content: "x" });
    expect(event.created_at).toBe(1_700_000_000);
  });
});

describe("NIP-42 auth event", () => {
  it("carries relay, challenge and the owner attestation", () => {
    const clock = new FakeClock();
    const identity = createTestIdentity(clock);
    const event = buildAuthEvent(identity.builder, RELAY_URL, "chal-abc");

    expect(event.kind).toBe(KIND.CLIENT_AUTH);
    expect(tagValue(event, "relay")).toBe(RELAY_URL);
    expect(tagValue(event, "challenge")).toBe("chal-abc");
    expect(extractAuthTag(event.tags)).toEqual(identity.authTag);
    expect(
      verifyAuthEvent(event, {
        relayUrl: RELAY_URL,
        challenge: "chal-abc",
        agentPubkey: identity.agentPubkey,
        now: Math.floor(clock.now() / 1000),
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a replayed challenge, a foreign relay and a stale timestamp", () => {
    const clock = new FakeClock();
    const identity = createTestIdentity(clock);
    const nowSec = Math.floor(clock.now() / 1000);
    const event = buildAuthEvent(identity.builder, RELAY_URL, "chal-abc");

    expect(
      verifyAuthEvent(event, { relayUrl: RELAY_URL, challenge: "other", now: nowSec }),
    ).toEqual({ ok: false, reason: "invalid: challenge mismatch" });
    expect(
      verifyAuthEvent(event, { relayUrl: "ws://elsewhere:3000", challenge: "chal-abc", now: nowSec }),
    ).toEqual({ ok: false, reason: "invalid: relay tag mismatch" });
    expect(
      verifyAuthEvent(event, { relayUrl: RELAY_URL, challenge: "chal-abc", now: nowSec + 3_600 }),
    ).toEqual({ ok: false, reason: "invalid: created_at out of range" });
  });

  it("rejects a tampered event and a missing attestation", () => {
    const clock = new FakeClock();
    const identity = createTestIdentity(clock);
    const nowSec = Math.floor(clock.now() / 1000);
    const event = buildAuthEvent(identity.builder, RELAY_URL, "chal-abc");

    // Round-tripped through JSON so nostr-tools' cached verification symbol
    // does not travel with the copy.
    const tampered = { ...(JSON.parse(JSON.stringify(event)) as typeof event), content: "tampered" };
    expect(
      verifyAuthEvent(tampered, { relayUrl: RELAY_URL, challenge: "chal-abc", now: nowSec }),
    ).toEqual({ ok: false, reason: "invalid: bad id or signature" });

    const unattested = identity.signer.sign({
      pubkey: identity.agentPubkey,
      created_at: nowSec,
      kind: KIND.CLIENT_AUTH,
      tags: [
        ["relay", RELAY_URL],
        ["challenge", "chal-abc"],
      ],
      content: "",
    });
    expect(
      verifyAuthEvent(unattested, { relayUrl: RELAY_URL, challenge: "chal-abc", now: nowSec }),
    ).toEqual({ ok: false, reason: "restricted: missing or duplicated auth tag" });
  });

  it("normalises relay URLs before comparing them", () => {
    expect(normalizeRelayUrl("WS://Relay.Test:3000/")).toBe(normalizeRelayUrl("ws://relay.test:3000"));
    expect(normalizeRelayUrl("wss://relay.test/nostr/")).toBe("wss://relay.test/nostr");
  });
});
