/**
 * The instance registry — this binding's substrate bookkeeping.
 *
 * The Kubernetes binding keys reconciliation on a deterministically-named Pod
 * carrying identity labels, a full-pubkey annotation and a management marker.
 * Here the substrate is a directory tree and a process table, so the same three
 * pieces of evidence live in `instance.json`:
 *
 * - **identity** — the directory name is derived from the agent pubkey, and the
 *   record repeats the full 64-hex key. The short name is collision-*resistant*,
 *   not collision-free, which is why the full-key check is mandatory before any
 *   action, exactly as the annotation check is upstream.
 * - **ownership** — `managed_by` plus `binding_version`. Identity evidence
 *   proves "this matches our schema"; only the marker asserts "we wrote this".
 *   Nothing destructive fires without it, so a directory somebody else placed
 *   here fails closed to the user instead of being auto-repaired.
 * - **liveness** — `pid` plus a process signature (start time and command),
 *   because a bare pid is a recycled number and `kill(pid, 0)` on a reused pid
 *   would report a stranger's process as our live agent.
 *
 * The agent's own state directory is deliberately *not* removed by GC: it holds
 * the sealed identity, the dedup ledger and the signed outbox, which is what
 * makes a restart re-send identical bytes instead of a second message.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BINDING_VERSION, MANAGED_BY } from "./wire.js";

export interface InstancePaths {
  /** `<state_root>/instances/<first-12-hex>` */
  dir: string;
  recordPath: string;
  /** `AUTOGENT_STATE_DIR` — sealed identity + database. Survives GC. */
  stateDir: string;
  workspace: string;
  logPath: string;
  /** The previous generation's log, kept for forensics until the next create. */
  previousLogPath: string;
}

export interface InstanceRecord {
  managed_by: string;
  binding_version: number;
  /** Full 64-hex agent pubkey — the load-bearing identity check. */
  agent_pubkey: string;
  agent_id: string;
  /** Per-attempt token. Also `BUZZ_MANAGED_AGENT_START_NONCE` in the child. */
  generation: string;
  create_intent: string;
  created_at: number;
  pid: number | null;
  /** `ps` fingerprint captured at spawn; guards against pid reuse. */
  pid_signature: string | null;
  command: string;
  args: string[];
  /**
   * The harness the desktop record asked for (`launch.command`).
   *
   * Recorded, never executed. This binding deploys one specific agent, so a
   * record configured for a different harness still gets `autogent-nostr` —
   * see `docs/buzz-backend-autogent.md`. Keeping the requested name makes that
   * substitution visible on disk instead of invisible everywhere.
   */
  requested_command: string | null;
  log_path: string;
  state_dir: string;
  workspace: string;
}

/** `buzz-agent-<first-12-hex>` — the handle returned to the desktop. */
export function agentIdFor(agentPubkey: string): string {
  return `buzz-agent-${agentPubkey.slice(0, 12)}`;
}

export function instancePaths(stateRoot: string, agentPubkey: string): InstancePaths {
  const dir = join(stateRoot, "instances", agentPubkey.slice(0, 12));
  return {
    dir,
    recordPath: join(dir, "instance.json"),
    stateDir: join(dir, "state"),
    workspace: join(dir, "workspace"),
    logPath: join(dir, "agent.log"),
    previousLogPath: join(dir, "agent.prev.log"),
  };
}

/** Raised when an object matches our schema but is provably not ours. */
export class ForeignInstanceError extends Error {}

/**
 * Reads the record.
 *
 * Returns `null` when there is nothing there. Throws {@link ForeignInstanceError}
 * when a file exists that we cannot positively identify as our own output —
 * unparseable, unmarked, or belonging to a different pubkey. The caller reports
 * it; it is never repaired around.
 */
export function readInstance(paths: InstancePaths, agentPubkey: string): InstanceRecord | null {
  let raw: string;
  try {
    raw = readFileSync(paths.recordPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ForeignInstanceError(
      `${paths.recordPath} is not valid JSON — refusing to touch a record this ` +
        `provider cannot prove it wrote. Inspect or remove it by hand.`,
    );
  }

  const record = value as Partial<InstanceRecord>;
  if (record.managed_by !== MANAGED_BY) {
    throw new ForeignInstanceError(
      `${paths.recordPath} is not managed by ${MANAGED_BY} — refusing to reuse or ` +
        `delete it. Inspect or remove it by hand.`,
    );
  }
  if (record.agent_pubkey !== agentPubkey) {
    throw new ForeignInstanceError(
      `${paths.recordPath} belongs to agent ${String(record.agent_pubkey).slice(0, 12)}…, ` +
        `not ${agentPubkey.slice(0, 12)}… — short-name collision, refusing to act.`,
    );
  }
  return record as InstanceRecord;
}

export function ensureInstanceDirs(paths: InstancePaths, workspace: string): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
}

