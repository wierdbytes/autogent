/**
 * `autogent-nostr up` — start an already-provisioned instance, by hand.
 *
 * The provider's `deploy` is the normal way an instance comes up, and it is
 * driven by Buzz Desktop. This command is the escape hatch for when that driver
 * is unavailable or wrong: a desktop that will not offer Deploy, a headless
 * host with no desktop at all, an instance that was stopped with `!shutdown`
 * and simply needs to come back.
 *
 * Two properties distinguish it from `run`, and they are the whole reason it
 * exists rather than being a documented `env … autogent-nostr run` recipe:
 *
 * - **It is the same convergence.** Name election, generation token, pid plus
 *   process signature, log rotation, startup confirmation from the agent's own
 *   log — all of it comes from {@link startInstance}, the code the provider
 *   runs. A hand-rolled launch produces a running agent that the *next* deploy
 *   cannot recognise: no `instance.json`, or a stale one naming a dead pid.
 * - **It never touches the secret.** `deploy` needs the nsec only to seal a
 *   state directory that, here, is already sealed. `IdentityStore` deliberately
 *   offers no way to read raw key bytes back out, and this command does not
 *   need one: the environment the agent boots with is a function of the public
 *   half of `identity.json` (`env.ts`, {@link EnvPayload}).
 *
 * What it cannot recover is the tier-1/tier-2 configuration — model, system
 * prompt, user env — because those live in the deploy payload and are
 * deliberately not persisted anywhere: the provider treats every env value as
 * potentially secret (`redact.ts`), and writing them into `instance.json` would
 * create a plaintext secrets-at-rest surface that does not exist today. So they
 * are supplied explicitly, by flag or by `AUTOGENT_*` in this command's own
 * environment, and their absence is a visible default rather than a silent one.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_STATE_ROOT,
  expandPath,
  parseProviderConfig,
  type ProviderConfig,
} from "./config.js";
import { buildAgentEnv, type EnvPayload } from "./env.js";
import { RESPOND_TO, type RespondTo } from "./payload.js";
import {
  planFromEnv,
  startInstance,
  type CreatePlan,
  type ReconcileDeps,
} from "./reconcile.js";
import {
  instanceAlive,
  instancePaths,
  readInstance,
  type InstancePaths,
  type InstanceRecord,
} from "./registry.js";
import { createIdentityStore } from "../provisioning/identity-store.js";
import type { IdentityRecord } from "../provisioning/identity-store.js";
import { fail, MANAGED_BY } from "./wire.js";

/** `up` reads exactly these from its own environment, as flag defaults. */
const ENV_DEFAULTS = {
  stateRoot: "AUTOGENT_STATE_ROOT",
  relayUrl: "AUTOGENT_RELAY_URL",
  name: "AUTOGENT_PROFILE_NAME",
  respondTo: "AUTOGENT_RESPOND_TO",
  respondToAllowlist: "AUTOGENT_RESPOND_TO_ALLOWLIST",
  systemPrompt: "AUTOGENT_SYSTEM_PROMPT",
  model: "AUTOGENT_MODEL",
  logLevel: "AUTOGENT_LOG_LEVEL",
  command: "AUTOGENT_AGENT_COMMAND",
} as const;

export interface UpOptions {
  /** Deployment scope. Defaults to the provider's own root. */
  stateRoot?: string | undefined;
  /** Full pubkey or a unique prefix. Optional when the root holds one instance. */
  agent?: string | undefined;
  relayUrl?: string | undefined;
  name?: string | undefined;
  respondTo?: string | undefined;
  respondToAllowlist?: string[] | undefined;
  systemPrompt?: string | undefined;
  model?: string | undefined;
  /** Tier-2 user environment, `KEY=VALUE` pairs already parsed. */
  envVars?: Record<string, string> | undefined;
  command?: string | undefined;
  workspace?: string | undefined;
  startupTimeoutSeconds?: number | undefined;
  logLevel?: string | undefined;
  /** Resolve and report, mutating nothing. */
  dryRun?: boolean | undefined;
  ambient?: NodeJS.ProcessEnv | undefined;
  deps?: Partial<ReconcileDeps> | undefined;
}

