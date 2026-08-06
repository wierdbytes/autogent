/**
 * Owner-side credential push: a re-login on an *already deployed* profile
 * takes effect immediately instead of at the next deploy.
 *
 * Without this, `autogent auth login` only rewrote the profile-scoped
 * `profiles/<name>/auth.json`; the per-agent copy under `agents/<pubkey>/`
 * was written once at first deploy (adoption) and the relay head was
 * republished only by a deploy/redeploy. A re-login therefore looked like it
 * had done something while the running agent kept the old credential.
 *
 * This module closes that gap by doing exactly what the deploy path does,
 * in the same order and under the same 1:1 account↔agent rule: bind, store
 * per-agent, then publish a fresh `autogent/auth` head signed as the agent.
 * The runtime materialises the new head live (`#onAuthRecord`), so no Pod
 * restart is involved.
 *
 * It is deliberately *not* fail-closed the way the wire path is: this is an
 * interactive owner action, not a backend protocol frame, so cluster/relay
 * trouble is reported as an outcome (`local-only`) rather than thrown. The
 * per-agent file is already correct at that point, and the next
 * deploy/redeploy publishes it — `publishDeployRecords` always ships the
 * `AUTH_SLUG` head from that file.
 */

import { parseDeployPayload, type DeployPayload } from "../backend/payload.js";
import { createEventBuilder } from "../nostr/event-builder.js";
import { AUTH_SLUG } from "../nostr/config-records.js";
import { RecordClient } from "../nostr/record-client.js";
import { RelaySupervisor } from "../nostr/relay-supervisor.js";
import { createSigner } from "../nostr/signer.js";
import {
  recordBinding,
  writeAgentAuth,
  type AccountBinding,
} from "../owner-auth/store.js";
import type { DeployProfile } from "../registry/profiles.js";
import { systemClock } from "../runtime/clock.js";
import { nullLogger } from "../runtime/logger.js";
import { authValueFromContent } from "../runtime/provider-auth.js";
import { providerConfigFromProfile } from "./config.js";
import { getJson, listJson, type KubectlOptions } from "./kubectl.js";
import { passthroughEnvFromPod, readBootstrapTriple } from "./redeploy.js";

export type PushAuthOutcome =
  | { state: "pushed" }
  /** Binding conflict: the account already drives another agent. Nothing was written. */
  | { state: "conflict"; conflict: AccountBinding }
  /** Cluster/relay unreachable: the per-agent copy IS updated; the next deploy publishes it. */
  | { state: "local-only"; reason: string };

export interface PushAuthInput {
  /** Caller guarantees `agentPubkey !== null` (never-deployed profiles adopt at deploy). */
  profile: DeployProfile;
  /** Fresh profile auth.json bytes. */
  authJson: string;
  report?: (message: string) => void;
  /** Injected in tests. */
  getJson?: typeof getJson;
  listJson?: typeof listJson;
  publishRecord?: (payload: DeployPayload, value: Record<string, unknown>) => Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Signs and publishes a single `autogent/auth` head as the agent — the same
 * shape `publishDeployRecords` writes, minus the core/langfuse records, which
 * a credential refresh has no business touching.
 */
async function publishAuthRecord(
  payload: DeployPayload,
  value: Record<string, unknown>,
): Promise<void> {
  const signer = createSigner(new Uint8Array(payload.secret));
  const builder = createEventBuilder({ signer, authTag: payload.auth, clock: systemClock });
  const relay = new RelaySupervisor({
    url: payload.relayUrl,
    builder,
    clock: systemClock,
    logger: nullLogger,
  });
  try {
    await relay.connect();
    const records = new RecordClient({ relay, signer, clock: systemClock });
    await records.publish(AUTH_SLUG, { slug: AUTH_SLUG, value });
  } finally {
    // The supervisor owns a socket; leaking it would keep the CLI alive.
    await relay.close();
  }
}

/**
 * Rewrites the provider credential of a deployed agent: per-agent store first,
 * relay head second. See the module note for why failures past the local write
 * degrade instead of throwing.
 */
export async function pushProfileAuth(input: PushAuthInput): Promise<PushAuthOutcome> {
  const { profile, authJson } = input;
  const report = input.report ?? (() => {});
  const agentPubkey = profile.agentPubkey!;

  // 1. The same 1:1 account↔agent rule the deploy-time adoption enforces: a
  //    credential already driving another agent is refused *before* anything
  //    on disk changes, so a mistake here leaves both agents untouched.
  const binding = await recordBinding(agentPubkey, authJson);
  if (!binding.ok) return { state: "conflict", conflict: binding.conflict };

  // 2. Store per-agent before touching the network. From here on the new
  //    credential is the one every future deploy/redeploy publishes, so even a
  //    dead cluster cannot leave the owner with a silently stale agent.
  await writeAgentAuth(agentPubkey, authJson);

  const value = authValueFromContent(authJson);
  if (value === null) {
    return { state: "local-only", reason: "the credential file is not a JSON object" };
  }

  const config = providerConfigFromProfile(profile);
  const kube: KubectlOptions = { context: config.kubeContext, namespace: config.namespace };
  const io = { getJson: input.getJson ?? getJson, listJson: input.listJson ?? listJson };

  // 3. The identity (nsec) lives only in the cluster Secret, so publishing as
  //    the agent means reading it back — exactly like a redeploy does.
  report("Reading the bootstrap Secret from the cluster");
  let triple: Awaited<ReturnType<typeof readBootstrapTriple>>;
  try {
    triple = await readBootstrapTriple(agentPubkey, kube, io);
  } catch (error) {
    return { state: "local-only", reason: describe(error) };
  }

  // 4. Same fail-closed parser as the wire/redeploy path: the identity is
  //    re-derived from the nsec and the attestation re-verified against it, so
  //    a stale or foreign Secret can never be signed with.
  let payload: DeployPayload;
  try {
    payload = parseDeployPayload({
      name: profile.name,
      relay_url: triple.triple.relayUrl,
      private_key_nsec: triple.triple.nsec,
      auth_tag: triple.triple.authTagJson,
      env_vars: passthroughEnvFromPod(triple.pod),
    });
  } catch (error) {
    return { state: "local-only", reason: describe(error) };
  }
  if (payload.agentPubkey !== profile.agentPubkey) {
    return {
      state: "local-only",
      reason:
        `the cluster Secret holds the key of ${payload.agentPubkey.slice(0, 12)}…, but the ` +
        `profile is bound to ${agentPubkey.slice(0, 12)}… — refusing to publish under a ` +
        "mismatched identity",
    };
  }

  // 5. Publish the new head. A relay refusal is not a local corruption: the
  //    file already holds the truth, so degrade rather than unwind.
  report("Publishing the new credential head");
  try {
    await (input.publishRecord ?? publishAuthRecord)(payload, value);
  } catch (error) {
    return {
      state: "local-only",
      reason: `failed to publish to ${payload.relayUrl}: ${describe(error)}`,
    };
  }

  return { state: "pushed" };
}
