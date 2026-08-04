/**
 * Tag → digest resolution at deploy time.
 *
 * The Buzz GUI accepts a human-friendly image reference (`name:tag`, or a
 * bare name meaning `:latest`), but the Pod is still created digest-pinned:
 * the tag is resolved against the registry's HTTP API *once*, at deploy, so
 * the object that runs with the agent's private key never follows a mutable
 * pointer afterwards.
 *
 * Auth: anonymous only. Public images (ghcr.io, Docker Hub, …) hand out a
 * pull token without credentials via the standard `WWW-Authenticate: Bearer`
 * challenge (realm/service/scope). Private registries fail with an actionable
 * message — this provider deliberately holds no registry credentials.
 */

import { fail } from "../backend/wire.js";

export const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;
const DIGEST_VALUE_RE = /^sha256:[0-9a-f]{64}$/;

/** All the manifest kinds a modern registry may serve for a tag. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface ParsedImageRef {
  /** Registry host (with optional port), e.g. `ghcr.io`. */
  registry: string;
  /** Repository path within the registry, e.g. `wierdbytes/autogent`. */
  repository: string;
  tag: string;
  /** `registry/repository` — the name a digest gets appended to. */
  name: string;
}

/** Splits `registry/repo:tag` (docker.io conventions for bare names). */
export function parseImageRef(ref: string): ParsedImageRef {
  if (DIGEST_RE.test(ref)) fail(`parseImageRef expects a tag reference, got digest ${ref}`);

  const firstSlash = ref.indexOf("/");
  const firstComponent = firstSlash === -1 ? "" : ref.slice(0, firstSlash);
  const isRegistryHost =
    firstComponent.includes(".") || firstComponent.includes(":") || firstComponent === "localhost";

  const registry = isRegistryHost ? firstComponent : "registry-1.docker.io";
  let rest = isRegistryHost ? ref.slice(firstSlash + 1) : ref;

  let tag = "latest";
  const colon = rest.lastIndexOf(":");
  if (colon !== -1 && colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (rest === "" || tag === "") fail(`image reference ${JSON.stringify(ref)} is malformed`);

  // Docker Hub single-component names live under `library/`.
  const repository = !isRegistryHost && !rest.includes("/") ? `library/${rest}` : rest;
  const name = isRegistryHost ? `${registry}/${rest}` : rest;

  return { registry, repository, tag, name };
}

/** Parses a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge. */
function parseBearerChallenge(header: string): { realm: string; params: Record<string, string> } | null {
  if (!/^bearer /i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const match of header.slice("bearer ".length).matchAll(/(\w+)="([^"]*)"/g)) {
    params[(match[1] as string).toLowerCase()] = match[2] as string;
  }
  if (!params["realm"]) return null;
  return { realm: params["realm"], params };
}

async function anonymousToken(
  challenge: { realm: string; params: Record<string, string> },
  fetchImpl: typeof fetch,
): Promise<string> {
  const url = new URL(challenge.realm);
  for (const key of ["service", "scope"]) {
    const value = challenge.params[key];
    if (value) url.searchParams.set(key, value);
  }
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    fail(
      `registry refused an anonymous pull token (${response.status} from ${url.origin}) — ` +
        `is the image public?`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  const token = body["token"] ?? body["access_token"];
  if (typeof token !== "string" || token === "") {
    fail(`registry token endpoint ${url.origin} returned no token`);
  }
  return token;
}

/**
 * Resolves a tag reference to `name@sha256:…`. Digest-pinned input is
 * returned unchanged (idempotent — operators may still paste a digest).
 */
export async function resolveImageDigest(
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (DIGEST_RE.test(ref)) return ref;

  const { registry, repository, tag, name } = parseImageRef(ref);
  const manifestUrl = `https://${registry}/v2/${repository}/manifests/${tag}`;
  const headers: Record<string, string> = { accept: MANIFEST_ACCEPT };

  // HEAD is enough: the digest travels in the Docker-Content-Digest header.
  let response = await fetchImpl(manifestUrl, { method: "HEAD", headers });
  if (response.status === 401) {
    const challenge = parseBearerChallenge(response.headers.get("www-authenticate") ?? "");
    if (challenge === null) {
      fail(`registry ${registry} requires auth this provider does not hold (image must be public)`);
    }
    headers["authorization"] = `Bearer ${await anonymousToken(challenge, fetchImpl)}`;
    response = await fetchImpl(manifestUrl, { method: "HEAD", headers });
  }
  if (response.status === 404) {
    fail(`image ${name}:${tag} not found on ${registry} — check the tag exists`);
  }
  if (!response.ok) {
    fail(`registry ${registry} answered ${response.status} resolving ${name}:${tag}`);
  }

  const digest = response.headers.get("docker-content-digest");
  if (digest === null || !DIGEST_VALUE_RE.test(digest)) {
    fail(`registry ${registry} returned no usable digest for ${name}:${tag}`);
  }
  return `${name}@${digest}`;
}
