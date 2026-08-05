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
import type { DeployProfile } from "../registry/profiles.js";
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
  /**
   * Pi extension sources for the core engram (paths or `npm:`/`git:`). On the
   * wire this stays a flat scalar (I2): a comma-separated string.
   */
  extensions: string[];
}

export const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// A tag reference: optional registry/repo path, optional `:tag`. No `@` — a
// half-typed digest must not silently parse as a tag.
const TAG_REF_RE = /^[a-z0-9][a-z0-9._:/-]*$/i;
export const QUANTITY_RE = /^[0-9]+(\.[0-9]+)?(Mi|Gi|Ti)$/;

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

  const extensions = (optionalString(object, "extensions") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

  return {
    kubeContext: optionalString(object, "kube_context"),
    namespace,
    image,
    storageClass: optionalString(object, "storage_class"),
    storageSize,
    inactivitySeconds,
    extensions,
  };
}

/**
 * The schema rendered by Buzz Desktop's provider form — deliberately reduced
 * to a *single* field. All substrate settings (kube context, namespace, image,
 * storage, inactivity bound) live on the deploy profile that the interactive
 * `autogent` CLI creates; the GUI only picks which profile to deploy. The
 * enum makes it a drop-down where the form supports one, and the description
 * lists the choices where it does not. Field names remain subject to the I2
 * lint (no `secret|password|token|key|credential` words).
 *
 * Defaults MAY be computed freshly per `info` call (spec §info), which is
 * exactly what listing the registry here is.
 */
export function k8sConfigSchema(profileNames: string[] = []): Record<string, unknown> {
  const agent: Record<string, unknown> = {
    type: "string",
    description:
      profileNames.length > 0
        ? `Agent profile from the autogent registry. Available: ${profileNames.join(", ")}`
        : "Agent profile from the autogent registry — none exist yet; run the interactive `autogent` CLI on this machine to create one",
  };
  if (profileNames.length > 0) {
    agent["enum"] = profileNames;
    agent["default"] = profileNames[0];
  }
  return {
    type: "object",
    properties: { agent },
    required: ["agent"],
  };
}

/**
 * The profile name from `provider_config` — the one field the GUI still owns.
 */
export function requestedProfileName(raw: unknown): string {
  const object = asObject(raw) ?? {};
  const name = optionalString(object, "agent");
  if (name === null) {
    fail(
      "provider_config.agent is required — pick an agent profile from the registry " +
        "(create one with the interactive `autogent` CLI on this machine)",
    );
  }
  return name;
}

/**
 * A registry profile is stored pre-validated, but it is still a file a human
 * can edit; running it through the same parser keeps deploy fail-closed.
 */
export function providerConfigFromProfile(profile: DeployProfile): K8sProviderConfig {
  return parseK8sProviderConfig({
    kube_context: profile.kubeContext,
    namespace: profile.namespace,
    image: profile.image,
    storage_class: profile.storageClass,
    storage_size: profile.storageSize,
    inactivity_seconds: profile.inactivitySeconds,
    extensions: profile.extensions.join(","),
  });
}
