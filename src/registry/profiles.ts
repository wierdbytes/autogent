/**
 * Owner-side deploy-profile registry — the "реестр" behind the interactive
 * `autogent` CLI and the `agent` drop-down in Buzz Desktop's provider form.
 *
 * A profile is *not* an identity: the Nostr keypair and the NIP-OA auth tag
 * are still minted by Buzz Desktop when the agent record is created there
 * (remote-agents.md, System Model). A profile carries everything the owner
 * configures *outside* the GUI — the substrate settings (kube context,
 * namespace, image, storage, inactivity bound) and the provider OAuth
 * credential captured by the wizard's mandatory login step. The identity is
 * bound to the profile at first deploy, when the GUI payload first reveals
 * the agent pubkey.
 *
 * On disk (same root as the owner-auth store, `AUTOGENT_AUTH_ROOT` override):
 *
 *   ~/.config/autogent/
 *     registry.json                 # this module (no secrets)
 *     profiles/<name>/auth.json     # per-profile OAuth credential, 0600
 *     agents/<pubkey>/auth.json     # owner-auth store; populated on adoption
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ownerAuthRoot,
  recordBinding,
  writeAgentAuth,
  type AccountBinding,
} from "../owner-auth/store.js";

/** DNS-label shape: it doubles as the enum value in the GUI drop-down. */
export const PROFILE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export interface DeployProfile {
  name: string;
  createdAt: number;
  /** kubeconfig context; null = current context. */
  kubeContext: string | null;
  namespace: string;
  image: string;
  storageClass: string | null;
  storageSize: string;
  inactivitySeconds: number;
  /**
   * Pi extension sources loaded into every session (paths or `npm:`/`git:`
   * specifiers). Travels to the Pod via the core engram at deploy.
   */
  extensions: string[];
  /** Bound at first deploy from the GUI payload; null = never deployed. */
  agentPubkey: string | null;
  lastDeployedAt: number | null;
}

interface RegistryFile {
  version: 1;
  profiles: DeployProfile[];
}

export function registryPath(root = ownerAuthRoot()): string {
  return join(root, "registry.json");
}

export function profileAuthPath(name: string, root = ownerAuthRoot()): string {
  return join(root, "profiles", name, "auth.json");
}

async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, data, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

function isProfile(value: unknown): value is DeployProfile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["name"] === "string" &&
    typeof record["namespace"] === "string" &&
    typeof record["image"] === "string" &&
    typeof record["storageSize"] === "string" &&
    typeof record["inactivitySeconds"] === "number"
  );
}

/** Registry files written before the field existed get an empty list. */
function normalize(profile: DeployProfile): DeployProfile {
  const extensions = Array.isArray(profile.extensions)
    ? profile.extensions.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
  return { ...profile, extensions };
}

export async function readProfiles(root = ownerAuthRoot()): Promise<DeployProfile[]> {
  try {
    const raw = JSON.parse(await readFile(registryPath(root), "utf8")) as unknown;
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as Record<string, unknown>)["version"] === 1 &&
      Array.isArray((raw as Record<string, unknown>)["profiles"])
    ) {
      return ((raw as unknown as RegistryFile).profiles as unknown[])
        .filter(isProfile)
        .map(normalize);
    }
  } catch {
    // Missing or unreadable → empty; a corrupt file surfaces on next write.
  }
  return [];
}

async function writeProfiles(profiles: DeployProfile[], root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file: RegistryFile = { version: 1, profiles };
  await writeFileAtomic(registryPath(root), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

export async function getProfile(
  name: string,
  root = ownerAuthRoot(),
): Promise<DeployProfile | null> {
  return (await readProfiles(root)).find((profile) => profile.name === name) ?? null;
}

/** Upsert by name. */
export async function saveProfile(profile: DeployProfile, root = ownerAuthRoot()): Promise<void> {
  const profiles = await readProfiles(root);
  const index = profiles.findIndex((existing) => existing.name === profile.name);
  if (index === -1) profiles.push(profile);
  else profiles[index] = profile;
  await writeProfiles(profiles, root);
}

/** Removes the profile and its credential directory. */
export async function removeProfile(name: string, root = ownerAuthRoot()): Promise<boolean> {
  const profiles = await readProfiles(root);
  const remaining = profiles.filter((profile) => profile.name !== name);
  if (remaining.length === profiles.length) return false;
  await writeProfiles(remaining, root);
  await rm(join(root, "profiles", name), { recursive: true, force: true });
  return true;
}

/** Records the deployed axis: identity bound + timestamp (flag, not liveness). */
export async function markProfileDeployed(
  name: string,
  agentPubkey: string,
  root = ownerAuthRoot(),
  now: () => number = () => Date.now(),
): Promise<void> {
  const profiles = await readProfiles(root);
  const profile = profiles.find((existing) => existing.name === name);
  if (!profile) return;
  profile.agentPubkey = agentPubkey;
  profile.lastDeployedAt = now();
  await writeProfiles(profiles, root);
}

export async function ensureProfileAuthDir(name: string, root = ownerAuthRoot()): Promise<string> {
  await mkdir(join(root, "profiles", name), { recursive: true, mode: 0o700 });
  return profileAuthPath(name, root);
}

export async function readProfileAuth(
  name: string,
  root = ownerAuthRoot(),
): Promise<string | null> {
  try {
    return await readFile(profileAuthPath(name, root), "utf8");
  } catch {
    return null;
  }
}

export type CredentialAdoption =
  | { state: "none" }
  | { state: "adopted"; authJson: string }
  | { state: "conflict"; conflict: AccountBinding };

/**
 * First deploy of a profile: the GUI payload reveals the agent pubkey, so the
 * profile's OAuth credential (captured by the wizard) is bound to that agent
 * under the owner-auth store's 1:1 account↔agent rule and copied into the
 * per-agent path the rest of the deploy pipeline reads.
 */
export async function adoptProfileCredential(
  name: string,
  agentPubkey: string,
  root = ownerAuthRoot(),
): Promise<CredentialAdoption> {
  const authJson = await readProfileAuth(name, root);
  if (authJson === null) return { state: "none" };
  const binding = await recordBinding(agentPubkey, authJson, root);
  if (!binding.ok) return { state: "conflict", conflict: binding.conflict };
  await writeAgentAuth(agentPubkey, authJson, root);
  return { state: "adopted", authJson };
}
