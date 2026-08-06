/**
 * Owner-side redeploy: republish the config records and roll out a fresh Pod
 * for an already-deployed profile — without a Buzz Desktop payload.
 *
 * The bootstrap triple (nsec, relay URL, auth tag) lives only in the
 * per-generation cluster Secret once Buzz Desktop has deployed the agent, so
 * a redeploy reads it back from there, reconstructs the deploy payload
 * through the same fail-closed parser the wire path uses, and then runs the
 * standard deploy sequence: records first, tag→digest resolution, Pod
 * replace. A mutable image tag that moved since the last deploy is therefore
 * re-resolved and the new digest is what the Pod pins.
 */

import { fail } from "../backend/wire.js";
import { parseDeployPayload } from "../backend/payload.js";
import { markProfileDeployed, type DeployProfile } from "../registry/profiles.js";
import { providerConfigFromProfile } from "./config.js";
import { deployToK8s, type K8sDeployOutcome } from "./deploy.js";
import { getJson, listJson, type KubectlOptions } from "./kubectl.js";
import { agentSelector, podName } from "./names.js";
import { POD_ENV_PASSTHROUGH } from "./records.js";

/** The bootstrap triple as stored in the per-generation Secret (plan §3.1). */
export interface BootstrapTriple {
  nsec: string;
  relayUrl: string;
  authTagJson: string;
}

function decodeData(secret: Record<string, unknown>): Record<string, string> {
  const data = (secret["data"] ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") out[key] = Buffer.from(value, "base64").toString("utf8");
  }
  return out;
}

/** Extracts the bootstrap triple from a Secret object, or explains why not. */
export function bootstrapFromSecret(secret: Record<string, unknown>): BootstrapTriple {
  const data = decodeData(secret);
  const nsec = data["AUTOGENT_NSEC"];
  const relayUrl = data["AUTOGENT_RELAY_URL"];
  const authTagJson = data["AUTOGENT_AUTH_TAG"];
  if (!nsec || !relayUrl || !authTagJson) {
    const name = String(((secret["metadata"] ?? {}) as Record<string, unknown>)["name"] ?? "?");
    fail(
      `Secret ${name} does not carry the full bootstrap triple ` +
        "(AUTOGENT_NSEC, AUTOGENT_RELAY_URL, AUTOGENT_AUTH_TAG) — cannot redeploy from it",
    );
  }
  return { nsec, relayUrl, authTagJson };
}

/** The Pod's passthrough env (relay id, telemetry, …), to survive a redeploy. */
export function passthroughEnvFromPod(
  pod: Record<string, unknown> | null,
): Record<string, string> {
  if (pod === null) return {};
  const spec = (pod["spec"] ?? {}) as Record<string, unknown>;
  const containers = (spec["containers"] ?? []) as Array<Record<string, unknown>>;
  const env = (containers[0]?.["env"] ?? []) as Array<Record<string, unknown>>;
  const out: Record<string, string> = {};
  for (const entry of env) {
    const name = entry["name"];
    const value = entry["value"];
    if (typeof name !== "string" || typeof value !== "string") continue;
    if (POD_ENV_PASSTHROUGH.includes(name)) out[name] = value;
  }
  return out;
}

/** The Secret the live Pod actually references, when there is a live Pod. */
function referencedSecretName(pod: Record<string, unknown> | null): string | null {
  if (pod === null) return null;
  const spec = (pod["spec"] ?? {}) as Record<string, unknown>;
  const containers = (spec["containers"] ?? []) as Array<Record<string, unknown>>;
  const envFrom = (containers[0]?.["envFrom"] ?? []) as Array<Record<string, unknown>>;
  for (const entry of envFrom) {
    const ref = entry["secretRef"] as Record<string, unknown> | undefined;
    const name = ref?.["name"];
    if (typeof name === "string") return name;
  }
  return null;
}

/** The cluster readers this module needs; injected wholesale in tests. */
export interface BootstrapIo {
  getJson: typeof getJson;
  listJson: typeof listJson;
}

