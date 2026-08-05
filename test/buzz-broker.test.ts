/**
 * buzz CLI broker (buzz-cli plan §3, §4): credential injection, argv guards,
 * stdin forwarding, output ceilings, timeouts, URL rewriting, and the
 * shim↔broker protocol over a real unix socket.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { createEventBuilder } from "../src/nostr/event-builder.js";
import { signAttestation } from "../src/nostr/nip-oa.js";
import { createSigner } from "../src/nostr/signer.js";
import { systemClock } from "../src/runtime/clock.js";
import { nullLogger } from "../src/runtime/logger.js";
import { BuzzCliBroker, type BuzzCliBrokerOptions } from "../src/tools/buzz-broker.js";
import { GitAuthProxy } from "../src/tools/git-tools.js";

const SECRET_HEX = "ab".repeat(32);
const AUTH_TAG_JSON = JSON.stringify(["auth", "cd".repeat(32), "", "ef".repeat(64)]);
const SHIM_PATH = join(import.meta.dirname, "..", "scripts", "buzz-shim.cjs");

/**
 * Stand-in for /opt/buzz/buzz-real: echoes argv, stdin, env and cwd as JSON,
 * with special modes for the timeout/truncation/rewrite cases.
 */
const FAKE_BINARY = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  const args = process.argv.slice(2);
  if (args[0] === "hang") { setTimeout(() => process.exit(0), 30000); return; }
  if (args[0] === "slow") { setTimeout(() => { process.stdout.write("done"); process.exit(0); }, 300); return; }
  if (args[0] === "spew") { process.stdout.write("x".repeat(100000)); process.exit(0); }
  if (args[0] === "repos") {
    process.stdout.write(JSON.stringify({ clone: [process.env.BUZZ_RELAY_URL + "/git/" + "a".repeat(64) + "/myrepo"] }));
    process.exit(0);
  }
  if (args[0] === "fail") { process.stderr.write('{"error":"relay"}'); process.exit(2); }
  if (args[0] === "argv-stderr") { process.stderr.write(JSON.stringify({ args })); process.exit(0); }
  process.stdout.write(JSON.stringify({
    args,
    stdin,
    cwd: process.cwd(),
    relay: process.env.BUZZ_RELAY_URL,
    key: process.env.BUZZ_PRIVATE_KEY,
    auth: process.env.BUZZ_AUTH_TAG,
    leaked: Object.keys(process.env).filter((k) => k.startsWith("AUTOGENT_")),
  }));
  process.exit(0);
});
`;

interface ShimResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Speaks the shim's wire protocol directly. */
function call(
  socketPath: string,
  request: { argv: string[]; cwd?: string; stdin?: string | null },
): Promise<ShimResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ cwd: process.cwd(), stdin: null, ...request })}\n`,
      );
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ShimResponse);
      } catch (error) {
        reject(error as Error);
      }
    });
  });
}

