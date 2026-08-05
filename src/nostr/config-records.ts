/**
 * Agent config records — NIP-78 `kind:30078`, self-signed and self-encrypted.
 *
 * A config record is a parameterised-replaceable event authored by the agent
 * key, whose `d` tag is an HMAC over the agent's NIP-44 *self* conversation
 * key (the key derived between the agent key and its own pubkey) and whose
 * content is a NIP-44 ciphertext under that same key. Only holders of the
 * agent secret — the agent process and the owner-side deploy tooling, which
 * keeps the nsec by design — can read, address, or write one.
 *
 * Two records are stored this way:
 *
 * - slug `autogent/config` — the agent's effective configuration: a versioned
 *   JSON document stored as-is in the body's `value` field;
 * - slug `autogent/auth` — a pi-compatible `auth.json` document stored as-is
 *   in the body's `value` field; `value: null` is a tombstone (read as
 *   absent).
 *
 * Unlike the earlier NIP-AE engram channel (kind 30174), records carry no
 * `p` tag and no NIP-OA auth tag: nothing on the wire links the record — or
 * the channel — to the owner pubkey. Every body is `{ slug, value }` with
 * `value` carrying the JSON document exactly as it appears in its final
 * form — the config document itself, the `auth.json` document itself.
 */

import { verifyNostrEvent, type Signer } from "./signer.js";
import { KIND, tagsNamed, type NostrEvent } from "./types.js";

/**
 * Domain separator for d-tag derivation. Deliberately distinct from NIP-AE's
 * `agent-memory/v1/d-tag` so records can never collide with engrams even if
 * both channels ever coexist under one key.
 */
const D_TAG_DOMAIN = "agent-config/v1/d-tag";

/** `autogent/<seg>(/<seg>)*`, ≤255 bytes. */
const SLUG_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SLUG_NAMESPACE = "autogent/";

export const CONFIG_SLUG = "autogent/config";
export const AUTH_SLUG = "autogent/auth";

export function isValidSlug(slug: string): boolean {
  if (Buffer.byteLength(slug, "utf8") > 255) return false;
  if (!slug.startsWith(SLUG_NAMESPACE)) return false;
  const segments = slug.slice(SLUG_NAMESPACE.length).split("/");
  return segments.length > 0 && segments.every((segment) => SLUG_SEGMENT.test(segment));
}

/**
 * `d = lower_hex(HMAC-SHA256(K_self, "agent-config/v1/d-tag" || 0x00 || slug))`.
 *
 * `K_self` is the NIP-44 conversation key of the agent key with its own
 * pubkey — computable only with the agent secret. The slug never appears in
 * tags; the derived tag reveals nothing about the record to anyone else, and
 * the HMAC keys the `d` namespace so no other application writing kind 30078
 * under this pubkey can collide with it.
 */
export function deriveRecordDTag(signer: Signer, slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid config-record slug: ${slug}`);
  const domain = Buffer.from(D_TAG_DOMAIN, "utf8");
  const body = Buffer.from(slug, "utf8");
  const message = new Uint8Array(domain.length + 1 + body.length);
  message.set(domain, 0);
  message[domain.length] = 0x00;
  message.set(body, domain.length + 1);
  return Buffer.from(signer.conversationHmac(signer.publicKey, message)).toString("hex");
}

/* -------------------------------------------------------------------------- */
/* Bodies                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every record body is `{ slug, value }`, with `value` carrying the JSON
 * document exactly as it appears in its final form: the config document for
 * `autogent/config`, the `auth.json` document for `autogent/auth`. A
 * `value: null` is a tombstone (read as absent).
 */
export interface RecordBody {
  slug: string;
  value: unknown;
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
export function parseRecordBody(plaintext: string, expectedSlug: string): RecordBody | null {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  const object = asObject(value);
  if (!object) return null;
  if (object["slug"] !== expectedSlug) return null;
  if (!isValidSlug(expectedSlug)) return null;

  const bodyValue = object["value"];
  if (bodyValue !== null && (typeof bodyValue !== "object" || Array.isArray(bodyValue))) return null;
  // The config document cannot be tombstoned: an agent without a config record
  // is degraded, never revoked.
  if (expectedSlug === CONFIG_SLUG && bodyValue === null) return null;
  return { slug: expectedSlug, value: bodyValue };
}

export function serializeRecordBody(body: RecordBody): string {
  const json = JSON.stringify(body);
  // NIP-44 plaintext ceiling; a body over it can never be published.
  if (Buffer.byteLength(json, "utf8") > 65_535) {
    throw new Error(`config record body for ${body.slug} exceeds the 65535-byte NIP-44 limit`);
  }
  return json;
}

/* -------------------------------------------------------------------------- */
/* Head selection                                                             */
/* -------------------------------------------------------------------------- */

export interface RecordHead {
  event: NostrEvent;
  body: RecordBody;
  createdAt: number;
}

export interface HeadContext {
  /** Must hold the agent secret; decrypts against its own pubkey. */
  signer: Signer;
  agentPubkey: string;
  slug: string;
  /** Precomputed d-tag; derived from the slug when absent. */
  dTag?: string;
}

/**
 * Selects and validates the record head from a set of candidate events:
 * greatest `created_at`, ties broken by lowest id (NIP-01 addressable
 * semantics); signature checked before decryption; body must parse and match
 * the slug.
 *
 * Candidates that fail validation are skipped rather than failing the whole
 * selection, so one malformed replayed event cannot mask a valid head.
 */
export function selectRecordHead(events: readonly NostrEvent[], context: HeadContext): RecordHead | null {
  const dTag = context.dTag ?? deriveRecordDTag(context.signer, context.slug);
  const ordered = [...events].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : b.created_at - a.created_at,
  );

  for (const event of ordered) {
    if (event.kind !== KIND.APP_DATA) continue;
    if (event.pubkey !== context.agentPubkey) continue;
    const dTags = tagsNamed(event, "d");
    if (dTags.length !== 1) continue;
    if (dTags[0]?.[1] !== dTag) continue;
    if (!verifyNostrEvent(event)) continue;

    let plaintext: string;
    try {
      plaintext = context.signer.decrypt(context.agentPubkey, event.content);
    } catch {
      continue;
    }
    const body = parseRecordBody(plaintext, context.slug);
    if (!body) continue;
    return { event, body, createdAt: event.created_at };
  }
  return null;
}

/** True when a head is a tombstoned memory record (`value: null`). */
export function isTombstone(head: RecordHead): boolean {
  return head.body.slug !== CONFIG_SLUG && head.body.value === null;
}
