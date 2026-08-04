/**
 * `provider_config` for `buzz-backend-autogent-k8s` (remote plan §4.2).
 *
 * Flat scalars only, no secret-shaped keys (I2): substrate credentials are
 * ambient — the kubeconfig on the owner's machine — and only a *context name*
 * appears here. The image may be given as a human-friendly tag (the GUI
 * default); it is resolved to a digest at deploy time (resolve-image.ts), so
 * the Pod itself never follows a mutable pointer.
 */

import { fail } from "../backend/wire.js";
import { DIGEST_RE } from "./resolve-image.js";

export const DEFAULT_NAMESPACE = "autogent";
export const DEFAULT_IMAGE = "ghcr.io/wierdbytes/autogent:latest";
export const DEFAULT_STORAGE_SIZE = "2Gi";
export const DEFAULT_INACTIVITY_SECONDS = 7200;

export interface K8sProviderConfig {
  /** kubeconfig context name; empty means the current context. */
  kubeContext: string | null;
  namespace: string;
  /** Image reference: `name:tag` (resolved to a digest at deploy) or `name@sha256:<64 hex>`. */
  image: string;
  storageClass: string | null;
  storageSize: string;
  /** 0 is the legal "run indefinitely" (drives restartPolicy, §4.4). */
  inactivitySeconds: number;
}

const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// A tag reference: optional registry/repo path, optional `:tag`. No `@` — a
// half-typed digest must not silently parse as a tag.
const TAG_REF_RE = /^[a-z0-9][a-z0-9._:/-]*$/i;
const QUANTITY_RE = /^[0-9]+(\.[0-9]+)?(Mi|Gi|Ti)$/;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`provider_config.${key} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseK8sProviderConfig(raw: unknown): K8sProviderConfig {
  const object = asObject(raw) ?? {};

  const namespace = optionalString(object, "namespace") ?? DEFAULT_NAMESPACE;
  if (!NAMESPACE_RE.test(namespace)) {
    fail(`provider_config.namespace ${JSON.stringify(namespace)} is not a valid k8s namespace name`);
  }

  const image = optionalString(object, "image") ?? DEFAULT_IMAGE;
  if (!DIGEST_RE.test(image) && !TAG_REF_RE.test(image)) {
    fail(
      `provider_config.image ${JSON.stringify(image)} is neither a tag reference ` +
        `(name:tag) nor digest-pinned (name@sha256:<64 hex chars>)`,
    );
  }

  const storageSize = optionalString(object, "storage_size") ?? DEFAULT_STORAGE_SIZE;
  if (!QUANTITY_RE.test(storageSize)) {
    fail(`provider_config.storage_size ${JSON.stringify(storageSize)} must look like 2Gi / 512Mi`);
  }

  let inactivitySeconds = DEFAULT_INACTIVITY_SECONDS;
  const rawInactivity = object["inactivity_seconds"];
  if (rawInactivity !== undefined && rawInactivity !== null) {
    const parsed = typeof rawInactivity === "number" ? rawInactivity : Number(rawInactivity);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      fail("provider_config.inactivity_seconds must be a non-negative integer (0 = indefinite)");
    }
    inactivitySeconds = parsed;
  }

  return {
    kubeContext: optionalString(object, "kube_context"),
    namespace,
    image,
    storageClass: optionalString(object, "storage_class"),
    storageSize,
    inactivitySeconds,
  };
}

/**
 * The schema rendered by Buzz Desktop's provider form. Field names are checked
 * against the I2 lint (no `secret|password|token|key|credential` words).
 */
export function k8sConfigSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kube_context: {
        type: "string",
        description: "kubeconfig context to use (empty = current context)",
      },
      namespace: {
        type: "string",
        description: `Kubernetes namespace for agent Pods (default ${DEFAULT_NAMESPACE})`,
        default: DEFAULT_NAMESPACE,
      },
      image: {
        type: "string",
        description:
          `Agent image tag (resolved to a digest at deploy) or name@sha256:… (default ${DEFAULT_IMAGE})`,
        default: DEFAULT_IMAGE,
      },
      storage_class: {
        type: "string",
        description: "StorageClass for the agent's PVC (empty = cluster default; k3s: local-path)",
      },
      storage_size: {
        type: "string",
        description: `PVC size for state + workspace (default ${DEFAULT_STORAGE_SIZE})`,
        default: DEFAULT_STORAGE_SIZE,
      },
      inactivity_seconds: {
        type: "integer",
        description: `Self-terminate after this many idle seconds; 0 = run indefinitely (default ${DEFAULT_INACTIVITY_SECONDS})`,
        default: DEFAULT_INACTIVITY_SECONDS,
      },
    },
    required: [],
  };
}
