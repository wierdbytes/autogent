/**
 * Kubernetes object shapes for one agent (remote plan §4.4).
 *
 * One Pod (single container), one PVC, one per-generation Secret. No probes:
 * presence-is-status (I3) makes k8s liveness redundant, and the harness has no
 * HTTP surface to probe anyway. No Deployment/ReplicaSet: the nostr identity
 * is a singleton and SQLite has one writer, so the at-most-one-instance
 * invariant (I4) is enforced by *this provider*, not by a controller that
 * would happily run two replicas during a rollout.
 */

import type { K8sProviderConfig } from "./config.js";
import {
  ANNOTATION_GENERATION,
  ANNOTATION_PUBKEY_FULL,
  commonLabels,
  podName,
  pvcName,
  secretName,
} from "./names.js";

export interface AgentObjectsInput {
  agentPubkey: string;
  generation: string;
  config: K8sProviderConfig;
  /** bech32 or hex; placed only in the Secret (I1). */
  nsec: string;
  relayUrl: string;
  /** JSON `["auth", owner, conditions, sig]`. */
  authTagJson: string;
  /** Non-secret wiring env (relay id, telemetry flags). */
  extraEnv: Record<string, string>;
}

function metadata(
  name: string,
  input: Pick<AgentObjectsInput, "agentPubkey" | "generation" | "config">,
): Record<string, unknown> {
  return {
    name,
    namespace: input.config.namespace,
    labels: commonLabels(input.agentPubkey),
    annotations: {
      [ANNOTATION_PUBKEY_FULL]: input.agentPubkey,
      [ANNOTATION_GENERATION]: input.generation,
    },
  };
}

/** The bootstrap triple — the only secret in the cluster (plan §3.1). */
export function secretObject(input: AgentObjectsInput): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: metadata(secretName(input.agentPubkey, input.generation), input),
    type: "Opaque",
    stringData: {
      AUTOGENT_NSEC: input.nsec,
      AUTOGENT_RELAY_URL: input.relayUrl,
      AUTOGENT_AUTH_TAG: input.authTagJson,
    },
  };
}

export function pvcObject(input: AgentObjectsInput): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: metadata(pvcName(input.agentPubkey), input),
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: input.config.storageSize } },
      ...(input.config.storageClass ? { storageClassName: input.config.storageClass } : {}),
    },
  };
}

export function podObject(input: AgentObjectsInput): Record<string, unknown> {
  const bounded = input.config.inactivitySeconds > 0;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata(podName(input.agentPubkey), input),
    spec: {
      // Bounded lifetime exits 0 on purpose (I5) — Never, or k8s would flag a
      // completed Pod as failed policy-wise. Indefinite agents restart only on
      // crash (nonzero exit), which OnFailure encodes exactly.
      restartPolicy: bounded ? "Never" : "OnFailure",
      terminationGracePeriodSeconds: 60,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        fsGroup: 10001,
      },
      containers: [
        {
          name: "agent",
          image: input.config.image,
          imagePullPolicy: "IfNotPresent",
          env: [
            ...Object.entries({
              AUTOGENT_ENGRAM_CONFIG: "1",
              AUTOGENT_INACTIVITY_EXIT: String(input.config.inactivitySeconds),
              ...input.extraEnv,
            }).map(([name, value]) => ({ name, value })),
          ],
          envFrom: [{ secretRef: { name: secretName(input.agentPubkey, input.generation) } }],
          volumeMounts: [{ name: "data", mountPath: "/data" }],
          resources: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { cpu: "1000m", memory: "1Gi" },
          },
        },
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: pvcName(input.agentPubkey) } },
      ],
    },
  };
}
