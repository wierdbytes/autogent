/**
 * `autogent-nostr init` — first run on the agent host (plan §4.1).
 *
 * Generates the agent keypair, seals it, and emits a pairing request the
 * operator hands to the owner. The pairing request is deliberately inert: it
 * carries a pubkey, a relay URL, profile strings and a nonce, so it can travel
 * over any channel — chat, email, a shared drive — without becoming a secret to
 * manage.
 */

import { randomBytes } from "node:crypto";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { AgentProfile, IdentityRecord, IdentityStore, PairingRequest } from "./identity-store.js";
import { ProvisioningError, createIdentityStore } from "./identity-store.js";

export interface InitOptions {
  stateDir: string;
  relayUrl: string;
  profile: AgentProfile;
  /** Replaces an existing identity. Any prior attestation stops being valid. */
  force?: boolean;
  /** Injectable for deterministic tests; defaults to a fresh secp256k1 key. */
  generateSecret?: () => Uint8Array;
  /** Injectable for deterministic tests; defaults to 32 hex chars of CSPRNG. */
  generateNonce?: () => string;
  now?: () => number;
  store?: IdentityStore;
}

export interface InitResult {
  stateDir: string;
  agentPubkey: string;
  pairingRequest: PairingRequest;
  /** Where the pairing request was written, for the operator to copy. */
  pairingRequestPath: string;
  record: IdentityRecord;
}

/** 128 bits is far more than enough to make a replayed attestation implausible. */
export function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

export async function initIdentity(options: InitOptions): Promise<InitResult> {
  if (!/^wss?:\/\//.test(options.relayUrl)) {
    throw new ProvisioningError(
      "invalid-pairing-request",
      `relayUrl must start with ws:// or wss:// (got ${options.relayUrl})`,
    );
  }

  const store = options.store ?? createIdentityStore({ stateDir: options.stateDir });
  const force = options.force ?? false;

  if (!force && ((await store.hasSecret()) || (await store.readRecord()) !== null)) {
    throw new ProvisioningError(
      "identity-exists",
      `an identity already exists in ${store.stateDir} — pass force to replace it, which invalidates the current attestation`,
    );
  }

  await store.ensureStateDir();

  const secret = (options.generateSecret ?? generateSecretKey)();
  const agentPubkey = getPublicKey(secret);
  await store.sealSecret(secret, force);
  secret.fill(0);

  const pairingRequest: PairingRequest = {
    version: 1,
    agentPubkey,
    relayUrl: options.relayUrl,
    profile: options.profile,
    nonce: (options.generateNonce ?? randomNonce)(),
  };

  const record: IdentityRecord = {
    version: 1,
    agentPubkey,
    createdAt: (options.now ?? Date.now)(),
    pairing: pairingRequest,
    ownerPubkey: null,
    auth: null,
    provisionedAt: null,
  };

  await store.writeRecord(record);
  const pairingRequestPath = await store.writePairingRequest(pairingRequest);

  return { stateDir: store.stateDir, agentPubkey, pairingRequest, pairingRequestPath, record };
}

/**
 * The operator-facing next steps.
 *
 * Kept next to `init` because the wording is part of the provisioning contract:
 * the owner secret must stay on the owner's machine, so the instructions must
 * never suggest copying it here.
 */
export function initInstructions(result: InitResult): string {
  return [
    `Agent pubkey: ${result.agentPubkey}`,
    `State directory: ${result.stateDir}`,
    `Pairing request: ${result.pairingRequestPath}`,
    "",
    "Next, on the OWNER's machine (never on this host):",
    `  autogent-nostr attest ${result.pairingRequestPath} --out attestation.json`,
    "",
    "Then copy attestation.json back here and run:",
    "  autogent-nostr provision import attestation.json",
  ].join("\n");
}
