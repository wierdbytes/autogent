/**
 * Inbound author gate (plan §6.4, §10.4).
 *
 * Decides whether an event's author may fire or steer a turn, before anything
 * else looks at the message. The decision matrix mirrors buzz-acp's
 * `author_allowed` so a standalone agent and a Buzz-managed one refuse the same
 * traffic.
 *
 * ## Why DMs collapse every mode to owner-plus-siblings
 *
 * Clients auto-`p`-tag every DM participant, so inside a DM *any* participant's
 * message already looks like a mention. Combined with agent-initiated DMs — the
 * agent can be asked to message a third party — `allowlist` and `anyone` would
 * become transitive access grants: whoever lands in a DM with the agent could
 * prompt it. So in a DM only the owner and cryptographically verified same-owner
 * siblings get through. A channel whose type could not be resolved is treated as
 * a DM, which makes an unreachable relay tighten the gate instead of opening it.
 */

import type { RespondToMode } from "../config.js";
import { extractAuthTag, verifyAttestation } from "../nostr/nip-oa.js";
import type { NostrTag } from "../nostr/types.js";
import { isPubkey } from "../nostr/signer.js";
import type { Logger } from "../runtime/ports.js";
import { shortPubkey } from "./redaction.js";

/** `unknown` is what a failed channel-metadata lookup produces. */
export type ChannelType = "stream" | "private" | "dm" | "unknown";

export interface ProfileSnapshot {
  pubkey: string;
  tags: readonly NostrTag[];
}

/**
 * Fetches an author's kind 0 profile.
 *
 * Injected rather than performed here: the gate must stay a pure decision
 * function so it can be exercised without a relay, and so the caller owns the
 * timeout and rate-limit policy for the lookup.
 */
export type ProfileLookup = (pubkey: string) => Promise<ProfileSnapshot | null>;

export type AuthorDecisionCode =
  | "self"
  | "nobody"
  | "anyone"
  | "owner"
  | "sibling"
  | "configured-sibling"
  | "allowlist"
  | "no-owner"
  | "dm-restricted"
  | "not-owner-or-sibling";

export interface AuthorDecision {
  allowed: boolean;
  code: AuthorDecisionCode;
  /** Operator-facing explanation, safe to log (pubkeys are shortened). */
  reason: string;
}

export interface AuthorGateOptions {
  agentPubkey: string;
  /** Null before `provision import`; every trust decision then fails closed. */
  ownerPubkey: string | null;
  respondTo: RespondToMode;
  allowlist?: readonly string[];
  /**
   * Sibling agents the operator vouches for explicitly (plan §6.4). Unlike the
   * allowlist these survive DM hardening, because they name the operator's own
   * agents rather than arbitrary third parties.
   */
  siblingAgents?: readonly string[];
  lookupProfile: ProfileLookup;
  logger?: Logger;
  /** Bound on the sibling cache. Matches buzz-acp's 256. */
  cacheCap?: number;
}

export interface AuthorGateInput {
  authorPubkey: string;
  channelType: ChannelType;
}

/** buzz-acp caps its sibling map here and clears wholesale on overflow. */
export const SIBLING_CACHE_CAP = 256;

export class AuthorGate {
  readonly #agentPubkey: string;
  readonly #ownerPubkey: string | null;
  #respondTo: RespondToMode;
  #allowlist: ReadonlySet<string>;
  readonly #configuredSiblings: ReadonlySet<string>;
  readonly #lookupProfile: ProfileLookup;
  readonly #logger: Logger | undefined;
  readonly #cacheCap: number;
  /** author pubkey -> verified sibling. Attestations are immutable, so results keep. */
  readonly #siblings = new Map<string, boolean>();

  constructor(options: AuthorGateOptions) {
    this.#agentPubkey = options.agentPubkey;
    this.#ownerPubkey = options.ownerPubkey;
    this.#respondTo = options.respondTo;
    this.#allowlist = new Set(options.allowlist ?? []);
    this.#configuredSiblings = new Set(options.siblingAgents ?? []);
    this.#lookupProfile = options.lookupProfile;
    this.#logger = options.logger;
    this.#cacheCap = options.cacheCap ?? SIBLING_CACHE_CAP;
  }

  /**
   * Applies a core-engram policy change immediately (remote plan §3.3).
   *
   * Only the respond-to surface is hot-swappable: identity and owner are
   * immutable for the life of the process, and siblings stay operator-vouched.
   */
  updatePolicy(policy: { respondTo: RespondToMode; allowlist: readonly string[] }): void {
    this.#respondTo = policy.respondTo;
    this.#allowlist = new Set(policy.allowlist);
  }