export interface UpResult {
  agentPubkey: string;
  agentId: string;
  /** True when a live, started instance was adopted untouched. */
  noop: boolean;
  dryRun: boolean;
  relayUrl: string;
  profileName: string;
  command: string;
  workspace: string;
  stateDir: string;
  logPath: string;
  /** Null on a dry run, and on the vanishingly rare read-back miss. */
  pid: number | null;
  generation: string | null;
}

/* -------------------------------------------------------------------------- */
/* Instance selection                                                         */
/* -------------------------------------------------------------------------- */

interface Candidate {
  /** The on-disk directory name: the first 12 hex of the agent pubkey. */
  short: string;
  paths: InstancePaths;
}

function listCandidates(stateRoot: string): Candidate[] {
  const root = join(stateRoot, "instances");
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    fail(
      `no instances under ${root}. This command starts an instance that a deploy ` +
        `already provisioned; it does not create one. Pass --state-root if the ` +
        `agent lives elsewhere.`,
    );
  }
  if (entries.length === 0) fail(`no instances under ${root}.`);

  // `instancePaths` is keyed on the pubkey but only ever uses its first 12 hex,
  // so the directory name round-trips through it without needing the full key.
  return entries.map((short) => ({ short, paths: instancePaths(stateRoot, short) }));
}

/**
 * Reads a record for *display*, without the identity fence.
 *
 * {@link readInstance} answers "is this the agent I already decided to act on?"
 * and needs the caller's full 64-hex key to do it. Listing candidates is the
 * opposite question — the pubkey is what we are trying to learn, and all we
 * have is a 12-hex directory name. Applying the fence here rejects every record
 * for failing to match a key that was never a key, which is precisely what it
 * did until a test caught it. Nothing destructive keys off this function.
 */
function peekInstance(candidate: Candidate): InstanceRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(candidate.paths.recordPath, "utf8"));
  } catch {
    return null;
  }
  const record = value as Partial<InstanceRecord>;
  if (record.managed_by !== MANAGED_BY) return null;
  if (typeof record.agent_pubkey !== "string") return null;
  return record as InstanceRecord;
}

/** One line per instance, for a disambiguation error that is actually usable. */
function describeCandidate(candidate: Candidate): string {
  const record = peekInstance(candidate);
  if (record === null) return `  ${candidate.short}  (no usable instance.json)`;
  const state = instanceAlive(record) ? "running" : "stopped";
  return `  ${record.agent_pubkey}  ${state}`;
}

