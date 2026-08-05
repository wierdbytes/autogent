/**
 * buzz CLI broker (buzz-cli plan §3).
 *
 * The `buzz` CLI the model runs from bash is a shim: autogent deliberately
 * strips every credential-shaped variable from the bash environment
 * (`src/security/secret-vault.ts`), and the CLI's only authentication path is
 * `BUZZ_PRIVATE_KEY` in its environment. So the shim forwards
 * `{argv, cwd, stdin}` over a unix socket to this broker, which spawns the
 * *real* binary with the key injected — the key lives in this process's
 * memory and in the short-lived CLI child, never in the bash environment.
 *
 * Accepted residual risk (documented in the plan): the model could read
 * `/proc/<pid>/environ` of a live CLI child (same uid); the window is the
 * duration of one command. Closing it needs a CLI change (key via stdin/fd),
 * which is out of autogent's hands.
 */

import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, Logger } from "../runtime/ports.js";
import { Semaphore } from "../runtime/scheduler.js";
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "../security/tool-policy.js";
import type { GitAuthProxy } from "./git-tools.js";

/** Same path the shim hardcodes; `TMPDIR` survives the child-env allowlist. */
export function defaultBuzzSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["TMPDIR"] ?? tmpdir(), "autogent-buzz.sock");
}

/** One shim request. `stdin` feeds the CLI's `--content -` pattern. */
interface ShimRequest {
  argv: string[];
  cwd: string;
  stdin: string | null;
}

interface ShimResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Flags the model must not smuggle through the shim: authorization and the
 * relay address are the broker's to set, not the model's to override.
 */
const FORBIDDEN_FLAGS = ["--private-key", "--auth-tag", "--relay", "--relay-url"] as const;

/** Global CLI flags that consume the next argv token as their value. */
const VALUE_FLAGS = new Set(["--format"]);

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 4;

export interface BuzzCliBrokerOptions {
  /** `https://…` origin of the relay's HTTP side; becomes `BUZZ_RELAY_URL`. */
  relayHttpOrigin: string;
  /** The agent secret as 64-char hex; held in this closure only. */
  secretHex: string;
  /** NIP-OA attestation in wire form, `["auth", owner, conditions, sig]`. */
  authTagJson: string;
  /** Rewrites relay git clone URLs to the loopback auth proxy and back. */
  gitProxy: GitAuthProxy;
  /** Live feature flag (config record `buzz_cli.enabled`, hot-applied). */
  enabled: () => boolean;
  /** Live subcommand denylist (`buzz_cli.deny_commands`), prefix-matched. */
  denyCommands: () => readonly string[];
  clock: Clock;
  logger: Logger;
  /** The real CLI binary. Tests point this at a fake shell script. */
  binaryPath?: string;
  socketPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxConcurrent?: number;
}

export class BuzzCliBroker {
  readonly #options: BuzzCliBrokerOptions;
  readonly #socketPath: string;
  readonly #binaryPath: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #semaphore: Semaphore;
  #server: Server | null = null;

  constructor(options: BuzzCliBrokerOptions) {
    this.#options = options;
    this.#socketPath = options.socketPath ?? defaultBuzzSocketPath();
    this.#binaryPath = options.binaryPath ?? "/opt/buzz/buzz-real";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#semaphore = new Semaphore(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    // A stale socket from a crashed predecessor would fail the bind.
    rmSync(this.#socketPath, { force: true });

    const server = createServer((socket) => this.#onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#socketPath, () => resolve());
    });
    this.#server = server;
    this.#options.logger.info("buzz CLI broker listening", { socket: this.#socketPath });
  }

  close(): void {
    this.#server?.close();
    this.#server = null;
    rmSync(this.#socketPath, { force: true });
  }

  #onConnection(socket: Socket): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let handled = false;

    const finish = (response: ShimResponse): void => {
      if (handled) return;
      handled = true;
      socket.end(JSON.stringify(response));
    };

    const consume = (): void => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const newline = raw.indexOf("\n");
      if (newline === -1) return;
      void this.#handleRequest(raw.slice(0, newline)).then(finish);
    };

