/**
 * Env bootstrap for container deployments (remote plan §3.1).
 *
 * A remote Pod receives exactly three values through its k8s Secret:
 *
 *   AUTOGENT_NSEC       — the agent secret (bech32 nsec or 64-char hex)
 *   AUTOGENT_RELAY_URL  — wss://…
 *   AUTOGENT_AUTH_TAG   — the NIP-OA attestation, JSON ["auth", owner, cond, sig]
 *
 * On first start this module materialises them into the sealed identity store
 * (0600 files on the PVC) exactly as `init` + `provision import` would have.
 * On every later start the sealed state wins and the env values are ignored:
 * state is the source of truth, the env is only the delivery vehicle. Either
 * way the caller scrubs the variables from `process.env` immediately after.
 *
 * Fail-closed (I1): a present-but-unusable bootstrap refuses loudly rather
 * than starting an agent whose identity is not what the Secret said.
 */

import { parseAuthTag, verifyAttestation, kindsNotCovered, type AuthTag } from "../nostr/nip-oa.js";
import { createSigner, decodeSecretKey } from "../nostr/signer.js";
import { AGENT_PUBLISHED_KINDS } from "../nostr/types.js";
import { randomNonce } from "./init.js";
import {
  IdentityStore,
  ProvisioningError,
  type IdentityRecord,
} from "./identity-store.js";

export const BOOTSTRAP_ENV_VARS = ["AUTOGENT_NSEC", "AUTOGENT_AUTH_TAG"] as const;

export interface BootstrapInputs {
  nsec: string | undefined;
  authTag: string | undefined;
  relayUrl: string;
  profileName: string;
}

export type BootstrapOutcome =
  /** Sealed identity already present; env (if any) deliberately ignored. */
  | { kind: "existing" }
  /** Identity materialised from the env bootstrap on this start. */
  | { kind: "bootstrapped"; agentPubkey: string; ownerPubkey: string }
  /** Nothing sealed and nothing to bootstrap from. */
  | { kind: "absent" };

function parseBootstrapAuthTag(raw: string): AuthTag {
  let parts: unknown;
  try {
    parts = JSON.parse(raw);
  } catch {
    throw new ProvisioningError(
      "invalid-attestation",
      'AUTOGENT_AUTH_TAG is not valid JSON — expected ["auth", owner, conditions, sig]',
    );
  }
  if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string")) {
    throw new ProvisioningError(
      "invalid-attestation",
      "AUTOGENT_AUTH_TAG must be a JSON array of strings",
    );
  }
  const tag = parseAuthTag(parts as string[]);
  if (!tag) {
    throw new ProvisioningError(
      "invalid-attestation",
      'AUTOGENT_AUTH_TAG is malformed — expected ["auth", owner, conditions, sig]',
    );
  }
  return tag;
}

/**
 * Materialises the sealed identity from the bootstrap env if — and only if —
 * no sealed identity exists yet.
 */
export async function bootstrapIdentityFromEnv(
  store: IdentityStore,
  inputs: BootstrapInputs,
  now: () => number = () => Date.now(),
): Promise<BootstrapOutcome> {
  const existing = await store.readRecord();
  if (existing) return { kind: "existing" };

  if (inputs.nsec === undefined || inputs.nsec.trim() === "") {
    if (await store.hasSecret()) return { kind: "existing" };
    return { kind: "absent" };
  }

  if (inputs.authTag === undefined || inputs.authTag.trim() === "") {
    throw new ProvisioningError(
      "invalid-attestation",
      "AUTOGENT_NSEC is set but AUTOGENT_AUTH_TAG is missing — refusing an unowned bootstrap",
    );
  }

  let secret: Uint8Array;
  let agentPubkey: string;
  try {
    secret = decodeSecretKey(inputs.nsec);
    agentPubkey = createSigner(decodeSecretKey(inputs.nsec)).publicKey;
  } catch (error) {
    throw new ProvisioningError(
      "secret-source",
      `AUTOGENT_NSEC is not a usable secret key: ${(error as Error).message}`,
    );
  }

  const auth = parseBootstrapAuthTag(inputs.authTag);
  if (auth.ownerPubkey === agentPubkey) {
    throw new ProvisioningError("self-attestation", "AUTOGENT_AUTH_TAG is self-attested");
  }
  if (!verifyAttestation(auth, agentPubkey)) {
    throw new ProvisioningError(
      "signature-invalid",
      "AUTOGENT_AUTH_TAG does not verify against the pubkey derived from AUTOGENT_NSEC",
    );
  }
  const uncovered = kindsNotCovered(
    auth.conditions,
    AGENT_PUBLISHED_KINDS,
    Math.floor(now() / 1000),
  );
  if (uncovered.length > 0) {
    throw new ProvisioningError(
      "conditions-incomplete",
      `AUTOGENT_AUTH_TAG conditions ${JSON.stringify(auth.conditions)} do not cover kinds ${uncovered.join(", ")}`,
    );
  }

  const at = now();
  const record: IdentityRecord = {
    version: 1,
    agentPubkey,
    createdAt: at,
    // A synthetic pairing request: the pairing dance already happened on the
    // owner side (Desktop minted the key and attestation), but the record
    // shape requires one and `doctor` reasons about it.
    pairing: {
      version: 1,
      agentPubkey,
      relayUrl: inputs.relayUrl,
      profile: { name: inputs.profileName, about: "bootstrapped from deploy secret" },
      nonce: randomNonce(),
    },
    ownerPubkey: auth.ownerPubkey,
    auth,
    provisionedAt: at,
  };

  await store.sealSecret(secret, false);
  secret.fill(0);
  await store.writeRecord(record);
  return { kind: "bootstrapped", agentPubkey, ownerPubkey: auth.ownerPubkey };
}