  async evaluate(input: AuthorGateInput): Promise<AuthorDecision> {
    const author = input.authorPubkey;

    if (author === this.#agentPubkey) {
      return deny("self", "the agent's own events never re-enter the pipeline");
    }
    if (this.#respondTo === "nobody") {
      return deny("nobody", "respondTo is 'nobody'");
    }

    // Unknown metadata must not relax the gate, so it lands in the DM branch.
    if (input.channelType === "dm" || input.channelType === "unknown") {
      const trusted = await this.isOwnerOrSibling(author);
      if (trusted.allowed || trusted.code === "no-owner") return trusted;
      return deny(
        "dm-restricted",
        input.channelType === "unknown"
          ? `channel type unresolved, treated as a DM; ${shortPubkey(author)} is neither the owner nor a verified sibling`
          : `in a DM only the owner and verified same-owner siblings may prompt; ${shortPubkey(author)} is neither`,
      );
    }

    if (this.#respondTo === "anyone") {
      return allow("anyone", "respondTo is 'anyone' and this is not a DM");
    }

    // The allowlist is checked first because it is a local set lookup, and a hit
    // spares the profile fetch that sibling verification would otherwise need.
    if (this.#respondTo === "allowlist" && this.#allowlist.has(author)) {
      return allow("allowlist", `${shortPubkey(author)} is on the explicit allowlist`);
    }

    const trusted = await this.isOwnerOrSibling(author);
    if (trusted.allowed || trusted.code === "no-owner") return trusted;

    return deny(
      "not-owner-or-sibling",
      this.#respondTo === "allowlist"
        ? `${shortPubkey(author)} is neither the owner, a verified sibling, nor on the allowlist`
        : `respondTo is 'owner-only' and ${shortPubkey(author)} is neither the owner nor a verified sibling`,
    );
  }

  /**
   * Owner, operator-vouched sibling, or an agent whose kind 0 profile carries a
   * NIP-OA attestation from *our* owner.
   */
  async isOwnerOrSibling(author: string): Promise<AuthorDecision> {
    const owner = this.#ownerPubkey;
    if (owner === null) {
      return deny("no-owner", "no owner pubkey is provisioned; every trust decision fails closed");
    }
    if (author === owner) return allow("owner", "author is the owner");
    if (this.#configuredSiblings.has(author)) {
      return allow("configured-sibling", `${shortPubkey(author)} is a configured sibling agent`);
    }

    const cached = this.#siblings.get(author);
    if (cached !== undefined) {
      return cached
        ? allow("sibling", `${shortPubkey(author)} is a verified same-owner sibling (cached)`)
        : deny("not-owner-or-sibling", `${shortPubkey(author)} is not a sibling (cached)`);
    }

    let profile: ProfileSnapshot | null;
    try {
      profile = await this.#lookupProfile(author);
    } catch (error) {
      // A failed lookup is not evidence, so it is denied but never cached: the
      // next event retries instead of pinning a misclassification.
      this.#logger?.debug("sibling profile lookup failed", {
        author: shortPubkey(author),
        error: (error as Error).message,
      });
      return deny("not-owner-or-sibling", `profile lookup for ${shortPubkey(author)} failed`);
    }

    const verified = verifySiblingProfile(profile, author, owner);
    this.#cacheSibling(author, verified);
    return verified
      ? allow("sibling", `${shortPubkey(author)} is a verified same-owner sibling`)
      : deny(
          "not-owner-or-sibling",
          `${shortPubkey(author)} has no verifiable NIP-OA attestation from our owner`,
        );
  }

  #cacheSibling(author: string, verified: boolean): void {
    if (this.#siblings.size >= this.#cacheCap) this.#siblings.clear();
    this.#siblings.set(author, verified);
  }

  /** Test and diagnostics hook; the gate never exposes cache contents otherwise. */
  get cacheSize(): number {
    return this.#siblings.size;
  }
}

export function createAuthorGate(options: AuthorGateOptions): AuthorGate {
  return new AuthorGate(options);
}

/**
 * Verifies a candidate sibling's profile.
 *
 * The relay is not trusted for any part of this: the signature is checked
 * locally against the author's own pubkey, so a relay that swaps in someone
 * else's attestation, or an agent that copies a valid tag from another agent's
 * profile, both fail.
 */
export function verifySiblingProfile(
  profile: ProfileSnapshot | null,
  author: string,
  expectedOwner: string,
): boolean {
  if (!profile || !isPubkey(author) || !isPubkey(expectedOwner)) return false;
  if (profile.pubkey !== author) return false;
  const tag = extractAuthTag(profile.tags);
  if (!tag) return false;
  if (tag.ownerPubkey !== expectedOwner) return false;
  return verifyAttestation(tag, author);
}

function allow(code: AuthorDecisionCode, reason: string): AuthorDecision {
  return { allowed: true, code, reason };
}

function deny(code: AuthorDecisionCode, reason: string): AuthorDecision {
  return { allowed: false, code, reason };
}

/** Resolves a channel record's type field, mapping anything unrecognised to `unknown`. */
export function toChannelType(value: string | null | undefined): ChannelType {
  return value === "stream" || value === "private" || value === "dm" ? value : "unknown";
}
