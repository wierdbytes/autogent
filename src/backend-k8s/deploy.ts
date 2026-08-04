/**
 * `deploy` for the k8s substrate (remote plan §4.3–4.5).
 *
 * Convergence target: exactly one live Pod of this agent at the new
 * generation. Order is load-bearing:
 *
 *   1. refuse without local provider credentials (fail-closed before anything);
 *   2. publish engrams (config + credentials exist before the Pod can start);
 *   3. Secret write-first, then PVC;
 *   4. replace any prior-generation Pod (I4: never two live instances);
 *   5. wait for the container to actually start (accepted ≠ running);
 *   6. GC orphaned per-generation Secrets.
 */

import type { DeployPayload } from "../backend/payload.js";
import { fail } from "../backend/wire.js";
import { readAgentAuth } from "../owner-auth/store.js";
import type { K8sProviderConfig } from "./config.js";
import { buildPodEnv, publishDeployEngrams } from "./engrams.js";
import { apply, deleteAndWait, getJson, listJson, type KubectlOptions } from "./kubectl.js";
import {
  ANNOTATION_GENERATION,
  agentSelector,
  newGeneration,
  podName,
  secretName,
} from "./names.js";
import { podObject, pvcObject, secretObject, type AgentObjectsInput } from "./manifests.js";
import { toNostrTag } from "../nostr/nip-oa.js";

const STARTUP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

export interface K8sDeployInput {
  payload: DeployPayload;
  config: K8sProviderConfig;
  /** The original bech32/hex nsec, for the Secret. */
  nsec: string;
  /** Injected in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface K8sDeployOutcome {
  agentId: string;
  generation: string;
}

export async function deployToK8s(input: K8sDeployInput): Promise<K8sDeployOutcome> {
  const { payload, config } = input;
  const kube: KubectlOptions = { context: config.kubeContext, namespace: config.namespace };
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  // 1. Credentials first: deploying an agent that can never authenticate to
  //    its model provider is refused before any object exists (plan §4.3.3).
  const providerAuthJson = await readAgentAuth(payload.agentPubkey);
  if (providerAuthJson === null) {
    fail(
      `no provider credentials for agent ${payload.agentPubkey.slice(0, 12)}… — run ` +
        `'autogent-nostr auth login --agent ${payload.agentPubkey}' on this machine first`,
    );
  }

  // 2. Engrams before substrate: the Pod reads them at first start.
  await publishDeployEngrams({
    payload,
    inactivitySeconds: config.inactivitySeconds,
    providerAuthJson,
  });

  const generation = newGeneration();
  const objects: AgentObjectsInput = {
    agentPubkey: payload.agentPubkey,
    generation,
    config,
    nsec: input.nsec,
    relayUrl: payload.relayUrl,
    authTagJson: JSON.stringify(toNostrTag(payload.auth)),
    extraEnv: buildPodEnv(payload),
  };

  // 3. Secret write-first, then PVC (both idempotent applies).
  await apply(secretObject(objects), kube);
  await apply(pvcObject(objects), kube);

  // 4. At-most-one-live-instance: the Pod name is deterministic, so an
  //    existing Pod is by definition a previous generation — replace it.
  const name = podName(payload.agentPubkey);
  const existing = await getJson("pod", name, kube);
  if (existing !== null) {
    await deleteAndWait("pod", name, kube);
  }
  await apply(podObject(objects), kube);

  // 5. Startup confirmation: "the API accepted the Pod" proves nothing about
  //    the image or the node. Wait for the container to run, or surface the
  //    waiting reason (ImagePullBackOff and friends) as the deploy error.
  const deadline = (input.now ?? Date.now)() + STARTUP_TIMEOUT_MS;
  for (;;) {
    const pod = await getJson("pod", name, kube);
    const verdict = podVerdict(pod);
    if (verdict.state === "running") break;
    if (verdict.state === "failed") {
      fail(`agent Pod failed to start: ${verdict.reason}`);
    }
    if ((input.now ?? Date.now)() > deadline) {
      fail(
        `agent Pod did not reach Running within ${STARTUP_TIMEOUT_MS / 1000}s` +
          (verdict.reason ? ` (last state: ${verdict.reason})` : ""),
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // 6. GC: per-generation Secrets of previous deploys are orphans now.
  await gcSecrets(payload.agentPubkey, generation, kube);

  return { agentId: `${config.namespace}/${name}`, generation };
}

type PodVerdict =
  | { state: "running" }
  | { state: "pending"; reason: string | null }
  | { state: "failed"; reason: string };

/** Reads a Pod's container state without trusting any single field alone. */
export function podVerdict(pod: Record<string, unknown> | null): PodVerdict {
  if (pod === null) return { state: "pending", reason: "pod not visible yet" };
  const status = (pod["status"] ?? {}) as Record<string, unknown>;
  const phase = status["phase"];
  if (phase === "Failed") {
    return { state: "failed", reason: String(status["reason"] ?? "phase Failed") };
  }

  const containers = (status["containerStatuses"] ?? []) as Array<Record<string, unknown>>;
  const agent = containers[0];
  const state = (agent?.["state"] ?? {}) as Record<string, unknown>;
  if (state["running"]) return { state: "running" };

  const waiting = state["waiting"] as Record<string, unknown> | undefined;
  const reason = waiting ? String(waiting["reason"] ?? "waiting") : null;
  // Pull failures never resolve inside one deploy's budget; fail fast with the
  // actionable reason instead of burning the whole timeout.
  if (reason && /ImagePullBackOff|ErrImagePull|InvalidImageName|CreateContainerConfigError/.test(reason)) {
    return { state: "failed", reason };
  }
  const terminated = state["terminated"] as Record<string, unknown> | undefined;
  if (terminated && Number(terminated["exitCode"] ?? 0) !== 0) {
    return { state: "failed", reason: `container exited ${String(terminated["exitCode"])}` };
  }
  return { state: "pending", reason };
}

async function gcSecrets(
  agentPubkey: string,
  currentGeneration: string,
  kube: KubectlOptions,
): Promise<void> {
  const secrets = await listJson("secret", agentSelector(agentPubkey), kube);
  const keep = secretName(agentPubkey, currentGeneration);
  for (const secret of secrets) {
    const meta = (secret["metadata"] ?? {}) as Record<string, unknown>;
    const name = String(meta["name"] ?? "");
    const annotations = (meta["annotations"] ?? {}) as Record<string, unknown>;
    if (name === keep) continue;
    if (annotations[ANNOTATION_GENERATION] === undefined) continue; // not ours
    await deleteAndWait("secret", name, kube, 30);
  }
}
