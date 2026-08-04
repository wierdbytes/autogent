import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { signAttestation, toNostrTag } from "../src/nostr/nip-oa.js";
import type { NostrTag } from "../src/nostr/types.js";
import type { AuthorGateOptions, ChannelType, ProfileSnapshot } from "../src/security/author-gate.js";
import {
  SIBLING_CACHE_CAP,
  createAuthorGate,
  toChannelType,
  verifySiblingProfile,
} from "../src/security/author-gate.js";

const ownerSecret = generateSecretKey();
const OWNER = getPublicKey(ownerSecret);
const AGENT = getPublicKey(generateSecretKey());

const siblingSecret = generateSecretKey();
const SIBLING = getPublicKey(siblingSecret);
const STRANGER = getPublicKey(generateSecretKey());
const LISTED = getPublicKey(generateSecretKey());

const otherOwnerSecret = generateSecretKey();

/** A kind 0 whose auth tag really is signed by `owner` for `pubkey`. */
function attestedProfile(pubkey: string, secret: Uint8Array): ProfileSnapshot {
  return { pubkey, tags: [["name", "sibling"], toNostrTag(signAttestation(secret, pubkey, ""))] };
}

interface Harness {
  lookups: string[];
  gate: ReturnType<typeof createAuthorGate>;
}

function harness(
  overrides: Partial<AuthorGateOptions> = {},
  profiles: Record<string, ProfileSnapshot | null> = {},
): Harness {
  const lookups: string[] = [];
  const gate = createAuthorGate({
    agentPubkey: AGENT,
    ownerPubkey: OWNER,
    respondTo: "owner-only",
    lookupProfile: async (pubkey) => {
      lookups.push(pubkey);
      return profiles[pubkey] ?? null;
    },
    ...overrides,
  });
  return { lookups, gate };
}

const CHANNELS: readonly ChannelType[] = ["stream", "private", "dm", "unknown"];

describe("self-loop prevention", () => {
  it("rejects the agent's own events in every mode and channel type", async () => {
    for (const respondTo of ["owner-only", "allowlist", "anyone", "nobody"] as const) {
      for (const channelType of CHANNELS) {
        const { gate } = harness({ respondTo, allowlist: [AGENT], siblingAgents: [AGENT] });
        const decision = await gate.evaluate({ authorPubkey: AGENT, channelType });
        expect(decision.allowed, `${respondTo}/${channelType}`).toBe(false);
        expect(decision.code).toBe("self");
      }
    }
  });
});

