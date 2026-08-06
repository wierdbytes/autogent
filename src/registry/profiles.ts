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
import type { LangfusePrivacyPreset, RespondToMode } from "../config.js";
import type { LangfuseCredentials } from "../runtime/provider-auth.js";
import { langfuseCredentialsFromValue } from "../runtime/provider-auth.js";
import {
  ownerAuthRoot,
  recordBinding,
  writeAgentAuth,
  type AccountBinding,
} from "../owner-auth/store.js";

/** DNS-label shape: it doubles as the enum value in the GUI drop-down. */
export const PROFILE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * The agent-behaviour settings the owner configures in the wizard. The
 * profile is the *sole source* for these: whatever the GUI payload carries
 * (model, system prompt, respond gate) is ignored at deploy — Buzz Desktop's
 * remaining surface is picking the profile.
 */
export interface AgentSettings {
  /** Provider-qualified model id (`anthropic/claude-sonnet-4-5`); null = pi default. */
  model: string | null;
  /** Thinking/effort level (`off`…`max`); null = pi default. */
  thinking: string | null;
  /** Extra system prompt appended to pi's; null = none. */
  systemPrompt: string | null;
  respondTo: RespondToMode;
  /** Hex pubkeys; only meaningful when respondTo === "allowlist". */
  respondToAllowlist: string[];
  /** Tool allowlist (empty = pi default set). */
  toolsInclude: string[];
  /** Tool denylist (empty = none). */
  toolsExclude: string[];
  /** Max parallel channel turns; null = runtime default. */
  maxConcurrentTurns: number | null;
  /** Prior messages fetched per turn; null = runtime default. */
  contextMessageLimit: number | null;
  /** Send traces to Langfuse (tracing plan §5.3). */
  langfuseEnabled: boolean;
  /** Langfuse base URL; null = cloud default. */
  langfuseHost: string | null;
  /** Privacy preset; null = runtime default ("conversations"). */
  langfusePrivacy: LangfusePrivacyPreset | null;
  /** Turn sampling rate 0..1; null = runtime default (1). */
  langfuseSampleRate: number | null;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  model: null,
  thinking: null,
  systemPrompt: null,
  respondTo: "owner-only",
  respondToAllowlist: [],
  toolsInclude: [],
  toolsExclude: [],
  maxConcurrentTurns: null,
  contextMessageLimit: null,
  langfuseEnabled: false,
  langfuseHost: null,
  langfusePrivacy: null,
  langfuseSampleRate: null,
};

export interface DeployProfile extends AgentSettings {
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
   * specifiers). Travels to the Pod via the core config record at deploy.
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

/**
 * Langfuse API keys of a profile — a sibling of `auth.json`, deliberately in
 * its own file: they belong to a foreign service and must never leak into the
 * credential blob pi materialises verbatim (provider-auth.ts §5.2).
 */
export function profileLangfusePath(name: string, root = ownerAuthRoot()): string {
  return join(root, "profiles", name, "langfuse.json");
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

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
}

const RESPOND_TO_MODES: readonly RespondToMode[] = ["owner-only", "allowlist", "anyone", "nobody"];

const LANGFUSE_PRIVACY_PRESETS: readonly LangfusePrivacyPreset[] = [
  "metadata-only",
  "conversations",
  "full",
];

/** Registry files written before a field existed get that field's default. */
function normalize(profile: DeployProfile): DeployProfile {
  const raw = profile as Partial<Record<keyof DeployProfile, unknown>>;
  const optionalString = (value: unknown): string | null =>
    typeof value === "string" && value !== "" ? value : null;
  const optionalCount = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
  const respondTo = RESPOND_TO_MODES.includes(raw.respondTo as RespondToMode)
    ? (raw.respondTo as RespondToMode)
    : DEFAULT_AGENT_SETTINGS.respondTo;
  return {
    ...profile,
    extensions: stringList(raw.extensions),
    model: optionalString(raw.model),
    thinking: optionalString(raw.thinking),
    systemPrompt: optionalString(raw.systemPrompt),
    respondTo,
    respondToAllowlist: stringList(raw.respondToAllowlist),
    toolsInclude: stringList(raw.toolsInclude),
    toolsExclude: stringList(raw.toolsExclude),
    maxConcurrentTurns: optionalCount(raw.maxConcurrentTurns),
    contextMessageLimit: optionalCount(raw.contextMessageLimit),
    langfuseEnabled: raw.langfuseEnabled === true,
    langfuseHost: optionalString(raw.langfuseHost),
    langfusePrivacy: LANGFUSE_PRIVACY_PRESETS.includes(raw.langfusePrivacy as LangfusePrivacyPreset)
      ? (raw.langfusePrivacy as LangfusePrivacyPreset)
      : null,
    // Out-of-range or non-finite sample rates fall back to the runtime default
    // rather than silently disabling (0) or over-sampling.
    langfuseSampleRate:
      typeof raw.langfuseSampleRate === "number" &&
      Number.isFinite(raw.langfuseSampleRate) &&
      raw.langfuseSampleRate >= 0 &&
      raw.langfuseSampleRate <= 1
        ? raw.langfuseSampleRate
        : null,
  };
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

/**
 * Reads the profile's Langfuse keys. Anything unparseable — missing file,
 * junk, half a pair — is "no keys": tracing degrades to a no-op rather than
 * failing a deploy.
 */
export async function readProfileLangfuseKeys(
  name: string,
  root = ownerAuthRoot(),
): Promise<LangfuseCredentials | null> {
  try {
    return langfuseCredentialsFromValue(
      JSON.parse(await readFile(profileLangfusePath(name, root), "utf8")) as unknown,
    );
  } catch {
    return null;
  }
}

/** Stores the keys in the record's own wire shape, 0600 like `auth.json`. */
export async function writeProfileLangfuseKeys(
  name: string,
  keys: LangfuseCredentials,
  root = ownerAuthRoot(),
): Promise<void> {
  await mkdir(join(root, "profiles", name), { recursive: true, mode: 0o700 });
  const body = { public_key: keys.publicKey, secret_key: keys.secretKey };
  await writeFileAtomic(
    profileLangfusePath(name, root),
    `${JSON.stringify(body, null, 2)}\n`,
    0o600,
  );
}

export async function removeProfileLangfuseKeys(
  name: string,
  root = ownerAuthRoot(),
): Promise<void> {
  await rm(profileLangfusePath(name, root), { force: true });
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