    socket.on("data", (chunk) => {
      if (handled) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        finish(brokerError(1, "request too large"));
        return;
      }
      chunks.push(chunk);
      consume();
    });
    socket.on("end", consume);
    socket.on("error", () => socket.destroy());
  }

  async #handleRequest(line: string): Promise<ShimResponse> {
    let request: ShimRequest;
    try {
      request = parseShimRequest(JSON.parse(line));
    } catch (error) {
      return brokerError(1, error instanceof Error ? error.message : "malformed request");
    }

    if (!this.#options.enabled()) {
      return brokerError(4, "the buzz CLI is disabled in this environment");
    }

    const forbidden = findForbiddenFlag(request.argv);
    if (forbidden) {
      return brokerError(
        1,
        `${forbidden} is not available here: relay address and authorization are managed by the harness`,
      );
    }

    const denied = findDeniedCommand(request.argv, this.#options.denyCommands());
    if (denied) {
      return brokerError(1, `'buzz ${denied}' is disabled by the agent's configuration`);
    }

    const release = await this.#semaphore.acquire();
    try {
      return await this.#execute(request);
    } catch (error) {
      this.#options.logger.warn("buzz CLI execution failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return brokerError(4, error instanceof Error ? error.message : "execution failed");
    } finally {
      release();
    }
  }

  async #execute(request: ShimRequest): Promise<ShimResponse> {
    const argv = request.argv.map((token) => this.#rewriteLoopbackUrls(token));

    const child = spawn(this.#binaryPath, argv, {
      cwd: request.cwd,
      env: {
        PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env["HOME"] ?? request.cwd,
        BUZZ_RELAY_URL: this.#options.relayHttpOrigin,
        BUZZ_PRIVATE_KEY: this.#options.secretHex,
        BUZZ_AUTH_TAG: this.#options.authTagJson,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = new BoundedCollector(this.#maxOutputBytes);
    const stderr = new BoundedCollector(this.#maxOutputBytes);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    if (request.stdin !== null) child.stdin.end(request.stdin);
    else child.stdin.end();

    let timedOut = false;
    const cancelTimer = this.#options.clock.setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, this.#timeoutMs);

    const exitCode = await new Promise<number>((resolve) => {
      child.once("error", () => resolve(4));
      child.once("close", (code) => resolve(code ?? 4));
    });
    cancelTimer();

    if (timedOut) {
      return brokerError(4, `buzz command timed out after ${Math.round(this.#timeoutMs / 1000)}s`);
    }
    return {
      stdout: await this.#rewriteRelayUrls(stdout.text()),
      stderr: stderr.text(),
      exitCode,
    };
  }

  /**
   * argv direction: the model pastes loopback clone URLs (handed out by the
   * stdout rewrite below) back into commands like `buzz pr open --clone …`;
   * those must reach the relay — and the public event — as relay URLs, not as
   * a leaked localhost address.
   */
  #rewriteLoopbackUrls(token: string): string {
    return token.replace(
      /http:\/\/(?:127\.0\.0\.1|localhost):\d+\/git\//g,
      `${this.#options.relayHttpOrigin}/git/`,
    );
  }

  /**
   * stdout direction: relay clone URLs require NIP-98 headers a stock `git`
   * cannot mint, so they are rewritten to the loopback `GitAuthProxy`, which
   * signs per request.
   */
  async #rewriteRelayUrls(output: string): Promise<string> {
    const needle = `${this.#options.relayHttpOrigin}/git/`;
    if (!output.includes(needle)) return output;
    const port = await this.#options.gitProxy.ensureStarted();
    return output.split(needle).join(`http://127.0.0.1:${port}/git/`);
  }
}

/** Mirrors the buzz CLI's own stderr convention: JSON `{error, message}`. */
function brokerError(exitCode: number, message: string): ShimResponse {
  return {
    stdout: "",
    stderr: JSON.stringify({ error: "harness", message }),
    exitCode,
  };
}

function parseShimRequest(value: unknown): ShimRequest {
  if (typeof value !== "object" || value === null) throw new Error("request must be an object");
  const record = value as Record<string, unknown>;
  const argv = record["argv"];
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== "string")) {
    throw new Error("argv must be an array of strings");
  }
  const cwd = record["cwd"];
  if (typeof cwd !== "string" || cwd === "") throw new Error("cwd must be a non-empty string");
  const stdin = record["stdin"];
  if (stdin !== null && typeof stdin !== "string") throw new Error("stdin must be a string or null");
  return { argv: argv as string[], cwd, stdin: stdin as string | null };
}

function findForbiddenFlag(argv: readonly string[]): string | null {
  for (const token of argv) {
    for (const flag of FORBIDDEN_FLAGS) {
      if (token === flag || token.startsWith(`${flag}=`)) return flag;
    }
  }
  return null;
}

/**
 * Prefix match of `deny_commands` entries ("group" or "group subcommand")
 * against the request's subcommand path — the first two non-flag tokens,
 * skipping values of value-taking global flags.
 */
function findDeniedCommand(argv: readonly string[], deny: readonly string[]): string | null {
  const words: string[] = [];
  for (let index = 0; index < argv.length && words.length < 2; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) index += 1;
      continue;
    }
    words.push(token);
  }
  for (const entry of deny) {
    const parts = entry.trim().split(/\s+/).filter((part) => part.length > 0);
    if (parts.length === 0) continue;
    if (parts.every((part, index) => words[index] === part)) return parts.join(" ");
  }
  return null;
}

/** Accumulates at most `limit` bytes and marks the cut. */
class BoundedCollector {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  #truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.#truncated) return;
    if (this.#size + chunk.length > this.#limit) {
      this.#chunks.push(chunk.subarray(0, this.#limit - this.#size));
      this.#size = this.#limit;
      this.#truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.length;
  }

  text(): string {
    const text = Buffer.concat(this.#chunks).toString("utf8");
    return this.#truncated ? `${text}\n[output truncated at ${this.#limit} bytes]` : text;
  }
}
