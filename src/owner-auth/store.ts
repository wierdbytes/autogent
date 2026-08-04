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
 * write into it directly (`ModelRuntime.create({authPath})`) and the engram
 * publication ships its raw bytes.
 *
 * ## 1:1 account↔agent rule
 *
 * The plan pins one OAuth account to one agent. Anthropic's token response
 * carries no stable account id we can rely on, so the rule is enforced on the
 * strongest signal available: the refresh-token digest. Binding an account
 * that is already bound to a different agent is refused. (Logging in twice
 * with the same account yields distinct refresh tokens, which this cannot
 * catch — that residual hole is documented, not hidden.)
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
  /** SHA-256 of the refresh token at binding time — the 1:1 discriminator. */
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

export function refreshDigestOf(authJson: string): string | null {
  try {
    const parsed = JSON.parse(authJson) as Record<string, { refresh?: unknown }>;
    const refresh = parsed["anthropic"]?.refresh;
    if (typeof refresh !== "string" || refresh === "") return null;
    return createHash("sha256").update(refresh, "utf8").digest("hex");
  } catch {
    return null;
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

/**
 * Enforces the 1:1 account↔agent rule before recording a binding.
 * Returns the conflicting binding when the account is already taken.
 */
export async function recordBinding(
  agentPubkey: string,
  authJson: string,
  root = ownerAuthRoot(),
  now: () => number = () => Date.now(),
): Promise<{ ok: true } | { ok: false; conflict: AccountBinding }> {
  const digest = refreshDigestOf(authJson);
  const file = await readBindings(root);
  if (digest !== null) {
    const conflict = file.bindings.find(
      (binding) => binding.refreshDigest === digest && binding.agentPubkey !== agentPubkey,
    );
    if (conflict) return { ok: false, conflict };
  }
  const next: BindingsFile = {
    version: 1,
    bindings: [
      ...file.bindings.filter((binding) => binding.agentPubkey !== agentPubkey),
      {
        agentPubkey,
        providerId: "anthropic",
        refreshDigest: digest ?? "",
        createdAt: now(),
      },
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
