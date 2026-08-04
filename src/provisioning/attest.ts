/**
 * `autogent-nostr attest` — runs on the OWNER's machine (plan §4.2).
 *
 * This is the one unavoidable human step. The owner's secret key signs a NIP-OA
 * attestation binding their identity to the agent pubkey, and the resulting
 * artifact is the only thing that travels back to the agent host.
 *
 * The secret is accepted from a file or from an interactive prompt only. A CLI
 * argument would land in shell history and in every `ps` listing on the box, and
 * an environment variable would be inherited by every child process the shell
 * later spawns; neither is an acceptable place for an owner key.
 */

import { readFile, chmod, rename, writeFile } from "node:fs/promises";
import type { AuthTag } from "../nostr/nip-oa.js";
import { signAttestation, toNostrTag, validateConditions } from "../nostr/nip-oa.js";
import type { NostrTag } from "../nostr/types.js";
import type { PairingRequest } from "./identity-store.js";
import { PUBLIC_ARTIFACT_MODE, ProvisioningError, parsePairingRequest } from "./identity-store.js";
import { readOwnerSecret, type OwnerSecretSource } from "./owner-secret.js";

// Re-exported so existing callers of `attest` keep one import site.
export { readOwnerSecret, readSecretFromTerminal, type OwnerSecretSource } from "./owner-secret.js";

/**
 * Empty conditions are the plan's recommendation (§4.2, §6.2).
 *
 * The NIP-OA grammar ANDs its clauses, so it cannot express "kind 0 OR kind 9 OR
 * kind 20001 OR …". Any non-empty kind constraint would therefore silently
 * block most of what the agent publishes; `provision import` rejects such an
 * attestation outright rather than letting it fail at runtime.
 */
export const DEFAULT_CONDITIONS = "";

/** The artifact carried back to the agent host. Contains no secrets. */
export interface Attestation {
  version: 1;
  agentPubkey: string;
  ownerPubkey: string;
  /** Echoed from the pairing request so the agent can detect a mismatched artifact. */
  relayUrl: string;
  /** Echoed from the pairing request; binds this artifact to one `init` run. */
  nonce: string;
  conditions: string;
  /** Canonical `["auth", owner, conditions, sig]` tag, ready to attach to events. */
  auth: NostrTag;
  createdAt: number;
}


export interface AttestOptions {
  pairingRequest: PairingRequest;
  ownerSecret: OwnerSecretSource;
  /** Defaults to {@link DEFAULT_CONDITIONS}. */
  conditions?: string;
  now?: () => number;
  /** Injectable prompt for tests; defaults to a no-echo terminal read. */
  readSecretLine?: (promptText: string) => Promise<string>;
}

/* -------------------------------------------------------------------------- */
/* Attestation                                                                */
/* -------------------------------------------------------------------------- */

export async function createAttestation(options: AttestOptions): Promise<Attestation> {
  const pairingRequest = parsePairingRequest(options.pairingRequest);
  const conditions = options.conditions ?? DEFAULT_CONDITIONS;

  const problems = validateConditions(conditions);
  if (problems.length > 0) {
    throw new ProvisioningError("invalid-attestation", `invalid conditions: ${problems.join("; ")}`);
  }

  const secret = await readOwnerSecret(options.ownerSecret, options.readSecretLine);
  let tag: AuthTag;
  try {
    tag = signAttestation(secret, pairingRequest.agentPubkey, conditions);
  } catch (error) {
    const message = (error as Error).message;
    // `signAttestation` refuses owner == agent; surface it as its own code so the
    // CLI can explain that the operator pasted the agent's own key.
    if (/different keys/.test(message)) {
      throw new ProvisioningError(
        "self-attestation",
        "the owner key is the agent's own key — an agent cannot attest itself",
      );
    }
    throw new ProvisioningError("invalid-attestation", message);
  } finally {
    secret.fill(0);
  }

  return {
    version: 1,
    agentPubkey: pairingRequest.agentPubkey,
    ownerPubkey: tag.ownerPubkey,
    relayUrl: pairingRequest.relayUrl,
    nonce: pairingRequest.nonce,
    conditions,
    auth: toNostrTag(tag),
    createdAt: (options.now ?? Date.now)(),
  };
}

export async function readPairingRequestFile(path: string): Promise<PairingRequest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ProvisioningError("invalid-pairing-request", `cannot read pairing request ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ProvisioningError("invalid-pairing-request", `${path} is not valid JSON`);
  }
  return parsePairingRequest(parsed);
}

export async function writeAttestationFile(path: string, attestation: Attestation): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(attestation, null, 2)}\n`, {
    mode: PUBLIC_ARTIFACT_MODE,
  });
  await chmod(temporary, PUBLIC_ARTIFACT_MODE);
  await rename(temporary, path);
}

export interface AttestFileOptions extends Omit<AttestOptions, "pairingRequest"> {
  pairingRequestPath: string;
  outPath: string;
}

/** File-in / file-out form, which is what the CLI binds to. */
export async function attestFromFile(options: AttestFileOptions): Promise<Attestation> {
  const pairingRequest = await readPairingRequestFile(options.pairingRequestPath);
  const attestation = await createAttestation({ ...options, pairingRequest });
  await writeAttestationFile(options.outPath, attestation);
  return attestation;
}
