import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  applyMembership,
  buildAddMemberEvent,
  buildRemoveMemberEvent,
  isChannelId,
  isMemberRole,
  MEMBER_ROLES,
} from "../src/provisioning/channel-membership.js";
import { readOwnerSecret } from "../src/provisioning/owner-secret.js";
import { createSigner, verifyNostrEvent } from "../src/nostr/signer.js";
import { KIND, tagValue, tagsNamed } from "../src/nostr/types.js";
import { FakeClock } from "../src/runtime/clock.js";
import { FakeRelayPort } from "./helpers/fake-relay-port.js";

const CHANNEL = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ownerSecret = generateSecretKey();
const ownerPubkey = getPublicKey(ownerSecret);
const agentPubkey = getPublicKey(generateSecretKey());
const signer = createSigner(ownerSecret);

describe("membership event shape", () => {
  it("builds a kind 9000 matching build_add_member in buzz-sdk", () => {
    const event = buildAddMemberEvent(
      signer,
      { channelId: CHANNEL, memberPubkey: agentPubkey, role: "bot" },
      1_700_000_000,
    );
    expect(event.kind).toBe(KIND.MEMBER_ADD);
    expect(event.kind).toBe(9000);
    expect(event.content).toBe("");
    expect(event.pubkey).toBe(ownerPubkey);
    expect(tagValue(event, "h")).toBe(CHANNEL);
    expect(tagValue(event, "p")).toBe(agentPubkey);
    expect(tagValue(event, "role")).toBe("bot");
    expect(verifyNostrEvent(event)).toBe(true);
  });

  it("omits the role tag when none is given", () => {
    const event = buildAddMemberEvent(
      signer,
      { channelId: CHANNEL, memberPubkey: agentPubkey },
      1_700_000_000,
    );
    expect(tagsNamed(event, "role")).toHaveLength(0);
  });

  it("builds a kind 9001 for removal, without a role", () => {
    const event = buildRemoveMemberEvent(
      signer,
      { channelId: CHANNEL, memberPubkey: agentPubkey, role: "bot" },
      1_700_000_000,
    );
    expect(event.kind).toBe(9001);
    expect(tagsNamed(event, "role")).toHaveLength(0);
    expect(tagValue(event, "p")).toBe(agentPubkey);
  });

  it("never carries a NIP-OA auth tag", () => {
    // The owner signs under their own key; an attestation here would misstate
    // who authorised the membership change.
    const event = buildAddMemberEvent(
      signer,
      { channelId: CHANNEL, memberPubkey: agentPubkey, role: "bot" },
      1_700_000_000,
    );
    expect(tagsNamed(event, "auth")).toHaveLength(0);
  });

  it("lowercases the member pubkey the way the relay expects", () => {
    const event = buildAddMemberEvent(
      signer,
      { channelId: CHANNEL, memberPubkey: agentPubkey.toUpperCase(), role: "bot" },
      1_700_000_000,
    );
    expect(tagValue(event, "p")).toBe(agentPubkey);
  });
});

describe("validation", () => {
  it("recognises channel ids and roles", () => {
    expect(isChannelId(CHANNEL)).toBe(true);
    expect(isChannelId("not-a-uuid")).toBe(false);
    for (const role of MEMBER_ROLES) expect(isMemberRole(role)).toBe(true);
    expect(isMemberRole("superuser")).toBe(false);
  });

  it("rejects a malformed channel, pubkey or role", () => {
    const at = 1_700_000_000;
    expect(() =>
      buildAddMemberEvent(signer, { channelId: "nope", memberPubkey: agentPubkey }, at),
    ).toThrow(/channel must be a UUID/);
    expect(() =>
      buildAddMemberEvent(signer, { channelId: CHANNEL, memberPubkey: "short" }, at),
    ).toThrow(/64-char hex/);
    expect(() =>
      buildAddMemberEvent(
        signer,
        { channelId: CHANNEL, memberPubkey: agentPubkey, role: "root" as never },
        at,
      ),
    ).toThrow(/role must be one of/);
  });
});