describe("BuzzCliBroker", () => {
  let dir: string;
  let binaryPath: string;
  let socketPath: string;
  let broker: BuzzCliBroker | null;
  let gitProxy: GitAuthProxy;
  let enabled: boolean;
  let denyCommands: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "buzz-broker-"));
    binaryPath = join(dir, "buzz-real");
    writeFileSync(binaryPath, FAKE_BINARY, { mode: 0o755 });
    socketPath = join(dir, "buzz.sock");
    enabled = true;
    denyCommands = [];
    broker = null;

    const signer = createSigner(new Uint8Array(generateSecretKey()));
    const authTag = signAttestation(generateSecretKey(), signer.publicKey, "");
    gitProxy = new GitAuthProxy({
      upstreamOrigin: "http://relay.local",
      builder: createEventBuilder({ signer, authTag, clock: systemClock }),
      clock: systemClock,
      logger: nullLogger,
    });
  });

  afterEach(() => {
    broker?.close();
    gitProxy.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(overrides: Partial<BuzzCliBrokerOptions> = {}): Promise<BuzzCliBroker> {
    broker = new BuzzCliBroker({
      relayHttpOrigin: "http://relay.local",
      secretHex: SECRET_HEX,
      authTagJson: AUTH_TAG_JSON,
      gitProxy,
      enabled: () => enabled,
      denyCommands: () => denyCommands,
      clock: systemClock,
      logger: nullLogger,
      binaryPath,
      socketPath,
      ...overrides,
    });
    await broker.start();
    return broker;
  }

  it("spawns the CLI with relay, key and auth tag injected — argv passed through", async () => {
    await start();
    const response = await call(socketPath, { argv: ["channels", "list", "--limit", "5"] });
    expect(response.exitCode).toBe(0);
    const seen = JSON.parse(response.stdout);
    expect(seen.args).toEqual(["channels", "list", "--limit", "5"]);
    expect(seen.relay).toBe("http://relay.local");
    expect(seen.key).toBe(SECRET_HEX);
    expect(seen.auth).toBe(AUTH_TAG_JSON);
    // No harness configuration leaks into the CLI environment.
    expect(seen.leaked).toEqual([]);
  });

  it("forwards stdin for the --content - pattern", async () => {
    await start();
    const response = await call(socketPath, {
      argv: ["messages", "send", "--content", "-"],
      stdin: "first\n\nsecond\n",
    });
    expect(JSON.parse(response.stdout).stdin).toBe("first\n\nsecond\n");
  });

  it("passes the CLI's own failures through verbatim", async () => {
    await start();
    const response = await call(socketPath, { argv: ["fail"] });
    expect(response.exitCode).toBe(2);
    expect(response.stderr).toBe('{"error":"relay"}');
  });

  it.each(["--private-key", "--auth-tag", "--relay", "--relay-url"])(
    "rejects %s without spawning anything",
    async (flag) => {
      await start();
      const bare = await call(socketPath, { argv: ["messages", "send", flag, "evil"] });
      expect(bare.exitCode).toBe(1);
      expect(bare.stderr).toMatch(/managed by the harness/);
      const glued = await call(socketPath, { argv: [`${flag}=evil`, "channels", "list"] });
      expect(glued.exitCode).toBe(1);
    },
  );

  it("refuses subcommands on the configured denylist by prefix", async () => {
    denyCommands = ["agents", "messages delete"];
    await start();

    const group = await call(socketPath, { argv: ["agents", "draft-create"] });
    expect(group.exitCode).toBe(1);
    expect(group.stderr).toMatch(/'buzz agents' is disabled/);

    // Global flags (with values) before the subcommand do not confuse matching.
    const sub = await call(socketPath, {
      argv: ["--format", "compact", "messages", "delete", "--event", "e".repeat(64)],
    });
    expect(sub.exitCode).toBe(1);

    const allowed = await call(socketPath, { argv: ["messages", "get"] });
    expect(allowed.exitCode).toBe(0);
  });

  it("refuses everything when the feature flag is off", async () => {
    enabled = false;
    await start();
    const response = await call(socketPath, { argv: ["channels", "list"] });
    expect(response.exitCode).toBe(4);
    expect(response.stderr).toMatch(/disabled/);
  });

  it("truncates oversized output and marks the cut", async () => {
    await start({ maxOutputBytes: 1000 });
    const response = await call(socketPath, { argv: ["spew"] });
    expect(response.exitCode).toBe(0);
    expect(response.stdout).toMatch(/\[output truncated at 1000 bytes]$/);
    expect(response.stdout.length).toBeLessThan(1100);
  });

  it("kills a runaway CLI at the timeout", async () => {
    await start({ timeoutMs: 200 });
    const response = await call(socketPath, { argv: ["hang"] });
    expect(response.exitCode).toBe(4);
    expect(response.stderr).toMatch(/timed out/);
  });

  it("serialises requests beyond the concurrency ceiling", async () => {
    await start({ maxConcurrent: 1 });
    const startedAt = Date.now();
    const [first, second] = await Promise.all([
      call(socketPath, { argv: ["slow"] }),
      call(socketPath, { argv: ["slow"] }),
    ]);
    expect(first.stdout).toBe("done");
    expect(second.stdout).toBe("done");
    // Two ~300ms commands through one permit cannot finish in parallel time.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550);
  });

  it("rejects malformed requests with a usage error", async () => {
    await start();
    const response = await call(socketPath, { argv: [] as never, cwd: "" });
    expect(response.exitCode).toBe(1);
  });

  describe("git clone-URL rewriting", () => {
    let upstream: Server;

    beforeEach(async () => {
      // A live upstream so the proxy has something to bind against.
      upstream = createServer((_request, response) => response.end("ok"));
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    });

    afterEach(() => {
      upstream.close();
    });

    it("rewrites relay clone URLs in stdout to the loopback proxy", async () => {
      await start();
      const response = await call(socketPath, { argv: ["repos"] });
      const port = gitProxy.port;
      expect(port).not.toBeNull();
      expect(response.stdout).toContain(`http://127.0.0.1:${port}/git/${"a".repeat(64)}/myrepo`);
      expect(response.stdout).not.toContain("http://relay.local/git/");
    });

    it("rewrites loopback URLs in argv back to the relay origin", async () => {
      await start();
      // argv is echoed on stderr: stdout would be re-mapped by the
      // relay→loopback rewrite, which is exactly the pair being tested.
      const response = await call(socketPath, {
        argv: ["argv-stderr", "--clone", "http://127.0.0.1:49152/git/owner/repo"],
      });
      expect(JSON.parse(response.stderr).args).toEqual([
        "argv-stderr",
        "--clone",
        "http://relay.local/git/owner/repo",
      ]);
    });
  });

  describe("shim integration", () => {
    function runShim(
      args: string[],
      stdin: string | null,
      env: Record<string, string>,
    ): Promise<{ stdout: string; stderr: string; code: number }> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SHIM_PATH, ...args], {
          env: { PATH: process.env["PATH"] ?? "", ...env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.once("error", reject);
        child.once("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
        if (stdin !== null) child.stdin.end(stdin);
        else child.stdin.end();
      });
    }

    it("round-trips argv, stdin, stdout and the exit code through the real socket", async () => {
      await start();
      const result = await runShim(["messages", "send", "--content", "-"], "hello\n", {
        AUTOGENT_BUZZ_SOCKET: socketPath,
      });
      expect(result.code).toBe(0);
      const seen = JSON.parse(result.stdout);
      expect(seen.args).toEqual(["messages", "send", "--content", "-"]);
      expect(seen.stdin).toBe("hello\n");
      expect(seen.key).toBe(SECRET_HEX);
    });

    it("fails clearly when the broker socket is not reachable", async () => {
      const result = await runShim(["channels", "list"], null, {
        AUTOGENT_BUZZ_SOCKET: join(dir, "absent.sock"),
      });
      expect(result.code).toBe(4);
      expect(result.stderr).toMatch(/not available in this environment/);
    });
  });
});