function selectCandidate(stateRoot: string, agent: string | undefined): Candidate {
  const candidates = listCandidates(stateRoot);

  if (agent === undefined) {
    if (candidates.length === 1) return candidates[0] as Candidate;
    fail(
      `${candidates.length} instances under ${join(stateRoot, "instances")}; ` +
        `pass --agent <pubkey>:\n${candidates.map(describeCandidate).join("\n")}`,
    );
  }

  const needle = agent.trim().toLowerCase();
  if (needle === "") fail("--agent was empty");
  const matches = candidates.filter(
    (candidate) => candidate.short.startsWith(needle) || needle.startsWith(candidate.short),
  );
  if (matches.length === 1) return matches[0] as Candidate;
  if (matches.length === 0) {
    fail(
      `no instance matching ${JSON.stringify(agent)} under ` +
        `${join(stateRoot, "instances")}:\n${candidates.map(describeCandidate).join("\n")}`,
    );
  }
  fail(
    `--agent ${JSON.stringify(agent)} is ambiguous:\n` +
      `${matches.map(describeCandidate).join("\n")}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads the sealed record and refuses anything that could not boot.
 *
 * Every check here runs *before* the claim, so a refusal leaves the instance
 * exactly as it was found — the same fail-closed-before-mutation rule
 * `parseDeployPayload` follows on the provider path.
 */
async function requireProvisioned(paths: InstancePaths): Promise<IdentityRecord> {
  const store = createIdentityStore({ stateDir: paths.stateDir });
  const record = await store.readRecord();
  if (record === null) {
    fail(
      `${paths.stateDir} holds no identity.json. This instance was never ` +
        `provisioned, so there is nothing to start.`,
    );
  }
  if (!record.ownerPubkey || !record.auth) {
    fail(
      `${paths.stateDir} holds an unprovisioned identity (no owner attestation). ` +
        `Run 'autogent-nostr provision import <attestation.json>' against it first.`,
    );
  }
  if (!(await store.hasSecret())) {
    fail(`${paths.stateDir} holds an identity record but no sealed key.`);
  }
  return record;
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

function envDefault(ambient: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = ambient[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function commaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length === 0 ? undefined : items;
}

/**
 * Resolves the payload the environment is built from.
 *
 * Precedence is flag > `AUTOGENT_*` in this process > `identity.json` >
 * built-in default. The `AUTOGENT_*` tier has to be read *here* and threaded
 * through the payload rather than inherited: `buildAgentEnv` strips every
 * `AUTOGENT_*`/`BUZZ_*` name out of the ambient environment before layering, so
 * that a developer's shell cannot silently reconfigure an agent. Passing them
 * explicitly keeps that guarantee while making this command's own defaults
 * work.
 */
function resolveEnvPayload(
  options: UpOptions,
  identity: IdentityRecord,
  ambient: NodeJS.ProcessEnv,
): EnvPayload {
  const relayUrl =
    options.relayUrl ??
    envDefault(ambient, ENV_DEFAULTS.relayUrl) ??
    identity.pairing.relayUrl;
  if (!/^wss?:\/\//.test(relayUrl)) {
    fail(`relay url ${JSON.stringify(relayUrl)} must start with ws:// or wss://`);
  }

  const respondToRaw =
    options.respondTo ?? envDefault(ambient, ENV_DEFAULTS.respondTo) ?? "owner-only";
  if (!RESPOND_TO.has(respondToRaw)) {
    fail(`--respond-to must be one of ${[...RESPOND_TO].join(", ")}`);
  }

  const allowlist =
    options.respondToAllowlist ??
    commaList(envDefault(ambient, ENV_DEFAULTS.respondToAllowlist)) ??
    [];

  return {
    relayUrl,
    name:
      options.name ??
      envDefault(ambient, ENV_DEFAULTS.name) ??
      identity.pairing.profile.name,
    respondTo: respondToRaw as RespondTo,
    respondToAllowlist: allowlist,
    systemPrompt:
      options.systemPrompt ?? envDefault(ambient, ENV_DEFAULTS.systemPrompt) ?? null,
    model: options.model ?? envDefault(ambient, ENV_DEFAULTS.model) ?? null,
    envVars: options.envVars ?? {},
    // No launch block: this command has no desktop record to carry one, so the
    // user env goes through the legacy `env_vars` tier. `buildAgentEnv` reads
    // exactly one of the two, never both.
    launch: null,
  };
}

