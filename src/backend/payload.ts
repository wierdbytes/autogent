/**
 * The `deploy` payload: parsing, identity derivation, owner resolution.
 *
 * Two rules from the spec govern this file and are worth stating up front:
 *
 * - **Identity is derived, never accepted.** The payload carries an nsec, not a
 *   pubkey. Every name, lookup and comparison downstream uses the pubkey we
 *   derive from that nsec (spec §Deploy State Machine, step 0), so a caller
 *   cannot aim this provider at another agent's instance by lying about it.
 * - **Fail closed before any mutation.** A malformed key, a missing owner
 *   attestation, or a `relay-mesh` provider is refused *before* a directory is
 *   created or a process is spawned.
 */

import type { AuthTag } from "../nostr/nip-oa.js";
import { kindsNotCovered, parseAuthTag, verifyAttestation } from "../nostr/nip-oa.js";
import { createSigner, decodeSecretKey, isPubkey } from "../nostr/signer.js";
import { AGENT_PUBLISHED_KINDS } from "../nostr/types.js";
import { fail } from "./wire.js";

export type RespondTo = "owner-only" | "allowlist" | "anyone" | "nobody";

const RESPOND_TO: ReadonlySet<string> = new Set([
  "owner-only",
  "allowlist",
  "anyone",
  "nobody",
]);

export interface LaunchBlock {
  command: string | null;
  args: string[];
  /** User/layered env — tier 2. Already merged global < persona < agent. */
  env: Record<string, string>;
  /** Overridable behaviour defaults — tier 1. */
  policyEnv: Record<string, string>;
  ownerPubkey: string | null;
}

export interface DeployPayload {
  name: string;
  relayUrl: string;
  /** Raw 32 bytes. Never logged, never placed in an environment. */
  secret: Uint8Array;
  /** Derived from {@link secret}. The identity everything else is keyed on. */
  agentPubkey: string;
  auth: AuthTag;
  ownerPubkey: string;
  respondTo: RespondTo;
  respondToAllowlist: string[];
  systemPrompt: string | null;
  model: string | null;
  /** Legacy user env. Used only when `launch` is absent. */
  envVars: Record<string, string>;
  launch: LaunchBlock | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`agent.${key} must be a string or null`);
  return value === "" ? null : value;
}

function requiredString(object: Record<string, unknown>, key: string): string {
  const value = optionalString(object, key);
  if (value === null) fail(`agent.${key} is required`);
  return value;
}

function stringList(object: Record<string, unknown>, key: string): string[] {
  const value = object[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`agent.${key} must be an array of strings`);
  }
  return value as string[];
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  const object = asObject(value);
  if (!object) fail(`${label} must be a JSON object`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== "string") fail(`${label}.${key} must be a string`);
    out[key] = item;
  }
  return out;
}

function parseLaunch(value: unknown): LaunchBlock | null {
  if (value === undefined || value === null) return null;
  const object = asObject(value);
  if (!object) fail("agent.launch must be a JSON object");
  const ownerPubkey = optionalString(object, "owner_pubkey");
  if (ownerPubkey !== null && !isPubkey(ownerPubkey)) {
    fail("agent.launch.owner_pubkey must be 64-char lowercase hex");
  }
  return {
    command: optionalString(object, "command"),
    args: stringList(object, "args"),
    env: stringMap(object["env"], "agent.launch.env"),
    policyEnv: stringMap(object["policy_env"], "agent.launch.policy_env"),
    ownerPubkey,
  };
}

/**
 * Resolves the owner attestation.
 *
 * `autogent-nostr` publishes NIP-OA-attested events: every event it signs
 * carries the owner's `auth` tag, and the relay verifies it. A bare
 * `owner_pubkey` — enough for the `buzz-acp` harness, which can fall back to it
 * for the `!shutdown` gate — is *not* enough here, so a record with no
 * `auth_tag` is refused with an actionable message instead of deploying an
 * agent whose every publish would be rejected by the relay.
 *
 * The tag is verified against the **derived** agent pubkey, so a payload cannot
 * hand us an attestation minted for somebody else.
 */
