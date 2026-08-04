/**
 * NIP-AE — agent memory engrams, kind 30174 (remote plan §2, §3).
 *
 * An engram is a parameterised-replaceable event whose `d` tag is an HMAC over
 * the NIP-44 conversation key between agent and owner, and whose content is a
 * NIP-44 ciphertext of a small JSON body. Exactly two parties can read or
 * address one: the agent and the owner (the conversation key is symmetric).
 *
 * The remote-nodes plan stores two records this way:
 *
 * - slug `core` — the agent's effective configuration, serialised into the
 *   NIP-AE core body's `profile` field (the NIP defines core as "agent
 *   identity, rules, goals"; the config JSON is exactly that, machine-shaped);
 * - slug `mem/provider-auth` — a pi-compatible `auth.json` payload in a memory
 *   body's `value` field.
 *
 * Keeping the plan's payloads inside the NIP's body grammar means any
 * conforming NIP-AE reader (including Buzz's) sees valid records rather than
 * a private dialect.
 */

import { verifyNostrEvent, type Signer } from "./signer.js";
import { KIND, tagsNamed, type NostrEvent } from "./types.js";

/** Domain separator for d-tag derivation, fixed by the NIP-AE spec. */
const D_TAG_DOMAIN = "agent-memory/v1/d-tag";

/** `core` or `mem/<seg>(/<seg>)*`, ≤255 bytes (NIP-AE slug grammar). */
const SLUG_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const CORE_SLUG = "core";
export const PROVIDER_AUTH_SLUG = "mem/provider-auth";

export function isValidSlug(slug: string): boolean {
  if (slug === CORE_SLUG) return true;
  if (Buffer.byteLength(slug, "utf8") > 255) return false;
  if (!slug.startsWith("mem/")) return false;
  const segments = slug.slice("mem/".length).split("/");
  return segments.length > 0 && segments.every((segment) => SLUG_SEGMENT.test(segment));
}

/**
 * `d = lower_hex(HMAC-SHA256(K_c, "agent-memory/v1/d-tag" || 0x00 || slug))`.
 *
 * The slug never appears in tags; the derived tag reveals nothing about the
 * record to anyone without the conversation key.
 */
export function deriveEngramDTag(signer: Signer, counterpartyPubkey: string, slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid NIP-AE slug: ${slug}`);
  const domain = Buffer.from(D_TAG_DOMAIN, "utf8");
  const body = Buffer.from(slug, "utf8");
  const message = new Uint8Array(domain.length + 1 + body.length);
  message.set(domain, 0);
  message[domain.length] = 0x00;
  message.set(body, domain.length + 1);
  return Buffer.from(signer.conversationHmac(counterpartyPubkey, message)).toString("hex");
}

/* -------------------------------------------------------------------------- */
/* Bodies                                                                     */
/* -------------------------------------------------------------------------- */

/** The NIP-AE core record: one per (agent, owner) pair. */
export interface CoreBody {
  slug: typeof CORE_SLUG;
  /** Free-form UTF-8. The remote plan stores the config JSON here. */
  profile: string;
}

/** A NIP-AE memory record. `value: null` is a tombstone (read as absent). */
export interface MemoryBody {
  slug: string;
  value: string | null;
}

export type EngramBody = CoreBody | MemoryBody;

/** Narrowing guard: `MemoryBody["slug"]` is `string`, so `slug` alone cannot. */
export function isCoreBody(body: EngramBody): body is CoreBody {
  return body.slug === CORE_SLUG && "profile" in body;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parses and shape-checks a decrypted body against the slug it was fetched
 * under. Returns null on any mismatch — a body that does not re-derive to the
 * queried d-tag is an attack or corruption, not a variant to accommodate.
 */
export function parseEngramBody(plaintext: string, expectedSlug: string): EngramBody | null {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  const object = asObject(value);
  if (!object) return null;
  if (object["slug"] !== expectedSlug) return null;

  if (expectedSlug === CORE_SLUG) {
    if (typeof object["profile"] !== "string") return null;
    return { slug: CORE_SLUG, profile: object["profile"] };
  }
  if (!isValidSlug(expectedSlug)) return null;
  const bodyValue = object["value"];
  if (bodyValue !== null && typeof bodyValue !== "string") return null;
  return { slug: expectedSlug, value: bodyValue };
}

export function serializeEngramBody(body: EngramBody): string {
  const json = JSON.stringify(body);
  // NIP-44 plaintext ceiling; a body over it can never be published.
  if (Buffer.byteLength(json, "utf8") > 65_535) {
    throw new Error(`engram body for ${body.slug} exceeds the 65535-byte NIP-44 limit`);
  }
  return json;
}

/* -------------------------------------------------------------------------- */
/* Head selection                                                             */
/* -------------------------------------------------------------------------- */

export interface EngramHead {
  event: NostrEvent;
  body: EngramBody;
  createdAt: number;
}

export interface HeadContext {
  signer: Signer;
  agentPubkey: string;
  ownerPubkey: string;
  slug: string;
  /** Precomputed d-tag; derived from the slug when absent. */
  dTag?: string;
}

/**
 * Selects and validates the engram head from a set of candidate events
 * (NIP-AE §Head Selection): greatest `created_at`, ties broken by lowest id;
 * signature checked before decryption; body must parse and match the slug.
 *
 * Candidates that fail validation are skipped rather than failing the whole
 * selection, so one malformed replayed event cannot mask a valid head.
 */
export function selectEngramHead(events: readonly NostrEvent[], context: HeadContext): EngramHead | null {
  const dTag = context.dTag ?? deriveEngramDTag(context.signer, context.ownerPubkey, context.slug);
  const ordered = [...events].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : b.created_at - a.created_at,
  );

  for (const event of ordered) {
    if (event.kind !== KIND.ENGRAM) continue;
    if (event.pubkey !== context.agentPubkey) continue;
    const dTags = tagsNamed(event, "d");
    const pTags = tagsNamed(event, "p");
    if (dTags.length !== 1 || pTags.length !== 1) continue;
    if (dTags[0]?.[1] !== dTag) continue;
    if (pTags[0]?.[1] !== context.ownerPubkey) continue;
    if (!verifyNostrEvent(event)) continue;

    let plaintext: string;
    try {
      plaintext = context.signer.decrypt(context.ownerPubkey, event.content);
    } catch {
      continue;
    }
    const body = parseEngramBody(plaintext, context.slug);
    if (!body) continue;
    return { event, body, createdAt: event.created_at };
  }
  return null;
}

/** True when a head is a tombstoned memory record (`value: null`). */
export function isTombstone(head: EngramHead): boolean {
  return head.body.slug !== CORE_SLUG && (head.body as MemoryBody).value === null;
}
