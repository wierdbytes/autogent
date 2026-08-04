/**
 * Payload → child environment, in the three tiers the spec mandates
 * (`docs/remote-agents.md` §Launch data, "Environment precedence").
 *
 *   1. **Overridable behaviour defaults** — `launch.policy_env`.
 *   2. **User/layered env** — `launch.env` (already merged global < persona <
 *      agent), or the legacy `env_vars` when no `launch` block is present.
 *      Never both: re-merging `env_vars` on top would resurrect a layer the
 *      desktop has already resolved.
 *   3. **Authoritative** — written last, and removed from the lower tiers
 *      first, so no user variable can redirect the relay, the state directory
 *      or the respond-to gate.
 *
 * Two substrate-forced deviations, stated rather than hidden:
 *
 * - **The harness is different.** The `BUZZ_ACP_*` names in `policy_env` speak
 *   to the `buzz-acp` harness. This provider deploys `autogent-nostr`, which
 *   reads `AUTOGENT_*`. The knobs that have an exact counterpart are translated
 *   at tier 1 — keeping their *overridable* status, exactly as locally — and
 *   the originals are still passed through so nothing is silently lost.
 * - **The identity is not in the environment at all.** `private_key_nsec` and
 *   `auth_tag` are written into the agent's sealed state directory (mode 0600)
 *   instead of `BUZZ_PRIVATE_KEY`/`BUZZ_AUTH_TAG`. A local process's
 *   environment is readable by every other process of the same user, so this is
 *   strictly narrower than the pod binding's `envFrom` Secret.
 */

import type { DeployPayload } from "./payload.js";
import { fail } from "./wire.js";

/** POSIX-shaped names only: a key like `FOO=BAR` would smuggle a second var. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Written last and stripped from every lower tier.
 *
 * The rule these implement: a power user may override Buzz's behaviour
 * defaults remotely exactly as they can locally, but never the values that
 * define *which* agent this is, *where* it talks, and *who* it answers.
 */
export const AUTHORITATIVE_KEYS: readonly string[] = [
  "AUTOGENT_STATE_DIR",
  "AUTOGENT_RELAY_URL",
  "AUTOGENT_CWD",
  "AUTOGENT_RESPOND_TO",
  "AUTOGENT_RESPOND_TO_ALLOWLIST",
  "AUTOGENT_PROFILE_NAME",
  "AUTOGENT_PRESENCE",
  "BUZZ_MANAGED_AGENT_START_NONCE",
];

/**
 * Identity variables. Never forwarded from any tier.
 *
 * The agent takes its identity from the sealed state directory; a variable
 * with one of these names could only be an attempt to launch it as somebody
 * else, or a leftover that its own bootstrap scrubber would delete anyway.
 */
export const IDENTITY_KEYS: readonly string[] = [
  "BUZZ_PRIVATE_KEY",
  "NOSTR_PRIVATE_KEY",
  "NOSTR_SECRET_KEY",
  "BUZZ_AUTH_TAG",
  "AUTOGENT_AGENT_SECRET",
  "AUTOGENT_OWNER_SECRET",
  "AUTOGENT_SECRET_KEY",
];

/**
 * `buzz-acp` knob → `autogent-nostr` knob.
 *
 * Applied at tier 1, so a user `env_vars` entry still beats it — the local
 * spawn writes these before the user env layer and none of them is reserved.
 */
const POLICY_TRANSLATION: ReadonlyMap<string, string> = new Map([
  ["BUZZ_ACP_MODEL", "AUTOGENT_MODEL"],
  ["BUZZ_ACP_IDLE_TIMEOUT", "AUTOGENT_IDLE_TIMEOUT"],
  ["BUZZ_ACP_MAX_TURN_DURATION", "AUTOGENT_MAX_TURN_DURATION"],
  ["BUZZ_ACP_AGENTS", "AUTOGENT_MAX_CONCURRENT_TURNS"],
]);

/** Prefixes stripped from the inherited environment before anything is layered. */
const AMBIENT_STRIPPED_PREFIXES: readonly string[] = ["AUTOGENT_", "BUZZ_"];

export interface EnvInputs {
  payload: DeployPayload;
  stateDir: string;
  workspace: string;
  /** The per-attempt generation token; also the lifecycle correlator. */
  generation: string;
  logLevel: string | null;
  /** PATH the child should see, already augmented with install locations. */
  path: string;
  /** Defaults to `process.env`; injected by tests. */
  ambient?: NodeJS.ProcessEnv;
}

