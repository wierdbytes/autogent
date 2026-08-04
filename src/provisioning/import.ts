/**
 * `autogent-nostr provision import` — runs on the agent host (plan §4.3).
 *
 * The attestation arrives over an untrusted path: it may have been edited in a
 * text editor, replayed from an older pairing, or produced for a different
 * agent. Every field is therefore re-derived or re-verified locally, and only
 * the owner pubkey and the canonical auth tag are persisted. Nothing here trusts
 * the artifact's own claims about who signed it.
 */

import { readFile } from "node:fs/promises";
import type { AuthTag } from "../nostr/nip-oa.js";
import { kindsNotCovered, parseAuthTag, verifyAttestation } from "../nostr/nip-oa.js";
import { AGENT_PUBLISHED_KINDS } from "../nostr/types.js";
import { isPubkey } from "../nostr/signer.js";
import type { Attestation } from "./attest.js";
import type {
  IdentityRecord,
  IdentityStore,
  ProvisioningErrorCode,
} from "./identity-store.js";
import { ProvisioningError, createIdentityStore } from "./identity-store.js";

export interface ImportOptions {
  attestation: unknown;
  /** Supply either a live store or the state directory to open one from. */
  store?: IdentityStore;
  stateDir?: string;
  /** Evaluation instant for `created_at` clauses in the conditions. */
  now?: () => number;
}

export interface ImportResult {
  agentPubkey: string;
  ownerPubkey: string;
  conditions: string;
  auth: AuthTag;
  record: IdentityRecord;
}

function reject(code: ProvisioningErrorCode, message: string): never {
  throw new ProvisioningError(code, message);
}

function resolveStore(options: ImportOptions): IdentityStore {
  if (options.store) return options.store;
  if (options.stateDir) return createIdentityStore({ stateDir: options.stateDir });
  reject("identity-missing", "importAttestation needs either a store or a stateDir");
}

export function parseAttestation(value: unknown): Attestation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("invalid-attestation", "attestation must be a JSON object");
  }
  const object = value as Record<string, unknown>;
  if (object["version"] !== 1) reject("invalid-attestation", "unsupported attestation version");

  const agentPubkey = object["agentPubkey"];
  if (!isPubkey(agentPubkey)) {
    reject("invalid-attestation", "agentPubkey must be 64-char lowercase hex");
  }
  const ownerPubkey = object["ownerPubkey"];
  if (!isPubkey(ownerPubkey)) {
    reject("invalid-attestation", "ownerPubkey must be 64-char lowercase hex");
  }
  const relayUrl = object["relayUrl"];
  if (typeof relayUrl !== "string") reject("invalid-attestation", "relayUrl must be a string");
  const nonce = object["nonce"];
  if (typeof nonce !== "string") reject("invalid-attestation", "nonce must be a string");
  const conditions = object["conditions"];
  if (typeof conditions !== "string") reject("invalid-attestation", "conditions must be a string");
  const createdAt = object["createdAt"];
  if (typeof createdAt !== "number") reject("invalid-attestation", "createdAt must be a number");

  const auth = object["auth"];
  if (!Array.isArray(auth) || auth.some((part) => typeof part !== "string")) {
    reject("invalid-attestation", "auth must be an array of strings");
  }

  return {
    version: 1,
    agentPubkey,
    ownerPubkey,
    relayUrl,
    nonce,
    conditions,
    auth: auth as string[],
    createdAt,
  };
}

export async function readAttestationFile(path: string): Promise<Attestation> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    reject("invalid-attestation", `cannot read attestation ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    reject("invalid-attestation", `${path} is not valid JSON`);
  }
  return parseAttestation(parsed);
}

export async function importAttestation(options: ImportOptions): Promise<ImportResult> {
  const attestation = parseAttestation(options.attestation);
  const store = resolveStore(options);
  const record = await store.requireRecord();

  const tag = parseAuthTag(attestation.auth);
  if (!tag) reject("invalid-attestation", "the auth tag is not a well-formed NIP-OA tag");

  // The artifact's own `ownerPubkey`/`conditions` fields are decoration; the tag
  // is what gets attached to events, so disagreement means the file was edited.
  if (tag.ownerPubkey !== attestation.ownerPubkey) {
    reject("invalid-attestation", "the auth tag owner disagrees with the artifact's ownerPubkey");
  }
  if (tag.conditions !== attestation.conditions) {
    reject("invalid-attestation", "the auth tag conditions disagree with the artifact's conditions");
  }

  const signer = await store.loadSigner();
  if (attestation.agentPubkey !== signer.publicKey) {
    reject(
      "pubkey-mismatch",
      `the attestation binds ${attestation.agentPubkey} but this host holds ${signer.publicKey}`,
    );
  }
  if (attestation.agentPubkey !== record.agentPubkey) {
    reject(
      "pubkey-mismatch",
      "the sealed secret does not match the recorded agent pubkey — the state directory is inconsistent",
    );
  }
  if (tag.ownerPubkey === signer.publicKey) {
    reject("self-attestation", "owner and agent are the same key — an agent cannot attest itself");
  }

  if (attestation.nonce !== record.pairing.nonce) {
    reject(
      "nonce-mismatch",
      "the attestation answers a different pairing request — re-run init or re-attest the current pairing-request.json",
    );
  }
  if (attestation.relayUrl !== record.pairing.relayUrl) {
    reject(
      "relay-mismatch",
      `the attestation names relay ${attestation.relayUrl} but this host was initialised for ${record.pairing.relayUrl}`,
    );
  }

  if (!verifyAttestation(tag, signer.publicKey)) {
    reject("signature-invalid", "the NIP-OA signature does not verify against this agent pubkey");
  }

  const now = Math.floor((options.now ?? Date.now)() / 1000);
  const uncovered = kindsNotCovered(tag.conditions, AGENT_PUBLISHED_KINDS, now);
  if (uncovered.length > 0) {
    reject(
      "conditions-incomplete",
      `conditions '${tag.conditions}' do not cover kind(s) ${uncovered.join(", ")}; ` +
        "the NIP-OA grammar ANDs its clauses and cannot express an OR across kinds, " +
        "so re-attest with empty conditions",
    );
  }

  const updated = await store.recordProvisioning(tag.ownerPubkey, tag, (options.now ?? Date.now)());
  return {
    agentPubkey: signer.publicKey,
    ownerPubkey: tag.ownerPubkey,
    conditions: tag.conditions,
    auth: tag,
    record: updated,
  };
}

export interface ImportFileOptions extends Omit<ImportOptions, "attestation"> {
  attestationPath: string;
}

export async function importAttestationFile(options: ImportFileOptions): Promise<ImportResult> {
  const attestation = await readAttestationFile(options.attestationPath);
  return importAttestation({ ...options, attestation });
}
