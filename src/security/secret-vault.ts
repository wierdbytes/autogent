/**
 * Child-process environment sanitiser (plan §10.1).
 *
 * The agent's Nostr secret, the relay credentials and the LLM provider keys all
 * live in the parent process. Anything Pi spawns — the bash tool, an MCP server,
 * a build script the model decided to run — inherits `process.env` by default,
 * which would hand every one of those to arbitrary model-chosen code.
 *
 * So child environments are built by allowlist, not by subtraction: a variable
 * has to be named here to survive. A denylist would silently leak the next
 * credential someone adds.
 */

/**
 * Variables a normal command genuinely needs.
 *
 * `NODE_OPTIONS` is deliberately absent: it can inject `--require` into any Node
 * child, which is code execution wearing an environment variable's clothes.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  // Windows needs these for a usable shell at all.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "USERNAME",
];

/**
 * Name shapes that mark a variable as credential-bearing.
 *
 * Applied on top of the allowlist as well, so an operator who adds a name to the
 * allowlist cannot accidentally re-open the hole.
 */
export const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /SECRET/i,
  /PRIVATE_?KEY/i,
  /PRIVKEY/i,
  /\bNSEC\b/i,
  /PASSW(OR)?D/i,
  /PASSPHRASE/i,
  /TOKEN/i,
  /API_?KEY/i,
  /ACCESS_?KEY/i,
  /SESSION_?KEY/i,
  /CREDENTIAL/i,
  /MNEMONIC/i,
  /SEED_?PHRASE/i,
  /AUTH(_|$)/i,
  /_AUTH$/i,
  /SIGNING/i,
];

/**
 * Prefixes stripped wholesale.
 *
 * The whole `AUTOGENT_`/`BUZZ_` surface goes, secret-looking or not: a spawned
 * tool has no business reading the agent's relay, owner or state configuration,
 * and letting the relay URL through would let a compromised tool discover where
 * to replay traffic.
 */
export const DENIED_ENV_PREFIXES: readonly string[] = ["AUTOGENT_", "BUZZ_", "NOSTR_", "PI_ACP_"];

/**
 * Bootstrap secrets deleted from `process.env` once the runtime has read them.
 *
 * Explicit rather than pattern-based: this mutates the live process environment,
 * and deleting a provider key the in-process Pi runtime still needs would be a
 * self-inflicted outage.
 */
export const BOOTSTRAP_SECRET_ENV_VARS: readonly string[] = [
  "BUZZ_PRIVATE_KEY",
  "BUZZ_AUTH_TAG",
  "NOSTR_PRIVATE_KEY",
  "NOSTR_SECRET_KEY",
  "AUTOGENT_AGENT_SECRET",
  "AUTOGENT_OWNER_SECRET",
  "AUTOGENT_SECRET_KEY",
];

/** Values that are unmistakably key material regardless of the variable's name. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [/^nsec1[02-9ac-hj-np-z]{20,}$/i, /^ncryptsec1/i];

export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (DENIED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function isSecretEnvValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

export interface ChildEnvOptions {
  /** Extra names to carry over, still subject to the secret filter. */
  allow?: readonly string[];
  /** Variables the runtime sets itself, e.g. `PWD`. Also filtered. */
  extra?: Readonly<Record<string, string>>;
}

/**
 * Builds the environment for a process spawned on the model's behalf.
 *
 * `extra` is filtered too. It is caller-supplied and therefore trusted-ish, but
 * the guarantee this module makes is unconditional: no secret-shaped variable
 * leaves here, whoever put it in.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  options: ChildEnvOptions = {},
): Record<string, string> {
  const permitted = new Set(
    [...CHILD_ENV_ALLOWLIST, ...(options.allow ?? [])].map((name) => name.toUpperCase()),
  );
  const out: Record<string, string> = {};

  const admit = (name: string, value: string | undefined): void => {
    if (value === undefined) return;
    if (isSecretEnvName(name) || isSecretEnvValue(value)) return;
    out[name] = value;
  };

  for (const [name, value] of Object.entries(parent)) {
    if (!permitted.has(name.toUpperCase())) continue;
    admit(name, value);
  }
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    admit(name, value);
  }
  return out;
}

/**
 * Reads a bootstrap secret and removes it from the environment in one step, so
 * there is no window in which a caller has the value *and* the variable lingers.
 */
export function takeSecretEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[name];
  delete env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * Deletes bootstrap secrets from the live environment after startup has consumed
 * them. Returns the names that were actually present, for an audit log line.
 */
export function scrubProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
  extraNames: readonly string[] = [],
): string[] {
  const removed: string[] = [];
  for (const name of [...BOOTSTRAP_SECRET_ENV_VARS, ...extraNames]) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
