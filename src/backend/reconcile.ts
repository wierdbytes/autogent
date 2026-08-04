/**
 * The deploy state machine (`docs/remote-agents.md` §Deploy State Machine).
 *
 * Buzz Desktop has no `start`, `stop` or `undeploy` operation — pressing Start
 * always issues `deploy`. So `deploy` is not "create": it is *converge to at
 * most one live instance of this agent key in this scope* (invariant I4), and
 * the whole file is one ordered classification, evaluated against evidence and
 * re-entered on conflict.
 *
 * The three rules that shape it most:
 *
 * - **Live means started, and live is a strict no-op.** Pressing Start while an
 *   agent is mid-turn must never kill it, so a running instance is returned
 *   unchanged, with zero mutation — no rewritten record, no re-sealed key. The
 *   consequence is documented rather than papered over: configuration edits
 *   reach a running agent only when it next exits.
 * - **A deadline never destroys anything.** An instance that is still coming up
 *   is *observed*, on this call and every later one. What replaces a
 *   never-started instance is a change of intent — the user editing the
 *   configuration it is wedged on — never the clock. That asymmetry is the
 *   entire difference between "a slow start eventually succeeds" and a livelock
 *   in which every individual decision looked correct.
 * - **One create attempt per call.** The replacement rows exist to clear
 *   residue from a *previous* life. Once this call has made its own attempt, a
 *   classification that would replace it means that attempt already failed —
 *   repeating it would spawn a fresh process every poll interval for the whole
 *   deadline.
 */

import { randomBytes } from "node:crypto";
import type { ProviderConfig } from "./config.js";
import { buildAgentEnv } from "./env.js";
import { fingerprint } from "./intent.js";
import type { DeployPayload } from "./payload.js";
import { provisionStateDir } from "./provision.js";
import type { InstancePaths, InstanceRecord } from "./registry.js";
import {
  claimInstance,
  ensureInstanceDirs,
  instanceAlive,
  instancePaths,
  newInstanceRecord,
  probeProcess,
  readInstance,
  removeInstance,
  rotateLog,
  writeInstance,
} from "./registry.js";
import {
  augmentedPath,
  readLogSignals,
  resolveAgentCommand,
  spawnAgent,
  type ResolvedCommand,
} from "./spawn.js";
import { fail } from "./wire.js";

/** The agent's own subcommand: `autogent-nostr run` starts the service. */
const AGENT_ARGS: readonly string[] = ["run"];

/** How often the observation loop re-reads the world. */
const POLL_INTERVAL_MS = 500;

/**
 * How long a terminated instance is given to actually disappear.
 *
 * Deleting is not instantaneous here, for the same reason it is not in
 * Kubernetes: the agent gets its graceful shutdown — drain, presence `offline`,
 * relay close — before it is gone. Starting a second copy over a name that is
 * still taken is exactly what invariant I4 forbids, so we poll rather than
 * assume.
 */
const TERMINATION_GRACE_MS = 60_000;

export interface ReconcileDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  ambient?: NodeJS.ProcessEnv;
}

export interface ReconcileInputs {
  payload: DeployPayload;
  config: ProviderConfig;
  deps?: Partial<ReconcileDeps>;
}

export interface DeployOutcome {
  agentId: string;
  /** True when an already-live instance was returned untouched. */
  noop: boolean;
}

export interface CreatePlan {
  resolved: ResolvedCommand;
  env: Record<string, string>;
  intent: string;
  workspace: string;
}

/**
 * Everything the state machine needs that is *not* the state machine.
 *
 * The split exists because two callers converge on one instance by two
 * different routes. `deploy` arrives from the desktop holding an nsec and must
 * materialise the sealed state directory before the agent can boot. `up`
 * arrives from an operator's shell holding nothing but a path, and the state
 * directory is already sealed — it has no secret, and must not need one.
 *
 * What they share is every hard part: the name election, generation tokens, pid
 * signatures, log rotation, and the classification that decides whether a
 * directory holds a live agent, a corpse, or a wedged startup. Duplicating that
 * for the sake of one differing step is how the two drift apart.
 */
export interface StartSpec {
  /** Derived from the secret by `deploy`, read from `identity.json` by `up`. */
  agentPubkey: string;
  config: ProviderConfig;
  /**
   * The create plan, computed lazily and at most once.
   *
   * Never called on the no-op path: resolving the agent binary can fail, and a
   * Start that errored because the *command* setting had drifted — while the
   * agent it was asked about was running perfectly well — would be a regression
   * a user could not diagnose.
   */
  plan: (paths: InstancePaths) => CreatePlan;
  /**
   * Materialises the sealed state directory, inside the claim and before the
   * spawn. A no-op for callers whose state directory already exists.
   */
  provision: (paths: InstancePaths, now: number) => Promise<void>;
  /** `launch.command` from the desktop record: recorded, never executed. */
  requestedCommand: string | null;
  deps?: Partial<ReconcileDeps>;
}