function resolveConfig(
  options: UpOptions,
  stateRoot: string,
  ambient: NodeJS.ProcessEnv,
): ProviderConfig {
  // Routed through the provider's own parser so a hand-typed value is validated
  // by the same code that validates one typed into the desktop's config form.
  return parseProviderConfig({
    command: options.command ?? envDefault(ambient, ENV_DEFAULTS.command) ?? null,
    state_root: stateRoot,
    workspace: options.workspace ?? null,
    startup_timeout_seconds: options.startupTimeoutSeconds ?? null,
    log_level: options.logLevel ?? envDefault(ambient, ENV_DEFAULTS.logLevel) ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export async function up(options: UpOptions = {}): Promise<UpResult> {
  const ambient = options.ambient ?? process.env;
  const stateRoot = expandPath(
    options.stateRoot ?? envDefault(ambient, ENV_DEFAULTS.stateRoot) ?? DEFAULT_STATE_ROOT,
  );

  const candidate = selectCandidate(stateRoot, options.agent);
  const identity = await requireProvisioned(candidate.paths);

  // The directory name is only the first 12 hex of a key. Re-deriving the paths
  // from the *full* pubkey in the record proves the two agree before anything
  // is written, which is the same short-name collision fence `readInstance`
  // applies to the record itself.
  const paths = instancePaths(stateRoot, identity.agentPubkey);
  if (paths.stateDir !== candidate.paths.stateDir) {
    fail(
      `${candidate.paths.stateDir} holds identity ${identity.agentPubkey.slice(0, 12)}…, ` +
        `which belongs at ${paths.stateDir} — refusing to act on a mislaid instance.`,
    );
  }

  const config = resolveConfig(options, stateRoot, ambient);
  const payload = resolveEnvPayload(options, identity, ambient);

  const plan = (target: InstancePaths): CreatePlan =>
    planFromEnv({
      config,
      paths: target,
      ambient,
      env: (workspace, path) =>
        buildAgentEnv({
          payload,
          stateDir: target.stateDir,
          workspace,
          generation: "",
          logLevel: config.logLevel,
          path,
          ambient,
        }),
    });

  const summary = {
    agentPubkey: identity.agentPubkey,
    agentId: `buzz-agent-${identity.agentPubkey.slice(0, 12)}`,
    relayUrl: payload.relayUrl,
    profileName: payload.name,
    stateDir: paths.stateDir,
    logPath: paths.logPath,
  };

  if (options.dryRun === true) {
    const resolved = plan(paths);
    return {
      ...summary,
      noop: false,
      dryRun: true,
      command: `${resolved.resolved.file} ${resolved.resolved.prefixArgs.join(" ")}`.trim(),
      workspace: resolved.workspace,
      pid: null,
      generation: null,
    };
  }

  const outcome = await startInstance({
    agentPubkey: identity.agentPubkey,
    config,
    plan,
    // The state directory is already sealed; there is nothing to materialise.
    // The re-check is not ceremony: this runs inside the claim, immediately
    // before the spawn, and the directory could have been removed since the
    // pre-flight above.
    provision: async (target) => {
      if (!(await createIdentityStore({ stateDir: target.stateDir }).hasSecret())) {
        fail(`${target.stateDir} lost its sealed key between selection and start`);
      }
    },
    requestedCommand: null,
    ...(options.deps === undefined ? {} : { deps: options.deps }),
  });

  const record = readInstance(paths, identity.agentPubkey);
  return {
    ...summary,
    agentId: outcome.agentId,
    noop: outcome.noop,
    dryRun: false,
    command: record?.command ?? config.command,
    workspace: record?.workspace ?? paths.workspace,
    pid: record?.pid ?? null,
    generation: record?.generation ?? null,
  };
}

/** Human-readable report. The CLI prints this; tests assert on {@link UpResult}. */
export function formatUpResult(result: UpResult): string {
  if (result.dryRun) {
    return (
      `dry run — nothing was started\n` +
      `  agent:     ${result.agentPubkey}\n` +
      `  relay:     ${result.relayUrl}\n` +
      `  profile:   ${result.profileName}\n` +
      `  command:   ${result.command}\n` +
      `  workspace: ${result.workspace}\n` +
      `  state dir: ${result.stateDir}\n` +
      `  log:       ${result.logPath}\n`
    );
  }

  const headline = result.noop
    ? `already running — left untouched`
    : `started in the background`;
  return (
    `${headline}\n` +
    `  agent:      ${result.agentPubkey}\n` +
    `  agent id:   ${result.agentId}\n` +
    `  relay:      ${result.relayUrl}\n` +
    (result.pid === null ? "" : `  pid:        ${result.pid}\n`) +
    (result.generation === null ? "" : `  generation: ${result.generation}\n`) +
    `  log:        ${result.logPath}\n\n` +
    `Follow it with:  tail -f ${result.logPath}\n` +
    `Stop it with:    kill ${result.pid ?? "<pid>"}   (SIGTERM drains and goes offline cleanly)\n`
  );
}
