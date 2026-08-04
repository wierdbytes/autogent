/**
 * Command resolution, the detached spawn, and startup confirmation.
 *
 * Three obligations from the spec are realised here:
 *
 * - **The termination signal must reach the agent itself.** There is no shell,
 *   no `npm run`, no supervisor wrapper between us and `autogent-nostr`: the
 *   spawned process *is* the agent, so a SIGTERM lands on the process that
 *   knows how to drain turns, publish presence `offline` and close the relay.
 *   A wrapper here would silently void that and leave presence stale-online.
 * - **No supervisor.** Nothing restarts this process. That satisfies "an
 *   intentional clean exit is never resurrected" vacuously, which is the
 *   honest way for a substrate with no supervision to conform.
 * - **Startup is part of create.** A successful `spawn` proves only that the
 *   kernel accepted an image. `autogent-nostr` can still exit two seconds later
 *   on a missing Pi credential or an unreachable relay, and a deploy that
 *   reported success then would hand the desktop an `agent_id` for a process
 *   that no longer exists. So success waits for the agent's own "agent online"
 *   line.
 */

import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fail } from "./wire.js";

/**
 * Baked in at bundle time; absent in a plain `tsc` build and in tests.
 *
 * Buzz Desktop launched from Finder inherits launchd's minimal PATH, which
 * frequently does not contain the npm bin directory. This is the last resort
 * before giving up: the entry point of the package this provider was built
 * from, used only when it still exists on disk.
 */
declare const __AUTOGENT_AGENT_FALLBACK__: string;

/**
 * Directories prepended to the inherited PATH.
 *
 * `dirname(process.execPath)` is the important one: nvm, fnm and volta all put
 * global npm bins next to the `node` binary that is running us.
 */
export function augmentedPath(ambient: NodeJS.ProcessEnv = process.env): string {
  const extra = [
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
    "/usr/bin",
    "/bin",
  ];
  const current = (ambient["PATH"] ?? "").split(delimiter).filter((entry) => entry !== "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...extra, ...current]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(delimiter);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedCommand {
  /** What actually gets executed. */
  file: string;
  /** Arguments prepended before the agent's own — non-empty for a JS fallback. */
  prefixArgs: string[];
  /** Human-readable description of how it was found, for diagnostics. */
  via: string;
}

/**
 * Finds the agent binary.
 *
 * An explicit path is honoured as given. A bare name is looked up on the
 * augmented PATH. The failure message names the PATH that was searched, because
 * "command not found" from a GUI-launched app is otherwise unanswerable.
 */
export function resolveAgentCommand(command: string, path: string): ResolvedCommand {
  if (command.includes(sep) || isAbsolute(command)) {
    const absolute = resolve(command);
    if (!isExecutableFile(absolute)) {
      fail(`provider_config.command ${absolute} is not an executable file`);
    }
    return { file: absolute, prefixArgs: [], via: "explicit path" };
  }

  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return { file: candidate, prefixArgs: [], via: dir };
  }

  if (typeof __AUTOGENT_AGENT_FALLBACK__ === "string" && __AUTOGENT_AGENT_FALLBACK__ !== "") {
    const fallback = __AUTOGENT_AGENT_FALLBACK__;
    try {
      if (statSync(fallback).isFile()) {
        return {
          file: process.execPath,
          prefixArgs: [fallback],
          via: "package the provider was built from",
        };
      }
    } catch {
      /* fall through to the error below */
    }
  }

  fail(
    `agent command ${JSON.stringify(command)} was not found. Searched: ${path}. ` +
      `Install it with 'npm link' in the autogent checkout, or set the provider's ` +
      `'command' field to an absolute path.`,
  );
}

export interface SpawnInputs {
  resolved: ResolvedCommand;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
}

export interface SpawnResult {
  pid: number;
}

/**
 * Starts the agent and detaches from it.
 *
 * `detached` puts the child in its own process group, so it survives this
 * provider process exiting a few hundred milliseconds later. stdio goes to the
 * log file rather than to pipes: a pipe held open by a daemonised child is
 * exactly the thing that makes the desktop's bounded read hang.
 */
export function spawnAgent(inputs: SpawnInputs): SpawnResult {
  const fd = openSync(inputs.logPath, "a", 0o600);
  try {
    const child = spawn(inputs.resolved.file, [...inputs.resolved.prefixArgs, ...inputs.args], {
      cwd: inputs.cwd,
      env: inputs.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    if (child.pid === undefined) fail("failed to start the agent process (no pid)");
    child.unref();
    return { pid: child.pid };
  } finally {
    // The child holds its own duplicate of the descriptor.
    try {
      closeSync(fd);
    } catch {
      /* best effort */
    }
  }
}

/** The line `AppRuntime` writes once it can actually answer. */
const ONLINE_MESSAGE = "agent online";

/** Messages that mean this generation will never come up. */
const FATAL_MESSAGES: readonly string[] = [
  "startup failed",
  "invalid configuration",
  "relay failed terminally, shutting down",
];

export interface LogSignals {
  online: boolean;
  /** A message explaining a deterministic startup failure, if one was logged. */
  fatal: string | null;
  /** Last few log lines, for an actionable error. */
  tail: string;
}

/**
 * Character budget for the tail carried in an error message.
 *
 * The desktop caps a provider's stdout at 1 MiB and throws away everything if
 * the cap is hit, so an error that quotes an unbounded log could destroy the
 * very response it was trying to explain.
 */
const TAIL_CHAR_CAP = 4_000;

/**
 * Reads the agent's own structured log for startup evidence.
 *
 * The log file is per-generation — the previous one is rotated away before a
 * create — so an "agent online" line in it can only belong to the instance
 * currently recorded. That is what makes startup evidence *re-derivable*: a
 * later deploy, including one after this call's deadline expired, reaches the
 * same conclusion without any state carried between calls.
 */
export function readLogSignals(logPath: string, tailLines = 20): LogSignals {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return { online: false, fatal: null, tail: "" };
  }

  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  let online = false;
  let fatal: string | null = null;

  for (const line of lines) {
    let message: string | undefined;
    let fields: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      message = typeof parsed["msg"] === "string" ? parsed["msg"] : undefined;
      fields = parsed;
    } catch {
      message = undefined;
    }
    if (message === undefined) continue;
    if (message === ONLINE_MESSAGE) {
      online = true;
      fatal = null; // a later successful boot supersedes an earlier complaint
      continue;
    }
    if (FATAL_MESSAGES.includes(message)) {
      const detail = fields?.["error"] ?? fields?.["problem"];
      fatal = detail === undefined ? message : `${message}: ${String(detail)}`;
    } else if (message.startsWith("agent is not provisioned")) {
      fatal = message;
    }
  }

  const tail = lines.slice(-tailLines).join("\n");
  return {
    online,
    fatal,
    tail: tail.length > TAIL_CHAR_CAP ? `…${tail.slice(-TAIL_CHAR_CAP)}` : tail,
  };
}