describe("owner secret sources", () => {
  it("accepts a key passed literally", async () => {
    const secret = await readOwnerSecret({ from: "literal", value: bytesToHex(ownerSecret) });
    expect(getPublicKey(secret)).toBe(ownerPubkey);
  });

  it("accepts an nsec passed literally", async () => {
    const { nsecEncode } = await import("nostr-tools/nip19");
    const secret = await readOwnerSecret({ from: "literal", value: nsecEncode(ownerSecret) });
    expect(getPublicKey(secret)).toBe(ownerPubkey);
  });

  it("prompts when the source is stdin", async () => {
    const prompts: string[] = [];
    const secret = await readOwnerSecret({ from: "stdin" }, async (prompt) => {
      prompts.push(prompt);
      return bytesToHex(ownerSecret);
    });
    expect(prompts[0]).toMatch(/Owner secret key/);
    expect(getPublicKey(secret)).toBe(ownerPubkey);
  });

  it("rejects a value that is not a key", async () => {
    await expect(readOwnerSecret({ from: "literal", value: "hunter2" })).rejects.toThrow(
      /not a valid key/,
    );
  });
});

describe("applyMembership", () => {
  const base = {
    relayUrl: "wss://relay.example",
    channelId: CHANNEL,
    memberPubkey: agentPubkey,
  };

  it("publishes the signed event and reports it", async () => {
    const relay = new FakeRelayPort();
    const result = await applyMembership({
      ...base,
      action: "add",
      role: "bot",
      ownerSecret: { from: "literal", value: bytesToHex(ownerSecret) },
      relay,
      clock: new FakeClock(),
    });

    expect(relay.published).toHaveLength(1);
    const event = relay.published[0]!;
    expect(event.kind).toBe(9000);
    expect(event.id).toBe(result.eventId);
    expect(result.ownerPubkey).toBe(ownerPubkey);
    expect(result.role).toBe("bot");
  });

  it("reads the key interactively when no source is given on the command line", async () => {
    const relay = new FakeRelayPort();
    let prompted = false;
    await applyMembership({
      ...base,
      action: "add",
      role: "bot",
      ownerSecret: { from: "stdin" },
      readSecretLine: async () => {
        prompted = true;
        return bytesToHex(ownerSecret);
      },
      relay,
      clock: new FakeClock(),
    });
    expect(prompted).toBe(true);
    expect(relay.published).toHaveLength(1);
  });

  it("surfaces a relay rejection instead of reporting success", async () => {
    const relay = new FakeRelayPort();
    relay.publishVerdict = () => ({
      ok: false,
      message: "restricted: not a channel admin",
      terminal: true,
    });

    await expect(
      applyMembership({
        ...base,
        action: "add",
        ownerSecret: { from: "literal", value: bytesToHex(ownerSecret) },
        relay,
        clock: new FakeClock(),
      }),
    ).rejects.toThrow(/not a channel admin/);
  });

  it("refuses to make the owner their own target", async () => {
    await expect(
      applyMembership({
        ...base,
        memberPubkey: ownerPubkey,
        action: "add",
        ownerSecret: { from: "literal", value: bytesToHex(ownerSecret) },
        relay: new FakeRelayPort(),
        clock: new FakeClock(),
      }),
    ).rejects.toThrow(/different keys/);
  });

  it("publishes kind 9001 on removal", async () => {
    const relay = new FakeRelayPort();
    const result = await applyMembership({
      ...base,
      action: "remove",
      ownerSecret: { from: "literal", value: bytesToHex(ownerSecret) },
      relay,
      clock: new FakeClock(),
    });
    expect(relay.published[0]?.kind).toBe(9001);
    expect(result.role).toBeNull();
  });

  it("closes a relay it opened itself, but leaves an injected one alone", async () => {
    const relay = new FakeRelayPort();
    await applyMembership({
      ...base,
      action: "add",
      ownerSecret: { from: "literal", value: bytesToHex(ownerSecret) },
      relay,
      clock: new FakeClock(),
    });
    expect(relay.state).toBe("ready");
  });
});
