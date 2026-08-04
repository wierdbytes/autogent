/**
 * The create-intent fingerprint (`docs/remote-agents.md` §Deploy State Machine).
 *
 * It answers exactly one question: *is the instance I am looking at the one
 * this deploy would create, or one built from configuration the user has since
 * changed?* That distinction is what lets a never-started instance be replaced
 * when its configuration changed, while an identical Start — however many times
 * it is pressed, however old the instance is — never destroys anything.
 *
 * Two scope rules, both load-bearing:
 *
 * - **Never secret material.** An unkeyed hash over low-entropy secrets, stored
 *   in a world-readable file, is a dictionary oracle. Secret *values* also
 *   cannot cause the wedge this discriminator exists to clear — a bad key
 *   produces a *started* agent that fails at the relay, which is a different
 *   row of the state machine. So secret-shaped variables contribute their names
 *   and nothing else.
 * - **Never attempt identity.** The per-attempt generation token is excluded
 *   structurally, or every attempt would diverge from every other by
 *   construction and the discriminator would degenerate into "always replace".
 */

import { createHash } from "node:crypto";
import { SECRET_NAME_PATTERNS } from "../security/secret-vault.js";

export interface CreateIntent {
  command: string;
  args: readonly string[];
  cwd: string;
  stateDir: string;
  env: Readonly<Record<string, string>>;
}

/** Names whose *values* are withheld from the hash. */
function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** Excluded structurally: this is the attempt's identity, not its intent. */
const ATTEMPT_IDENTITY_KEYS: ReadonlySet<string> = new Set(["BUZZ_MANAGED_AGENT_START_NONCE"]);

/**
 * Deterministic serialisation.
 *
 * Keys are sorted, so two runs that differ only in insertion order agree; a
 * secret-shaped variable contributes `["NAME", null]`, so *adding or removing*
 * one still changes the intent while its value never enters the digest.
 */
export function canonicalIntent(intent: CreateIntent): string {
  const env: Array<[string, string | null]> = Object.keys(intent.env)
    .filter((key) => !ATTEMPT_IDENTITY_KEYS.has(key))
    .sort()
    .map((key) => [key, isSecretName(key) ? null : (intent.env[key] as string)]);

  return JSON.stringify({
    v: 1,
    command: intent.command,
    args: intent.args,
    cwd: intent.cwd,
    state_dir: intent.stateDir,
    env,
  });
}

export function fingerprint(intent: CreateIntent): string {
  return createHash("sha256").update(canonicalIntent(intent), "utf8").digest("hex");
}