async function findBootstrapSecret(
  agentPubkey: string,
  pod: Record<string, unknown> | null,
  kube: KubectlOptions,
  io: BootstrapIo,
): Promise<Record<string, unknown>> {
  // Prefer the Secret the running Pod references — by construction it is the
  // current generation. Without a Pod, fall back to the newest labelled one
  // (GC leaves exactly the current generation behind under normal operation).
  const referenced = referencedSecretName(pod);
  if (referenced !== null) {
    const secret = await io.getJson("secret", referenced, kube);
    if (secret !== null) return secret;
  }
  const secrets = await io.listJson("secret", agentSelector(agentPubkey), kube);
  if (secrets.length === 0) {
    fail(
      "no bootstrap Secret for this agent in the cluster — the identity (nsec) lives only " +
        "there, so a redeploy is impossible; run a full deploy from Buzz Desktop instead",
    );
  }
  const byCreation = [...secrets].sort((a, b) => {
    const at = String(((a["metadata"] ?? {}) as Record<string, unknown>)["creationTimestamp"] ?? "");
    const bt = String(((b["metadata"] ?? {}) as Record<string, unknown>)["creationTimestamp"] ?? "");
    return at.localeCompare(bt);
  });
  return byCreation[byCreation.length - 1]!;
}

/**
 * Reads the bootstrap triple back from the cluster (pod-referenced Secret
 * preferred). The Pod object is returned alongside because callers that
 * rebuild a deploy payload also need its passthrough env — fetching it twice
 * would be a second round-trip for the same object.
 *
 * Throws (via `fail`) when the cluster holds no usable Secret: the identity
 * lives only there, so there is nothing to reconstruct from.
 */
export async function readBootstrapTriple(
  agentPubkey: string,
  kube: KubectlOptions,
  io: BootstrapIo,
): Promise<{ triple: BootstrapTriple; pod: Record<string, unknown> | null }> {
  const pod = await io.getJson("pod", podName(agentPubkey), kube);
  const secret = await findBootstrapSecret(agentPubkey, pod, kube, io);
  return { triple: bootstrapFromSecret(secret), pod };
}

export interface RedeployInput {
  profile: DeployProfile;
  /** Progress line sink for the interactive CLI. */
  report?: (message: string) => void;
  /** Injected in tests. */
  deploy?: typeof deployToK8s;
  getJson?: typeof getJson;
  listJson?: typeof listJson;
}

/**
 * Redeploys an already-deployed profile: reads the bootstrap triple back from
 * the cluster, republishes both config records to the relay, and replaces the
 * Pod at a new generation with the image tag freshly resolved to its digest.
 */
export async function redeployProfile(input: RedeployInput): Promise<K8sDeployOutcome> {
  const { profile } = input;
  const report = input.report ?? (() => {});
  if (profile.agentPubkey === null) {
    fail(
      `profile '${profile.name}' has never been deployed — the identity is minted by ` +
        "Buzz Desktop at first deploy, so there is nothing to redeploy yet",
    );
  }

  const config = providerConfigFromProfile(profile);
  const kube: KubectlOptions = { context: config.kubeContext, namespace: config.namespace };

  report("Reading the bootstrap Secret from the cluster");
  const io = { getJson: input.getJson ?? getJson, listJson: input.listJson ?? listJson };
  const { triple, pod } = await readBootstrapTriple(profile.agentPubkey, kube, io);
  const passthrough = passthroughEnvFromPod(pod);

  // The same fail-closed parser as the wire path: identity is re-derived from
  // the nsec and the attestation is re-verified against it, so a stale or
  // foreign Secret is refused before anything mutates.
  const payload = parseDeployPayload({
    name: passthrough["AUTOGENT_PROFILE_NAME"] ?? profile.name,
    relay_url: triple.relayUrl,
    private_key_nsec: triple.nsec,
    auth_tag: triple.authTagJson,
    env_vars: passthrough,
  });
  if (payload.agentPubkey !== profile.agentPubkey) {
    fail(
      `the cluster Secret holds the key of ${payload.agentPubkey.slice(0, 12)}…, but the ` +
        `profile is bound to ${profile.agentPubkey.slice(0, 12)}… — refusing to redeploy ` +
        "a mismatched identity",
    );
  }

  report("Publishing config records and rolling out the Pod");
  const outcome = await (input.deploy ?? deployToK8s)({
    payload,
    config,
    nsec: triple.nsec,
    profile,
  });

  // Bookkeeping, not liveness (mirrors the wire path): best-effort.
  await markProfileDeployed(profile.name, payload.agentPubkey).catch(() => {});
  return outcome;
}