/**
 * The base environment.
 *
 * The child inherits the desktop's environment — that is what makes the Pi
 * provider credential, `HOME` and the user's toolchain reachable, exactly as
 * for a locally spawned agent. What it must *not* inherit is this machine's
 * own `AUTOGENT_*`/`BUZZ_*` configuration: launch data has to be a function of
 * the record and the config alone, or a developer's shell would silently
 * reconfigure every agent deployed from their laptop.
 */
function ambientBase(ambient: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    if (!ENV_KEY.test(key)) continue;
    if (AMBIENT_STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Folds the desktop's team instructions into the system prompt.
 *
 * `BUZZ_ACP_TEAM_INSTRUCTIONS` is the one policy value no substrate can
 * reconstruct — it needs the desktop's team store. `autogent-nostr` has a
 * single appended-prompt knob, so the two are concatenated rather than dropped.
 */
function composeSystemPrompt(
  systemPrompt: string | null,
  teamInstructions: string | null,
): string | null {
  const parts = [systemPrompt, teamInstructions].filter(
    (part): part is string => part !== null && part.trim() !== "",
  );
  return parts.length === 0 ? null : parts.join("\n\n");
}

function assertKey(key: string, label: string): void {
  if (!ENV_KEY.test(key)) {
    fail(`${label} key ${JSON.stringify(key)} is not a valid environment variable name`);
  }
}

/**
 * Refuses the two knobs that would let user configuration un-make a promise.
 *
 * Presence is the *only* status signal the desktop has for a deployed agent
 * (invariant I3), so a user variable that turns it off would convert
 * "briefly wrong" into "wrong forever". The check runs over the user tier,
 * where such a value could only have come from a person typing it.
 */
function assertPresenceNotSuppressed(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper === "BUZZ_ACP_NO_PRESENCE") {
      fail(
        "env var BUZZ_ACP_NO_PRESENCE is refused: presence is the only signal Buzz " +
          "has that a deployed agent is alive",
      );
    }
    if (upper === "AUTOGENT_PRESENCE" && /^(0|false|no|off)$/i.test(value.trim())) {
      fail(
        "env var AUTOGENT_PRESENCE is refused when disabled: presence is the only " +
          "signal Buzz has that a deployed agent is alive",
      );
    }
  }
}

export function buildAgentEnv(inputs: EnvInputs): Record<string, string> {
  const { payload, stateDir, workspace, generation, logLevel, path } = inputs;
  const env = ambientBase(inputs.ambient ?? process.env);

  /* ---- tier 1: overridable behaviour defaults --------------------------- */

  const policy = payload.launch?.policyEnv ?? {};
  for (const [key, value] of Object.entries(policy)) {
    assertKey(key, "agent.launch.policy_env");
    env[key] = value;
    const translated = POLICY_TRANSLATION.get(key.toUpperCase());
    if (translated) env[translated] = value;
  }

  const systemPrompt = composeSystemPrompt(
    policy["BUZZ_ACP_SYSTEM_PROMPT"] ?? payload.systemPrompt,
    policy["BUZZ_ACP_TEAM_INSTRUCTIONS"] ?? null,
  );
  if (systemPrompt !== null) env["AUTOGENT_SYSTEM_PROMPT"] = systemPrompt;
  if (payload.model !== null && env["AUTOGENT_MODEL"] === undefined) {
    env["AUTOGENT_MODEL"] = payload.model;
  }
  if (logLevel !== null) env["AUTOGENT_LOG_LEVEL"] = logLevel;

  /* ---- tier 2: user/layered env ----------------------------------------- */

  const userEnv = payload.launch ? payload.launch.env : payload.envVars;
  const userLabel = payload.launch ? "agent.launch.env" : "agent.env_vars";
  for (const key of Object.keys(userEnv)) assertKey(key, userLabel);
  assertPresenceNotSuppressed(userEnv);
  Object.assign(env, userEnv);

  /* ---- tier 3: authoritative -------------------------------------------- */

  for (const key of [...AUTHORITATIVE_KEYS, ...IDENTITY_KEYS]) delete env[key];

  env["PATH"] = path;
  env["AUTOGENT_STATE_DIR"] = stateDir;
  env["AUTOGENT_RELAY_URL"] = payload.relayUrl;
  env["AUTOGENT_CWD"] = workspace;
  env["AUTOGENT_RESPOND_TO"] = payload.respondTo;
  env["AUTOGENT_PROFILE_NAME"] = payload.name;
  env["AUTOGENT_PRESENCE"] = "true";
  if (payload.respondToAllowlist.length > 0) {
    env["AUTOGENT_RESPOND_TO_ALLOWLIST"] = payload.respondToAllowlist.join(",");
  }
  // The generation token doubles as the lifecycle correlator, so a log line and
  // the instance record that produced it name the same attempt.
  env["BUZZ_MANAGED_AGENT_START_NONCE"] = generation;

  return env;
}
