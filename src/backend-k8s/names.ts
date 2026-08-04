/**
 * Deterministic k8s object naming (remote plan §4.3–4.5, k8s binding scheme).
 *
 * Everything is derived from the agent pubkey, so a repeated deploy converges
 * on the same objects instead of accumulating copies (I4), and a label select
 * finds every object this provider ever made (GC).
 */

import { randomBytes } from "node:crypto";

export const MANAGED_BY = "buzz-backend-autogent-k8s";
export const APP_LABEL = "autogent-agent";

export const LABEL_APP = "app";
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const LABEL_PUBKEY = "autogent.dev/agent-pubkey";
export const ANNOTATION_PUBKEY_FULL = "autogent.dev/agent-pubkey-full";
export const ANNOTATION_GENERATION = "autogent.dev/generation";

export function shortPubkey(agentPubkey: string): string {
  return agentPubkey.slice(0, 12);
}

export function podName(agentPubkey: string): string {
  return `autogent-${shortPubkey(agentPubkey)}`;
}

/** PVC survives redeploys: state and workspace outlive any one generation. */
export function pvcName(agentPubkey: string): string {
  return `autogent-${shortPubkey(agentPubkey)}-data`;
}

/** Secrets are per-generation: write-first, reference-exactly, GC the rest. */
export function secretName(agentPubkey: string, generation: string): string {
  return `autogent-${shortPubkey(agentPubkey)}-${generation}`;
}

/** A fresh generation token per deploy attempt. */
export function newGeneration(): string {
  return `g${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/** Labels applied to every object of this agent. */
export function commonLabels(agentPubkey: string): Record<string, string> {
  return {
    [LABEL_APP]: APP_LABEL,
    [LABEL_MANAGED_BY]: MANAGED_BY,
    // Label values cap at 63 chars; the first 32 hex are plenty selective.
    [LABEL_PUBKEY]: agentPubkey.slice(0, 32),
  };
}

/** `kubectl -l` selector matching every object of this agent. */
export function agentSelector(agentPubkey: string): string {
  return `${LABEL_APP}=${APP_LABEL},${LABEL_PUBKEY}=${agentPubkey.slice(0, 32)}`;
}
