/**
 * Owner-side provider-credential store (`autogent auth`, remote plan §7).
 *
 * Lives on the owner's machine, next to nothing the agent can reach:
 *
 *   ~/.config/autogent/
 *     bindings.json            # agent pubkey → account binding (no secrets)
 *     agents/<pubkey>/auth.json# pi-compatible credential file, mode 0600
 *
 * The per-agent `auth.json` is *exactly* the file the pi SDK would keep in
 * `~/.pi/agent` — `Record<providerId, Credential>` — so the OAuth flow can
 * write into it directly (`ModelRuntime.create({authPath})`) and the record
 * publication ships its raw bytes.
 *
 * ## 1:1 account↔agent rule (per provider)
 *
 * The plan pins one provider account to one agent. Token responses carry no
 * stable account id we can rely on, so the rule is enforced on the strongest
 * signal available: a digest of the credential's long-lived secret — the
 * OAuth refresh token, or the API key for api_key credentials — tracked per
 * provider. Binding a credential that is already bound to a different agent
 * is refused. (Logging in twice with the same OAuth account yields distinct
 * refresh tokens, which this cannot catch — that residual hole is
 * documented, not hidden.)
 *
 * The plan asks for the OS keyring with a 0600-file fallback; v1 ships the
 * file backend behind this module's API so a keyring backend can be added
 * without touching callers.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function ownerAuthRoot(): string {
  return process.env["AUTOGENT_AUTH_ROOT"] ?? join(homedir(), ".config", "autogent");
}

export function agentAuthPath(agentPubkey: string, root = ownerAuthRoot()): string {
  return join(root, "agents", agentPubkey, "auth.json");
}

function bindingsPath(root: string): string {
  return join(root, "bindings.json");
}

export interface AccountBinding {
  agentPubkey: string;
  providerId: string;
  /**
   * SHA-256 of the credential's long-lived secret (OAuth refresh token or
   * API key) at binding time — the 1:1 discriminator. The field name is
   * historical: it predates api_key support and stays for on-disk compat.
   */
  refreshDigest: string;
  createdAt: number;
}

export interface BindingsFile {
  version: 1;
  bindings: AccountBinding[];
}

async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, data, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export async function readBindings(root = ownerAuthRoot()): Promise<BindingsFile> {
  try {
    const raw = JSON.parse(await readFile(bindingsPath(root), "utf8")) as unknown;
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as Record<string, unknown>)["version"] === 1 &&
      Array.isArray((raw as Record<string, unknown>)["bindings"])
    ) {
      return raw as unknown as BindingsFile;
    }
  } catch {
    // Missing or unreadable → empty. A corrupt file surfaces on next write.
  }
  return { version: 1, bindings: [] };
}

export async function writeBindings(file: BindingsFile, root = ownerAuthRoot()): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFileAtomic(bindingsPath(root), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

export interface CredentialDigest {
  providerId: string;
  digest: string;
}

/**
 * SHA-256 of each provider's long-lived secret in a pi `auth.json` document:
 * the refresh token for OAuth credentials, the key for api_key credentials.
 * Entries without a usable secret are skipped.
 */
export function credentialDigestsOf(authJson: string): CredentialDigest[] {
  try {
    const parsed = JSON.parse(authJson) as Record<string, unknown>;
    const digests: CredentialDigest[] = [];
    for (const [providerId, credential] of Object.entries(parsed)) {
      if (typeof credential !== "object" || credential === null) continue;
      const record = credential as Record<string, unknown>;
      const secret = record["type"] === "api_key" ? record["key"] : record["refresh"];
      if (typeof secret !== "string" || secret === "") continue;
      digests.push({
        providerId,
        digest: createHash("sha256").update(secret, "utf8").digest("hex"),
      });
    }
    return digests;
  } catch {
    return [];
  }
}

export async function readAgentAuth(
  agentPubkey: string,
  root = ownerAuthRoot(),
): Promise<string | null> {
  try {
    return await readFile(agentAuthPath(agentPubkey, root), "utf8");
  } catch {
    return null;
  }
}

export async function ensureAgentAuthDir(agentPubkey: string, root = ownerAuthRoot()): Promise<string> {
  const dir = join(root, "agents", agentPubkey);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return agentAuthPath(agentPubkey, root);
}

/** Writes the per-agent credential file (0600, atomic). */
export async function writeAgentAuth(
  agentPubkey: string,
  authJson: string,
  root = ownerAuthRoot(),
): Promise<void> {
  const path = await ensureAgentAuthDir(agentPubkey, root);
  await writeFileAtomic(path, authJson, 0o600);
}

/**
 * Enforces the per-provider 1:1 account↔agent rule before recording bindings.
 * The full `auth.json` replaces the agent's binding set — one entry per
 * provider credential in the file. Returns the first conflicting binding when
 * any credential is already bound to a different agent.
 */
export async function recordBinding(
  agentPubkey: string,
  authJson: string,
  root = ownerAuthRoot(),
  now: () => number = () => Date.now(),
): Promise<{ ok: true } | { ok: false; conflict: AccountBinding }> {
  const digests = credentialDigestsOf(authJson);
  const file = await readBindings(root);
  for (const { providerId, digest } of digests) {
    const conflict = file.bindings.find(
      (binding) =>
        binding.providerId === providerId &&
        binding.refreshDigest === digest &&
        binding.agentPubkey !== agentPubkey,
    );
    if (conflict) return { ok: false, conflict };
  }
  const createdAt = now();
  const next: BindingsFile = {
    version: 1,
    bindings: [
      ...file.bindings.filter((binding) => binding.agentPubkey !== agentPubkey),
      ...digests.map(({ providerId, digest }) => ({
        agentPubkey,
        providerId,
        refreshDigest: digest,
        createdAt,
      })),
    ],
  };
  await writeBindings(next, root);
  return { ok: true };
}

export async function removeBinding(agentPubkey: string, root = ownerAuthRoot()): Promise<boolean> {
  const file = await readBindings(root);
  const remaining = file.bindings.filter((binding) => binding.agentPubkey !== agentPubkey);
  if (remaining.length === file.bindings.length) return false;
  await writeBindings({ version: 1, bindings: remaining }, root);
  return true;
}
