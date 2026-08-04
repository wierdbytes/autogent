import { describe, expect, it } from "vitest";
import {
  attestationDigest,
  attestationPreimage,
  conditionsAllow,
  extractAuthTag,
  kindsNotCovered,
  signAttestation,
  toNostrTag,
  validateConditions,
  verifyAttestation,
} from "../src/nostr/nip-oa.js";
import { AGENT_PUBLISHED_KINDS } from "../src/nostr/types.js";

/** Vector lifted verbatim from docs/nips/NIP-OA.md in the Buzz repository. */
const VECTOR = {
  agentPubkey: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
  ownerPubkey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  conditions: "kind=1&created_at<1713957000",
  digest: "08cdecd55af4c28d3801fd69615dcf5cc04fab3bc134b38a840bf157197069a6",
  signature:
    "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369",
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("NIP-OA preimage", () => {
  it("matches the spec vector byte-for-byte", () => {
    expect(attestationPreimage(VECTOR.agentPubkey, VECTOR.conditions)).toBe(
      `nostr:agent-auth:${VECTOR.agentPubkey}:${VECTOR.conditions}`,
    );
    expect(hex(attestationDigest(VECTOR.agentPubkey, VECTOR.conditions))).toBe(VECTOR.digest);
  });

  it("verifies the spec signature", () => {
    expect(
      verifyAttestation(
        {
          ownerPubkey: VECTOR.ownerPubkey,
          conditions: VECTOR.conditions,
          signature: VECTOR.signature,
        },
        VECTOR.agentPubkey,
      ),
    ).toBe(true);
  });

  it("rejects the signature against a different agent pubkey", () => {
    expect(
      verifyAttestation(
        {
          ownerPubkey: VECTOR.ownerPubkey,
          conditions: VECTOR.conditions,
          signature: VECTOR.signature,
        },
        `${"a".repeat(63)}1`,
      ),
    ).toBe(false);
  });

  it("rejects a tampered conditions string", () => {
    expect(
      verifyAttestation(
        { ownerPubkey: VECTOR.ownerPubkey, conditions: "kind=2", signature: VECTOR.signature },
        VECTOR.agentPubkey,
      ),
    ).toBe(false);
  });
});

describe("attestation round trip", () => {
  const ownerSecret = new Uint8Array(32).fill(7);
  const agentPubkey = "b".repeat(64);

  it("signs and verifies with empty conditions", () => {
    const tag = signAttestation(ownerSecret, agentPubkey, "");
    expect(tag.conditions).toBe("");
    expect(verifyAttestation(tag, agentPubkey)).toBe(true);
  });

  it("refuses self-attestation", () => {
    const ownerPubkey = signAttestation(ownerSecret, agentPubkey, "").ownerPubkey;
    expect(() => signAttestation(ownerSecret, ownerPubkey, "")).toThrow(/different keys/);
  });

  it("refuses malformed conditions", () => {
    expect(() => signAttestation(ownerSecret, agentPubkey, "kind=1&")).toThrow(/invalid conditions/);
  });
});

describe("conditions grammar", () => {
  it("accepts the canonical forms", () => {
    expect(validateConditions("")).toEqual([]);
    expect(validateConditions("kind=0")).toEqual([]);
    expect(validateConditions("kind=9&created_at<1713957000")).toEqual([]);
    expect(validateConditions("created_at>1000")).toEqual([]);
  });

  it("rejects non-canonical decimals, whitespace and empty clauses", () => {
    expect(validateConditions("kind=01").length).toBeGreaterThan(0);
    expect(validateConditions("kind=1 &kind=2").length).toBeGreaterThan(0);
    expect(validateConditions("&kind=1").length).toBeGreaterThan(0);
    expect(validateConditions("kind=1&&kind=2").length).toBeGreaterThan(0);
    expect(validateConditions("kind=70000").length).toBeGreaterThan(0);
  });
});

describe("conditions evaluation", () => {
  it("treats empty conditions as unconstrained", () => {
    expect(conditionsAllow("", 9, 1)).toBe(true);
    expect(kindsNotCovered("", AGENT_PUBLISHED_KINDS, 1_800_000_000)).toEqual([]);
  });

  it("ANDs clauses and fails closed on unknown clauses", () => {
    expect(conditionsAllow("kind=9", 9, 1)).toBe(true);
    expect(conditionsAllow("kind=9", 0, 1)).toBe(false);
    expect(conditionsAllow("created_at<100", 9, 99)).toBe(true);
    expect(conditionsAllow("created_at<100", 9, 100)).toBe(false);
    expect(conditionsAllow("bogus=1", 9, 1)).toBe(false);
  });

  it("reports every published kind a single-kind attestation would block", () => {
    const blocked = kindsNotCovered("kind=9", AGENT_PUBLISHED_KINDS, 1_800_000_000);
    expect(blocked).toContain(0);
    expect(blocked).toContain(24200);
    expect(blocked).not.toContain(9);
  });
});

describe("auth tag extraction", () => {
  const ownerSecret = new Uint8Array(32).fill(9);
  const agentPubkey = "c".repeat(64);
  const tag = toNostrTag(signAttestation(ownerSecret, agentPubkey, ""));

  it("extracts exactly one tag", () => {
    expect(extractAuthTag([["p", "x"], tag])).not.toBeNull();
  });

  it("refuses an event carrying two auth tags", () => {
    expect(extractAuthTag([tag, tag])).toBeNull();
  });

  it("refuses a malformed tag", () => {
    expect(extractAuthTag([["auth", "short", "", "sig"]])).toBeNull();
  });
});
