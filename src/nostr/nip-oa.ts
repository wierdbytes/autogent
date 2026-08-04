/**
 * NIP-OA owner attestation.
 *
 * An owner signs a statement binding an agent pubkey to a set of conditions.
 * The agent then carries that signature as an `auth` tag on the events it
 * publishes, which is how a relay (and Buzz Desktop) knows the agent acts on
 * the owner's behalf without the owner's secret key ever leaving their machine.
 *
 * Reference: docs/nips/NIP-OA.md and crates/buzz-sdk/src/nip_oa.rs in the Buzz
 * repository. The preimage below must match byte-for-byte.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "nostr-tools/utils";
import type { NostrTag } from "./types.js";
import { sha256Utf8 } from "./signer.js";

/** `["auth", ownerPubkey, conditions, signature]`. */
export interface AuthTag {
  ownerPubkey: string;
  conditions: string;
  signature: string;
}

export const AUTH_TAG_NAME = "auth";
const DOMAIN_SEPARATOR = "nostr:agent-auth:";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/**
 * The exact UTF-8 string an owner signs.
 *
 * `conditions` is used verbatim — never reordered, deduplicated or normalised —
 * because the verifier reconstructs the preimage from the raw tag value.
 */
export function attestationPreimage(agentPubkey: string, conditions: string): string {
  return `${DOMAIN_SEPARATOR}${agentPubkey}:${conditions}`;
}

/** SHA-256 of the preimage. This digest, not the string, is what BIP-340 signs. */
export function attestationDigest(agentPubkey: string, conditions: string): Uint8Array {
  return sha256Utf8(attestationPreimage(agentPubkey, conditions));
}

/* -------------------------------------------------------------------------- */
/* Conditions grammar                                                         */
/* -------------------------------------------------------------------------- */

const KIND_CLAUSE = /^kind=(0|[1-9][0-9]*)$/;
const CREATED_AT_CLAUSE = /^created_at[<>](0|[1-9][0-9]*)$/;

/**
 * Validates the conditions grammar.
 *
 * `""` is legal and means "no constraints" — the recommended provisioning value
 * for this agent, because the grammar cannot express an OR across the several
 * kinds we publish (plan §6.2).
 */
export function validateConditions(conditions: string): string[] {
  if (conditions === "") return [];
  const problems: string[] = [];
  if (/\s/.test(conditions)) problems.push("conditions must not contain whitespace");
  if (conditions.startsWith("&") || conditions.endsWith("&")) {
    problems.push("conditions must not start or end with '&'");
  }
  if (conditions.includes("&&")) problems.push("conditions must not contain an empty clause");

  for (const clause of conditions.split("&")) {
    if (clause === "") continue;
    if (KIND_CLAUSE.test(clause)) {
      const value = Number(clause.slice("kind=".length));
      if (value > 65_535) problems.push(`kind out of range in clause '${clause}'`);
      continue;
    }
    if (CREATED_AT_CLAUSE.test(clause)) {
      const value = Number(clause.slice("created_at<".length));
      if (value > 4_294_967_295) problems.push(`created_at out of range in clause '${clause}'`);
      continue;
    }
    problems.push(`unrecognised clause '${clause}'`);
  }
  return problems;
}

/**
 * True when an event of `kind` published at `createdAt` satisfies `conditions`.
 *
 * Clauses are ANDed. An empty conditions string always passes.
 */
export function conditionsAllow(conditions: string, kind: number, createdAt: number): boolean {
  if (conditions === "") return true;
  for (const clause of conditions.split("&")) {
    if (clause === "") continue;
    if (clause.startsWith("kind=")) {
      if (kind !== Number(clause.slice(5))) return false;
    } else if (clause.startsWith("created_at<")) {
      if (!(createdAt < Number(clause.slice(11)))) return false;
    } else if (clause.startsWith("created_at>")) {
      if (!(createdAt > Number(clause.slice(11)))) return false;
    } else {
      // An unparseable clause must fail closed rather than be skipped.
      return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Signing and verification                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Produces an owner attestation. Only ever called on the owner's machine by
 * `autogent-nostr attest`; the runtime has no code path that reaches it with a
 * secret key.
 */
export function signAttestation(
  ownerSecret: Uint8Array,
  agentPubkey: string,
  conditions: string,
): AuthTag {
  if (!HEX64.test(agentPubkey)) throw new Error("agentPubkey must be 64-char lowercase hex");
  const problems = validateConditions(conditions);
  if (problems.length > 0) throw new Error(`invalid conditions: ${problems.join("; ")}`);

  const ownerPubkey = Buffer.from(schnorr.getPublicKey(ownerSecret)).toString("hex");
  if (ownerPubkey === agentPubkey) throw new Error("owner and agent must be different keys");

  const digest = attestationDigest(agentPubkey, conditions);
  const signature = Buffer.from(schnorr.sign(digest, ownerSecret)).toString("hex");
  return { ownerPubkey, conditions, signature };
}

/** Verifies an attestation against the agent pubkey it is supposed to bind. */
export function verifyAttestation(tag: AuthTag, agentPubkey: string): boolean {
  if (!HEX64.test(tag.ownerPubkey) || !HEX64.test(agentPubkey)) return false;
  if (!HEX128.test(tag.signature)) return false;
  if (tag.ownerPubkey === agentPubkey) return false;
  if (validateConditions(tag.conditions).length > 0) return false;
  try {
    return schnorr.verify(
      hexToBytes(tag.signature),
      attestationDigest(agentPubkey, tag.conditions),
      hexToBytes(tag.ownerPubkey),
    );
  } catch {
    return false;
  }
}

export function toNostrTag(tag: AuthTag): NostrTag {
  return [AUTH_TAG_NAME, tag.ownerPubkey, tag.conditions, tag.signature];
}

/** Parses a raw tag. Returns null for anything that is not a well-formed auth tag. */
export function parseAuthTag(tag: readonly string[]): AuthTag | null {
  if (tag[0] !== AUTH_TAG_NAME || tag.length < 4) return null;
  const [, ownerPubkey, conditions, signature] = tag;
  if (typeof ownerPubkey !== "string" || typeof conditions !== "string") return null;
  if (typeof signature !== "string") return null;
  if (!HEX64.test(ownerPubkey) || !HEX128.test(signature)) return null;
  return { ownerPubkey, conditions, signature };
}

/**
 * Extracts the single auth tag from an event.
 *
 * More than one `auth` tag is rejected outright: an event carrying two
 * attestations is ambiguous about who authorised it, so we refuse to interpret
 * it rather than pick one (plan §6.2, §13.6).
 */
export function extractAuthTag(tags: readonly NostrTag[]): AuthTag | null {
  const candidates = tags.filter((tag) => tag[0] === AUTH_TAG_NAME);
  if (candidates.length !== 1) return null;
  return parseAuthTag(candidates[0] as string[]);
}

/**
 * Checks an attestation covers every kind this service publishes.
 *
 * Returns the kinds that would be rejected. A non-empty result at boot is fatal:
 * the agent would silently fail to publish some of its surface (plan §6.2).
 */
export function kindsNotCovered(
  conditions: string,
  kinds: readonly number[],
  now: number,
): number[] {
  return kinds.filter((kind) => !conditionsAllow(conditions, kind, now));
}