const DEFAULT_DEPS: ReconcileDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

function tailSuffix(logPath: string): string {
  const tail = readLogSignals(logPath).tail;
  return tail === "" ? "" : `\n--- ${logPath} ---\n${tail}`;
}

/**
 * Computes what *this* deploy would create, without creating anything.
 *
 * The result's fingerprint is compared against a never-started instance's
 * recorded intent. The per-attempt generation token is excluded from the digest
 * by {@link fingerprint}, so two calls with identical configuration agree even
 * though their tokens differ — otherwise every attempt would diverge from every
 * other by construction.
 */
function planCreate(inputs: ReconcileInputs, paths: InstancePaths): CreatePlan {
  const ambient = inputs.deps?.ambient ?? process.env;
  return planFromEnv({
    config: inputs.config,
    paths,
    ambient,
    env: (workspace, path) =>
      buildAgentEnv({
        payload: inputs.payload,
        stateDir: paths.stateDir,
        workspace,
        generation: "",
        logLevel: inputs.config.logLevel,
        path,
        ambient,
      }),
  });
}

/**
 * Shared half of {@link planCreate}: everything downstream of an environment.
 *
 * `up` builds its environment from `identity.json` plus flags rather than from
 * a deploy payload, but the command resolution, the workspace default and the
 * fingerprint must be computed identically or the two callers would disagree
 * about whether an instance matches its own intent.
 */
export function planFromEnv(inputs: {
  config: ProviderConfig;
  paths: InstancePaths;
  env: (workspace: string, path: string) => Record<string, string>;
  ambient?: NodeJS.ProcessEnv;
}): CreatePlan {
  const { config, paths } = inputs;
  const path = augmentedPath(inputs.ambient ?? process.env);
  const resolved = resolveAgentCommand(config.command, path);
  const workspace = config.workspace ?? paths.workspace;
  const env = inputs.env(workspace, path);

  const intent = fingerprint({
    command: describeCommand(resolved),
    args: AGENT_ARGS,
    cwd: workspace,
    stateDir: paths.stateDir,
    env,
  });

  return { resolved, env, intent, workspace };
}

function describeCommand(resolved: ResolvedCommand): string {
  return [resolved.file, ...resolved.prefixArgs].join(" ");
}

/**
 * Terminates an instance through its graceful path, then waits for it to go.
 *
 * Returns `false` when it declined to act, in which case the caller must
 * re-classify rather than proceed. That is the fence the spec requires around
 * every destructive step: a classification is a *past* observation, and the
 * agent can finish starting up in the microseconds between deciding it never
 * started and sending the signal. Re-reading the two pieces of evidence
 * immediately before the kill — is it online now, and is this still the same
 * generation? — is the local analogue of a compare-and-delete precondition.
 */
