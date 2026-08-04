/**
 * Deploy requests for the provider tests.
 *
 * Every request is built from a *real* keypair with a *real* owner attestation,
 * because the provider derives the agent's identity from the nsec and verifies
 * the attestation against it. A hand-written fixture with a fake signature
 * would only ever exercise the refusal path.
 */

import { generateSecretKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import { signAttestation, toNostrTag } from "../../src/nostr/nip-oa.js";
import { createSigner } from "../../src/nostr/signer.js";

export interface MintedAgent {
  agentPubkey: string;
  ownerPubkey: string;
  nsec: string;
  authTag: string;
  /** The `agent` object of a deploy request, shaped exactly as the desktop's. */
  agent: Record<string, unknown>;
}

export function mintAgent(overrides: Record<string, unknown> = {}): MintedAgent {
  const agentSecret = generateSecretKey();
  const ownerSecret = generateSecretKey();
  const agentPubkey = createSigner(Uint8Array.from(agentSecret)).publicKey;
  const ownerPubkey = createSigner(Uint8Array.from(ownerSecret)).publicKey;
  const auth = signAttestation(ownerSecret, agentPubkey, "");
  const authTag = JSON.stringify(toNostrTag(auth));

  const agent: Record<string, unknown> = {
    name: "Test Agent",
    relay_url: "ws://localhost:3000",
    private_key_nsec: nsecEncode(agentSecret),
    auth_tag: authTag,
    agent_command: "autogent-nostr",
    agent_args: [],
    system_prompt: null,
    model: null,
    provider: null,
    turn_timeout_seconds: 300,
    idle_timeout_seconds: null,
    max_turn_duration_seconds: null,
    parallelism: 4,
    respond_to: "owner-only",
    respond_to_allowlist: [],
    env_vars: {},
    launch: {
      command: "autogent-nostr",
      args: [],
      env: {},
      policy_env: {},
      owner_pubkey: ownerPubkey,
    },
    ...overrides,
  };

  return { agentPubkey, ownerPubkey, nsec: agent["private_key_nsec"] as string, authTag, agent };
}
