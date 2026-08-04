/**
 * Materialises the agent's sealed state directory from the deploy payload.
 *
 * This is where this binding differs most visibly from the Kubernetes one.
 * There, identity reaches the agent as `envFrom` a per-attempt Secret. Here the
 * substrate is a process on a shared machine, where an environment is readable
 * by anything running as the same user and shows up in crash dumps and process
 * listings — so the identity is written where `autogent-nostr` already keeps
 * it: a mode-0700 directory holding a mode-0600 key file, through the very same
 * {@link IdentityStore} the `init` / `provision import` commands use. Writing it
 * through the store rather than by hand is deliberate: the record the agent
 * parses at boot and the record we write are produced by one piece of code, so
 * they cannot drift apart.
 *
 * **Residual exposure, stated plainly** (the analogue of the pod binding's
 * "anyone with secret-read in the namespace can read the nsec"): any process
 * running as this user can read the key file, and any host backup that copies
 * the state directory copies the key. The isolation unit here is the user
 * account, and deploying to a shared login accepts its ambient permissions.
 */

import { randomBytes } from "node:crypto";
import type { IdentityRecord, PairingRequest } from "../provisioning/identity-store.js";
import { createIdentityStore } from "../provisioning/identity-store.js";
import type { DeployPayload } from "./payload.js";
import { fail } from "./wire.js";

export interface ProvisionInputs {
  payload: DeployPayload;
  stateDir: string;
  now: number;
}

function newPairing(payload: DeployPayload): PairingRequest {
  return {
    version: 1,
    agentPubkey: payload.agentPubkey,
    relayUrl: payload.relayUrl,
    profile: { name: payload.name, about: "Deployed by Buzz via buzz-backend-autogent" },
    nonce: randomBytes(16).toString("hex"),
  };
}

/**
 * Writes key + identity record, and returns the record that was persisted.
 *
 * Idempotent by construction: a redeploy of the same agent rewrites the same
 * two files with the same key. The database, dedup ledger and outbox living
 * beside them are untouched, which is what lets a restarted agent re-send
 * identical bytes rather than produce a second message.
 */
export async function provisionStateDir(inputs: ProvisionInputs): Promise<IdentityRecord> {
  const { payload, stateDir, now } = inputs;
  const store = createIdentityStore({ stateDir });

  let existing: IdentityRecord | null = null;
  try {
    existing = await store.readRecord();
  } catch {
    // A record we cannot parse is replaced: this directory is ours by
    // construction (its name is derived from the pubkey and the reconciler has
    // already proven ownership of the instance record beside it).
    existing = null;
  }
  if (existing && existing.agentPubkey !== payload.agentPubkey) {
    fail(
      `${stateDir} already holds identity ${existing.agentPubkey.slice(0, 12)}…, ` +
        `not ${payload.agentPubkey.slice(0, 12)}… — refusing to overwrite another agent's key`,
    );
  }

  const pairing: PairingRequest =
    existing?.pairing.agentPubkey === payload.agentPubkey
      ? { ...existing.pairing, relayUrl: payload.relayUrl, profile: { ...existing.pairing.profile, name: payload.name } }
      : newPairing(payload);

  const record: IdentityRecord = {
    version: 1,
    agentPubkey: payload.agentPubkey,
    createdAt: existing?.createdAt ?? now,
    pairing,
    ownerPubkey: payload.ownerPubkey,
    auth: payload.auth,
    provisionedAt: now,
  };

  await store.ensureStateDir();
  await store.sealSecret(payload.secret, true);
  await store.writeRecord(record);
  return record;
}