describe("owner-only", () => {
  it("admits the owner everywhere", async () => {
    for (const channelType of CHANNELS) {
      const { gate } = harness();
      const decision = await gate.evaluate({ authorPubkey: OWNER, channelType });
      expect(decision.allowed, channelType).toBe(true);
      expect(decision.code).toBe("owner");
    }
  });

  it("rejects a stranger", async () => {
    const { gate } = harness();
    const decision = await gate.evaluate({ authorPubkey: STRANGER, channelType: "stream" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("not-owner-or-sibling");
  });

  it("fails closed before provisioning, when no owner is known", async () => {
    const { gate } = harness({ ownerPubkey: null });
    const decision = await gate.evaluate({ authorPubkey: OWNER, channelType: "stream" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("no-owner");
  });
});

describe("allowlist", () => {
  it("admits a listed pubkey in a public channel", async () => {
    const { gate } = harness({ respondTo: "allowlist", allowlist: [LISTED] });
    const decision = await gate.evaluate({ authorPubkey: LISTED, channelType: "stream" });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe("allowlist");
  });

  it("admits a same-owner sibling that is not on the list", async () => {
    const { gate } = harness({ respondTo: "allowlist", allowlist: [LISTED] }, {
      [SIBLING]: attestedProfile(SIBLING, ownerSecret),
    });
    const decision = await gate.evaluate({ authorPubkey: SIBLING, channelType: "stream" });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe("sibling");
  });

  it("rejects an unlisted non-sibling", async () => {
    const { gate } = harness({ respondTo: "allowlist", allowlist: [LISTED] });
    const decision = await gate.evaluate({ authorPubkey: STRANGER, channelType: "stream" });
    expect(decision.allowed).toBe(false);
  });
});

describe("anyone and nobody", () => {
  it("admits anyone in a public channel without a profile lookup", async () => {
    const { gate, lookups } = harness({ respondTo: "anyone" });
    const decision = await gate.evaluate({ authorPubkey: STRANGER, channelType: "stream" });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe("anyone");
    expect(lookups).toEqual([]);
  });

  it("rejects everyone under nobody, including the owner", async () => {
    for (const channelType of CHANNELS) {
      const { gate } = harness({ respondTo: "nobody" });
      const decision = await gate.evaluate({ authorPubkey: OWNER, channelType });
      expect(decision.allowed, channelType).toBe(false);
      expect(decision.code).toBe("nobody");
    }
  });
});

describe("DM hardening", () => {
  it("overrides the allowlist inside a DM", async () => {
    const { gate } = harness({ respondTo: "allowlist", allowlist: [LISTED] });
    const decision = await gate.evaluate({ authorPubkey: LISTED, channelType: "dm" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("dm-restricted");
  });

  it("overrides 'anyone' inside a DM", async () => {
    const { gate } = harness({ respondTo: "anyone" });
    const decision = await gate.evaluate({ authorPubkey: STRANGER, channelType: "dm" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("dm-restricted");
  });

  it("still admits the owner and a verified sibling inside a DM", async () => {
    const { gate } = harness({ respondTo: "anyone" }, {
      [SIBLING]: attestedProfile(SIBLING, ownerSecret),
    });
    expect((await gate.evaluate({ authorPubkey: OWNER, channelType: "dm" })).allowed).toBe(true);
    expect((await gate.evaluate({ authorPubkey: SIBLING, channelType: "dm" })).allowed).toBe(true);
  });

  it("treats an unresolved channel type as a DM", async () => {
    const { gate } = harness({ respondTo: "anyone", allowlist: [LISTED] });
    const decision = await gate.evaluate({ authorPubkey: LISTED, channelType: "unknown" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/unresolved/);
  });

  it("maps unrecognised channel metadata to 'unknown'", () => {
    expect(toChannelType("dm")).toBe("dm");
    expect(toChannelType("stream")).toBe("stream");
    expect(toChannelType("private")).toBe("private");
    expect(toChannelType(null)).toBe("unknown");
    expect(toChannelType("group")).toBe("unknown");
  });
});

describe("sibling verification", () => {
  it("verifies via NIP-OA and caches the result", async () => {
    const { gate, lookups } = harness({}, { [SIBLING]: attestedProfile(SIBLING, ownerSecret) });
    expect((await gate.evaluate({ authorPubkey: SIBLING, channelType: "dm" })).allowed).toBe(true);
    const second = await gate.evaluate({ authorPubkey: SIBLING, channelType: "dm" });
    expect(second.allowed).toBe(true);
    expect(second.reason).toMatch(/cached/);
    expect(lookups).toEqual([SIBLING]);
  });

  it("caches negative results too", async () => {
    const { gate, lookups } = harness();
    await gate.evaluate({ authorPubkey: STRANGER, channelType: "dm" });
    await gate.evaluate({ authorPubkey: STRANGER, channelType: "dm" });
    expect(lookups).toEqual([STRANGER]);
  });

  it("rejects a profile attested by a different owner", async () => {
    const { gate } = harness({}, { [SIBLING]: attestedProfile(SIBLING, otherOwnerSecret) });
    expect((await gate.evaluate({ authorPubkey: SIBLING, channelType: "dm" })).allowed).toBe(false);
  });

  it("rejects a forged tag that names our owner but was signed by someone else", async () => {
    const forged: ProfileSnapshot = {
      pubkey: SIBLING,
      tags: [["auth", OWNER, "", "ab".repeat(64)]],
    };
    const { gate } = harness({}, { [SIBLING]: forged });
    expect((await gate.evaluate({ authorPubkey: SIBLING, channelType: "dm" })).allowed).toBe(false);
    expect(verifySiblingProfile(forged, SIBLING, OWNER)).toBe(false);
  });

  it("rejects a valid tag copied from another agent's profile", async () => {
    const stolen = toNostrTag(signAttestation(ownerSecret, SIBLING, ""));
    const impostor: ProfileSnapshot = { pubkey: STRANGER, tags: [stolen] };
    expect(verifySiblingProfile(impostor, STRANGER, OWNER)).toBe(false);
  });

  it("rejects a profile that carries two auth tags", async () => {
    const tag = toNostrTag(signAttestation(ownerSecret, SIBLING, ""));
    const ambiguous: ProfileSnapshot = { pubkey: SIBLING, tags: [tag, tag] };
    expect(verifySiblingProfile(ambiguous, SIBLING, OWNER)).toBe(false);
  });

  it("rejects a profile the relay returned for the wrong pubkey", () => {
    const swapped: ProfileSnapshot = {
      pubkey: STRANGER,
      tags: [toNostrTag(signAttestation(ownerSecret, SIBLING, ""))],
    };
    expect(verifySiblingProfile(swapped, SIBLING, OWNER)).toBe(false);
  });

  it("denies without caching when the lookup throws, so the next event retries", async () => {
    const attempts: string[] = [];
    const gate = createAuthorGate({
      agentPubkey: AGENT,
      ownerPubkey: OWNER,
      respondTo: "owner-only",
      lookupProfile: async (pubkey) => {
        attempts.push(pubkey);
        if (attempts.length === 1) throw new Error("relay unreachable");
        return attestedProfile(SIBLING, ownerSecret);
      },
    });
    expect((await gate.evaluate({ authorPubkey: SIBLING, channelType: "dm" })).allowed).toBe(false);
    expect((await gate.evaluate({ authorPubkey: SIBLING, channelType: "dm" })).allowed).toBe(true);
    expect(attempts).toHaveLength(2);
  });

  it("admits an operator-configured sibling without a lookup, even in a DM", async () => {
    const { gate, lookups } = harness({ siblingAgents: [SIBLING] });
    const decision = await gate.evaluate({ authorPubkey: SIBLING, channelType: "dm" });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe("configured-sibling");
    expect(lookups).toEqual([]);
  });

  it("bounds the cache", async () => {
    const gate = createAuthorGate({
      agentPubkey: AGENT,
      ownerPubkey: OWNER,
      respondTo: "owner-only",
      lookupProfile: async () => null,
      cacheCap: 4,
    });
    for (let i = 0; i < 10; i++) {
      await gate.evaluate({
        authorPubkey: getPublicKey(generateSecretKey()),
        channelType: "stream",
      });
    }
    expect(gate.cacheSize).toBeLessThanOrEqual(4);
    expect(SIBLING_CACHE_CAP).toBe(256);
  });
});

describe("profile tag hygiene", () => {
  it("rejects malformed and missing auth tags", () => {
    const cases: NostrTag[][] = [[], [["name", "x"]], [["auth", "short", "", "sig"]]];
    for (const tags of cases) {
      expect(verifySiblingProfile({ pubkey: SIBLING, tags }, SIBLING, OWNER)).toBe(false);
    }
    expect(verifySiblingProfile(null, SIBLING, OWNER)).toBe(false);
  });
});