async function terminate(
  paths: InstancePaths,
  record: InstanceRecord,
  deps: ReconcileDeps,
  deadline: number,
): Promise<boolean> {
  if (record.pid === null) return true;

  if (readLogSignals(record.log_path).online) return false;
  const current = readInstance(paths, record.agent_pubkey);
  if (current === null || current.generation !== record.generation) return false;

  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    /* already gone */
  }

  const graceUntil = Math.min(deps.now() + TERMINATION_GRACE_MS, deadline);
  while (deps.now() < graceUntil) {
    if (!instanceAlive(record)) return true;
    await deps.sleep(POLL_INTERVAL_MS);
  }

  try {
    process.kill(record.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  while (deps.now() < deadline) {
    if (!instanceAlive(record)) return true;
    await deps.sleep(POLL_INTERVAL_MS);
  }
  fail(
    `instance ${record.agent_id} (pid ${record.pid}) did not exit; refusing to start a ` +
      `second copy of the same agent key`,
  );
}

/**
 * The create step: claim the name, seal the identity, spawn, record the pid.
 *
 * Returns `false` when a concurrent deploy won the name race. The loser cleans
 * up nothing belonging to the winner — it re-classifies and adopts it, which is
 * what makes concurrent Starts converge on one instance instead of failing.
 */
async function create(
  spec: StartSpec,
  paths: InstancePaths,
  plan: CreatePlan,
  deps: ReconcileDeps,
): Promise<boolean> {
  const generation = randomBytes(8).toString("hex");
  const now = deps.now();

  ensureInstanceDirs(paths, plan.workspace);

  const record = newInstanceRecord({
    agentPubkey: spec.agentPubkey,
    generation,
    createIntent: plan.intent,
    command: describeCommand(plan.resolved),
    args: [...AGENT_ARGS],
    requestedCommand: spec.requestedCommand,
    paths,
    workspace: plan.workspace,
    now,
  });

  // The name is the election: `wx` makes the filesystem reject the second
  // concurrent create rather than letting both callers believe they own it.
  if (!claimInstance(paths, record)) return false;

  try {
    await spec.provision(paths, now);
    // The log is per-generation, which is what makes "did this instance come
    // up?" answerable from disk by any later call.
    rotateLog(paths);

    const { pid } = spawnAgent({
      resolved: plan.resolved,
      args: [...AGENT_ARGS],
      cwd: plan.workspace,
      env: { ...plan.env, BUZZ_MANAGED_AGENT_START_NONCE: generation },
      logPath: paths.logPath,
    });

    writeInstance(paths, { ...record, pid, pid_signature: probeProcess(pid).signature });
    return true;
  } catch (error) {
    // Our own half-made attempt is ours to clear: a claim left behind with no
    // process would look like a terminated instance to every later deploy.
    removeInstance(paths);
    throw error;
  }
}

/**
 * Converges on at most one live instance of `spec.agentPubkey` in this scope.
 *
 * The whole state machine lives here; `deploy` and `up` are the two ways to
 * describe *what* to converge on. See {@link StartSpec}.
 */
export async function startInstance(spec: StartSpec): Promise<DeployOutcome> {
  const { config } = spec;
  const deps: ReconcileDeps = { ...DEFAULT_DEPS, ...spec.deps };
  const deadline = deps.now() + config.startupTimeoutSeconds * 1_000;
  const paths = instancePaths(config.stateRoot, spec.agentPubkey);

  // Identity is established by the caller — derived from the nsec by `deploy`,
  // read from the sealed record by `up` — before this function, and therefore
  // before any mutation.
  let memoized: CreatePlan | null = null;
  const plan = (): CreatePlan => (memoized ??= spec.plan(paths));
  let attempted = false;

  for (;;) {
    const record = readInstance(paths, spec.agentPubkey);

    /* ---- no instance ---------------------------------------------------- */
    if (record === null) {
      if (attempted) {
        fail(
          `the agent process disappeared immediately after start — it exited before ` +
            `logging anything usable.${tailSuffix(paths.logPath)}`,
        );
      }
      attempted = true;
      await create(spec, paths, plan(), deps);
      continue;
    }

    const alive = instanceAlive(record);
    const signals = readLogSignals(record.log_path);

    /* ---- live and started: strict no-op ---------------------------------- */
    if (alive && signals.online) {
      return { agentId: record.agent_id, noop: !attempted };
    }

    /* ---- terminated: clear residue, re-enter ----------------------------- */
    if (!alive) {
      if (attempted) {
        fail(
          `the agent exited during startup: ${signals.fatal ?? "no reason logged"}.` +
            tailSuffix(paths.logPath),
        );
      }
      removeInstance(paths);
      continue;
    }

    /* ---- alive but never started ----------------------------------------- */

    // Provably non-recoverable: the agent logged a deterministic startup
    // failure. Evidence, not a guess about how long is too long.
    if (signals.fatal !== null) {
      if (attempted) {
        fail(`the agent failed to start: ${signals.fatal}.${tailSuffix(paths.logPath)}`);
      }
      if (!(await terminate(paths, record, deps, deadline))) continue;
      removeInstance(paths);
      continue;
    }

    // Divergent intent: this instance was built from configuration the user has
    // since changed. Replacing it is the only escape from a wedge they have
    // already tried to fix — but only residue from a previous life, never the
    // attempt this call just made, and never a *started* instance.
    if (record.create_intent !== plan().intent && !attempted) {
      if (!(await terminate(paths, record, deps, deadline))) continue;
      removeInstance(paths);
      continue;
    }

    // Recoverable and unchanged: observe. Never delete, on this call or a later
    // one — a later deploy re-reads and adopts whatever the startup became.
    if (deps.now() >= deadline) {
      fail(
        `startup was not confirmed within ${config.startupTimeoutSeconds}s. The agent ` +
          `process (pid ${String(record.pid)}) is still running and was left alone; ` +
          `press Start again to adopt it once it reports itself online.` +
          tailSuffix(paths.logPath),
      );
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * The provider's `deploy` op: converge, materialising the sealed state
 * directory from the payload on the way.
 */
export async function deploy(inputs: ReconcileInputs): Promise<DeployOutcome> {
  const { payload, config } = inputs;
  return startInstance({
    agentPubkey: payload.agentPubkey,
    config,
    plan: (paths) => planCreate(inputs, paths),
    provision: async (paths, now) => {
      await provisionStateDir({ payload, stateDir: paths.stateDir, now });
    },
    requestedCommand: payload.launch?.command ?? null,
    deps: inputs.deps,
  });
}
