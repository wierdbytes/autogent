/**
 * NIP-42 client authentication.
 *
 * The relay opens with `["AUTH", <challenge>]`, we answer with a signed kind
 * 22242 event, and the relay replies `["OK", <id>, <bool>, <message>]`. The
 * handshake is redone on every socket, before any REQ is re-sent, because the
 * challenge is bound to the connection.
 */

import { extractAuthTag, verifyAttestation } from "./nip-oa.js";
import type { EventBuilderPort } from "../runtime/ports.js";
import { verifyNostrEvent } from "./signer.js";
import { KIND, type NostrEvent, tagValue } from "./types.js";

/** Relay's grace window for a client auth event, in seconds (NIP-42). */
export const AUTH_MAX_SKEW_SEC = 600;

/**
 * Canonical form used when comparing the `relay` tag.
 *
 * NIP-42 requires only that the URL "matches"; relays and clients disagree on
 * trailing slashes and case, so both sides are normalised before comparison.
 */
export function normalizeRelayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

export function buildAuthEvent(
  builder: EventBuilderPort,
  relayUrl: string,
  challenge: string,
): NostrEvent {
  return builder.build({
    kind: KIND.CLIENT_AUTH,
    tags: [
      ["relay", relayUrl],
      ["challenge", challenge],
    ],
    content: "",
  });
}

export interface AuthEventExpectation {
  relayUrl: string;
  challenge: string;
  /** When set, the event must be authored by this pubkey. */
  agentPubkey?: string;
  /** Seconds since the epoch. */
  now: number;
  maxSkewSec?: number;
}

export type AuthEventVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Server-side view of the handshake: what a relay checks before answering `OK`.
 *
 * Lives next to the builder so the wire contract has one definition that both
 * the client and the test relay agree on.
 */
export function verifyAuthEvent(
  event: NostrEvent,
  expectation: AuthEventExpectation,
): AuthEventVerdict {
  if (event.kind !== KIND.CLIENT_AUTH) return { ok: false, reason: `invalid: kind ${event.kind}` };
  if (expectation.agentPubkey !== undefined && event.pubkey !== expectation.agentPubkey) {
    return { ok: false, reason: "restricted: unexpected author" };
  }
  if (!verifyNostrEvent(event)) return { ok: false, reason: "invalid: bad id or signature" };

  const skew = Math.abs(expectation.now - event.created_at);
  if (skew > (expectation.maxSkewSec ?? AUTH_MAX_SKEW_SEC)) {
    return { ok: false, reason: "invalid: created_at out of range" };
  }

  const relay = tagValue(event, "relay");
  if (relay === undefined || normalizeRelayUrl(relay) !== normalizeRelayUrl(expectation.relayUrl)) {
    return { ok: false, reason: "invalid: relay tag mismatch" };
  }
  if (tagValue(event, "challenge") !== expectation.challenge) {
    return { ok: false, reason: "invalid: challenge mismatch" };
  }

  const auth = extractAuthTag(event.tags);
  if (auth === null) return { ok: false, reason: "restricted: missing or duplicated auth tag" };
  if (!verifyAttestation(auth, event.pubkey)) {
    return { ok: false, reason: "restricted: owner attestation does not verify" };
  }
  return { ok: true };
}