function resolveAuth(
  rawAuthTag: string | null,
  agentPubkey: string,
  launch: LaunchBlock | null,
): AuthTag {
  if (rawAuthTag === null) {
    fail(
      "agent.auth_tag is missing: this agent record has no NIP-OA owner attestation. " +
        "autogent-nostr signs every event with the owner's auth tag, so it cannot be " +
        "deployed from a legacy record — recreate the agent in Buzz Desktop so an " +
        "auth tag is minted for it.",
    );
  }

  let parts: unknown;
  try {
    parts = JSON.parse(rawAuthTag);
  } catch {
    fail("agent.auth_tag is not valid JSON — expected [\"auth\", owner, conditions, sig]");
  }
  if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string")) {
    fail("agent.auth_tag must be a JSON array of strings");
  }
  const tag = parseAuthTag(parts as string[]);
  if (!tag) fail("agent.auth_tag is malformed — expected [\"auth\", owner, conditions, sig]");

  if (tag.ownerPubkey === agentPubkey) {
    fail("agent.auth_tag is self-attested: the owner and agent pubkeys are identical");
  }
  if (!verifyAttestation(tag, agentPubkey)) {
    fail(
      "agent.auth_tag signature does not verify against the pubkey derived from " +
        "private_key_nsec — the attestation belongs to a different agent key",
    );
  }
  if (launch?.ownerPubkey && launch.ownerPubkey !== tag.ownerPubkey) {
    fail(
      "agent.launch.owner_pubkey disagrees with the owner in agent.auth_tag; " +
        "refusing rather than guessing which owner may stop this agent",
    );
  }

  // Mirrors `provision import`: an attestation that does not cover every kind
  // the agent publishes would strand it mid-flight instead of at boot. The
  // evaluation instant matters because `conditions` may carry a `created_at`
  // bound — an attestation that expires tomorrow passes today and is refused
  // the moment it stops covering the agent's own publishes.
  const uncovered = kindsNotCovered(tag.conditions, AGENT_PUBLISHED_KINDS, Math.floor(Date.now() / 1000));
  if (uncovered.length > 0) {
    fail(
      `agent.auth_tag conditions ${JSON.stringify(tag.conditions)} do not cover kinds ` +
        `${uncovered.join(", ")}, which autogent-nostr must publish`,
    );
  }
  return tag;
}

export function parseDeployPayload(raw: unknown): DeployPayload {
  const agent = asObject(raw);
  if (!agent) fail("deploy request is missing the 'agent' object");

  // Refused before any mutation: the mesh transport resolves to a loopback
  // proxy on the desktop, so a deployed agent would point at its own localhost.
  const provider = optionalString(agent, "provider");
  if (provider !== null && provider.trim() === "relay-mesh") {
    fail(
      "this agent uses Buzz shared compute (relay-mesh), whose transport is a " +
        "loopback proxy on the desktop. Pick a real provider before deploying.",
    );
  }

  const relayUrl = requiredString(agent, "relay_url");
  if (!/^wss?:\/\//.test(relayUrl)) fail("agent.relay_url must start with ws:// or wss://");

  // I1, identity fail-closed: refuse rather than launch identityless.
  const nsec = optionalString(agent, "private_key_nsec");
  if (nsec === null) {
    fail("agent.private_key_nsec is empty — refusing to launch an agent with no identity");
  }

  let secret: Uint8Array;
  let agentPubkey: string;
  try {
    secret = decodeSecretKey(nsec);
    // `createSigner` takes ownership of the array it is given, so the copy it
    // derives the pubkey from is deliberately not the copy we later seal.
    agentPubkey = createSigner(decodeSecretKey(nsec)).publicKey;
  } catch (error) {
    fail(`agent.private_key_nsec is not a usable secret key: ${(error as Error).message}`);
  }

  const launch = parseLaunch(agent["launch"]);
  const auth = resolveAuth(optionalString(agent, "auth_tag"), agentPubkey, launch);

  const respondToRaw = optionalString(agent, "respond_to") ?? "owner-only";
  if (!RESPOND_TO.has(respondToRaw)) {
    fail(`agent.respond_to must be one of ${[...RESPOND_TO].join(", ")}`);
  }

  const allowlist = stringList(agent, "respond_to_allowlist");
  for (const entry of allowlist) {
    if (!isPubkey(entry)) fail(`agent.respond_to_allowlist entry ${entry} is not a hex pubkey`);
  }

  return {
    name: optionalString(agent, "name") ?? "Pi Agent",
    relayUrl,
    secret,
    agentPubkey,
    auth,
    ownerPubkey: auth.ownerPubkey,
    respondTo: respondToRaw as RespondTo,
    respondToAllowlist: allowlist,
    systemPrompt: optionalString(agent, "system_prompt"),
    model: optionalString(agent, "model"),
    envVars: stringMap(agent["env_vars"], "agent.env_vars"),
    launch,
  };
}
