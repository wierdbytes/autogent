/**
 * Host-owned Nostr signer (plan §10.1).
 *
 * The secret key lives here and nowhere else: it is never written to config
 * JSON, never re-exported to `process.env`, and never handed to Pi tools, the
 * shell, or MCP servers. Everything that needs a signature asks this object.
 */

import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
  getConversationKey,
} from "nostr-tools/nip44";
import { decode as nip19Decode } from "nostr-tools/nip19";
import { hexToBytes } from "nostr-tools/utils";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { NostrEvent, UnsignedNostrEvent } from "./types.js";

/** Everything the runtime is allowed to do with the agent identity. */
export interface Signer {
  readonly publicKey: string;
  sign(event: UnsignedNostrEvent): NostrEvent;
  /** NIP-44 v2 encrypt to `recipientPubkey`. */
  encrypt(recipientPubkey: string, plaintext: string): string;
  /** NIP-44 v2 decrypt from `senderPubkey`. */
  decrypt(senderPubkey: string, ciphertext: string): string;
  /** BIP-340 signature over an arbitrary 32-byte digest (used by NIP-OA tooling). */
  signDigest(digest: Uint8Array): string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isPubkey(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

/** Accepts a 64-char hex secret or an `nsec1…` bech32 secret. */
export function decodeSecretKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (HEX64.test(trimmed)) return hexToBytes(trimmed);
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19Decode(trimmed);
    if (decoded.type !== "nsec") throw new Error(`expected an nsec key, got ${decoded.type}`);
    return decoded.data as Uint8Array;
  }
  throw new Error("secret key must be 64-char hex or nsec1…");
}

class LocalSigner implements Signer {
  readonly publicKey: string;
  readonly #secret: Uint8Array;
  /** ECDH conversation keys are expensive; cache per counterparty. */
  readonly #conversationKeys = new Map<string, Uint8Array>();

  constructor(secret: Uint8Array) {
    if (secret.length !== 32) throw new Error("secret key must be 32 bytes");
    this.#secret = secret;
    this.publicKey = getPublicKey(secret);
  }

  sign(event: UnsignedNostrEvent): NostrEvent {
    if (event.pubkey !== this.publicKey) {
      throw new Error("refusing to sign an event authored by another pubkey");
    }
    return finalizeEvent(
      { kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content },
      this.#secret,
    ) as NostrEvent;
  }

  #conversationKey(counterparty: string): Uint8Array {
    let key = this.#conversationKeys.get(counterparty);
    if (!key) {
      key = getConversationKey(this.#secret, counterparty);
      this.#conversationKeys.set(counterparty, key);
    }
    return key;
  }

  encrypt(recipientPubkey: string, plaintext: string): string {
    return nip44Encrypt(plaintext, this.#conversationKey(recipientPubkey));
  }

  decrypt(senderPubkey: string, ciphertext: string): string {
    return nip44Decrypt(ciphertext, this.#conversationKey(senderPubkey));
  }

  signDigest(digest: Uint8Array): string {
    return Buffer.from(schnorr.sign(digest, this.#secret)).toString("hex");
  }
}

export function createSigner(secret: Uint8Array): Signer {
  return new LocalSigner(secret);
}

/**
 * Verifies NIP-01 `id` and `sig`. Returns false rather than throwing.
 *
 * The id is recomputed here instead of delegating entirely to `verifyEvent`,
 * which memoises its verdict on the event object under a symbol. That cache is
 * keyed by object identity, so a derived object carrying the symbol would
 * inherit a verdict it never earned. Recomputing costs one hash and removes the
 * question.
 */
export function verifyNostrEvent(event: NostrEvent): boolean {
  try {
    if (getEventHash(event as Parameters<typeof getEventHash>[0]) !== event.id) return false;
    return verifyEvent(event as Parameters<typeof verifyEvent>[0]);
  } catch {
    return false;
  }
}

/** SHA-256 of a UTF-8 string, as raw bytes. Used for NIP-OA preimages. */
export function sha256Utf8(value: string): Uint8Array {
  return sha256(new TextEncoder().encode(value));
}