/**
 * Claims the instance name.
 *
 * `wx` makes creation the election: the filesystem itself rejects a second
 * concurrent create, so two racing deploys cannot both believe they own the
 * name. `false` means somebody else won — the caller re-enters classification
 * rather than failing, which is what makes concurrent Starts converge.
 */
export function claimInstance(paths: InstancePaths, record: InstanceRecord): boolean {
  try {
    writeFileSync(paths.recordPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Atomically replaces the record — used once, to record the spawned pid. */
export function writeInstance(paths: InstancePaths, record: InstanceRecord): void {
  const temporary = `${paths.recordPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, paths.recordPath);
}

/**
 * Moves the current log aside.
 *
 * Rotating rather than deleting keeps the last generation's diagnostics for
 * exactly one further deploy — the same "forensics until the next create"
 * window the pod binding gets from a Completed pod. It also makes `agent.log`
 * belong to exactly one generation, which is what lets startup evidence be
 * re-derived from disk by any later call.
 */
export function rotateLog(paths: InstancePaths): void {
  try {
    renameSync(paths.logPath, paths.previousLogPath);
  } catch {
    /* nothing to rotate */
  }
}

/**
 * Clears residue: the record goes, the log is rotated, the state directory stays.
 *
 * Callers must have established ownership first. The state directory survives
 * on purpose — it holds the sealed identity, the dedup ledger and the signed
 * outbox, which is what makes a restart re-send identical bytes instead of
 * producing a second message.
 */
export function removeInstance(paths: InstancePaths): void {
  rotateLog(paths);
  rmSync(paths.recordPath, { force: true });
}

export interface ProcessProbe {
  alive: boolean;
  signature: string | null;
}

/**
 * Asks the operating system whether a pid is a live process, and which one.
 *
 * The signature is `ps`'s **start time only**. The command column is
 * deliberately excluded: it is not stable across the process's own lifetime.
 * A spawn through `/usr/bin/env` reports `env node …` for the few milliseconds
 * before `execve` replaces the image with `node …`, so a signature captured at
 * spawn would never match one read a second later, and every live instance
 * would be misread as terminated. Start time plus pid is the canonical process
 * identity anyway; the command added nothing but a race.
 *
 * When `ps` is unavailable we fall back to `kill(pid, 0)` and report a null
 * signature, which the caller treats as weaker evidence rather than as proof.
 */
export function probeProcess(pid: number): ProcessProbe {
  // The cheap question first. `kill(pid, 0)` costs a syscall where `ps` costs a
  // process, and the reconciler asks this twice a second for the length of a
  // startup deadline. EPERM means the process exists but belongs to another
  // user — alive, and certainly not ours to reason about further.
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      return { alive: false, signature: null };
    }
    return { alive: true, signature: null };
  }

  let signature: string | null = null;
  try {
    signature = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/\s+/g, " ");
  } catch {
    signature = null;
  }
  return { alive: true, signature: signature === "" ? null : signature };
}

/**
 * Liveness *of this record's process*.
 *
 * A pid alone is not identity. When both the recorded and the observed
 * signature exist they must match, or the number has been recycled and the
 * instance is gone.
 */
export function instanceAlive(record: InstanceRecord): boolean {
  if (record.pid === null) return false;
  const probe = probeProcess(record.pid);
  if (!probe.alive) return false;
  if (record.pid_signature === null || probe.signature === null) return true;
  return record.pid_signature === probe.signature;
}

export function newInstanceRecord(input: {
  agentPubkey: string;
  generation: string;
  createIntent: string;
  command: string;
  args: string[];
  requestedCommand: string | null;
  paths: InstancePaths;
  workspace: string;
  now: number;
}): InstanceRecord {
  return {
    managed_by: MANAGED_BY,
    binding_version: BINDING_VERSION,
    agent_pubkey: input.agentPubkey,
    agent_id: agentIdFor(input.agentPubkey),
    generation: input.generation,
    create_intent: input.createIntent,
    created_at: input.now,
    pid: null,
    pid_signature: null,
    command: input.command,
    args: input.args,
    requested_command: input.requestedCommand,
    log_path: input.paths.logPath,
    state_dir: input.paths.stateDir,
    workspace: input.workspace,
  };
}
