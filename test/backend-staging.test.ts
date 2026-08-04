/**
 * The staged-execution property.
 *
 * Before it will hand a provider an nsec, Buzz Desktop **copies the resolved
 * binary into a temporary directory**, calls `info` on the copy, checks the
 * protocol version, and only then calls `deploy` — on the same copy. The point
 * is that the bytes which answered the negotiation are the bytes that receive
 * the secret; path-and-metadata comparison would miss an in-place rewrite.
 *
 * For a Node provider that has a consequence which no unit test of the handler
 * would ever catch: from `/tmp/…/provider`, neither a relative import nor a
 * bare `nostr-tools` specifier resolves to anything. The shipped artifact has
 * to be a self-contained single file, and it has to parse when Node is given a
 * file with no extension and no `package.json` beside it. That is what this
 * test pins — the build, not the source.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const bundle = join(process.cwd(), "dist", "backend", "buzz-backend-autogent.cjs");

beforeAll(async () => {
  // Build rather than skip: a conditional skip is how this stops running.
  await promisify(execFile)(process.execPath, ["scripts/build-backend.mjs"], {
    cwd: process.cwd(),
  });
}, 60_000);

interface Invocation {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The environment a Finder-launched Buzz Desktop actually hands a provider.
 *
 * launchd gives a GUI app this PATH and nothing more — no Homebrew, no nvm, no
 * npm bin directory. The provider inherits it verbatim.
 */
const LAUNCHD_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: process.env["HOME"] ?? "",
};

/** Runs the bundle exactly as the desktop does: a staged, extensionless copy. */
function invokeStaged(request: unknown, env?: NodeJS.ProcessEnv): Promise<Invocation> {
  const dir = mkdtempSync(join(tmpdir(), "autogent-staged-"));
  const staged = join(dir, "provider");
  copyFileSync(bundle, staged);
  chmodSync(staged, 0o500);

  return new Promise<Invocation>((done, reject) => {
    const child = spawn(staged, [], { stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("staged execution", () => {
  it("ships a single self-contained file", () => {
    expect(existsSync(bundle)).toBe(true);
  });

  it("answers info when run as an extensionless copy in a temp directory", async () => {
    const result = await invokeStaged({ op: "info", request_id: "staged-1" });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const response = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(response["ok"]).toBe(true);
    expect(response["protocol_version"]).toBe(1);
  });

  it("exits 0 on a failure, because a non-zero status discards the explanation", async () => {
    const result = await invokeStaged({ op: "deploy", agent: { relay_url: "ws://x" } });
    expect(result.code).toBe(0);

    const response = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(response["ok"]).toBe(false);
    expect(typeof response["error"]).toBe("string");
  });

  it("runs under the minimal PATH a GUI-launched desktop hands it", async () => {
    // The regression this pins: with `#!/usr/bin/env node`, launchd's PATH has
    // no `node`, so `env` exits 127 before a byte of the provider runs — there
    // is no in-band error to report and the UI can only say "exit code 127".
    const result = await invokeStaged({ op: "info" }, LAUNCHD_ENV);

    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(response["ok"]).toBe(true);
  });

  it("never echoes the private key it was handed", async () => {
    const { mintAgent } = await import("./helpers/backend-request.js");
    const minted = mintAgent({ relay_url: "not-a-relay-url" });
    const result = await invokeStaged({ op: "deploy", agent: minted.agent });

    const response = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(response["ok"]).toBe(false);
    expect(result.stdout).not.toContain(minted.nsec);
    expect(result.stdout).not.toContain("nsec1");
  });

  it("stays parseable when a policy value is also a JSON keyword", async () => {
    // The regression: a real payload sets `BUZZ_ACP_LAZY_POOL=true`, so the
    // string `true` is collected as a secret value. Scrubbing the serialised
    // response then rewrote `{"ok":true,…}` to `{"ok":[redacted],…}` — and the
    // desktop reported "provider produced no JSON response" for a deploy that
    // had already succeeded.
    const { mintAgent } = await import("./helpers/backend-request.js");
    const minted = mintAgent({
      relay_url: "not-a-relay-url",
      launch: {
        command: "autogent-nostr",
        args: [],
        env: {},
        policy_env: {
          BUZZ_ACP_LAZY_POOL: "true",
          BUZZ_ACP_RELAY_OBSERVER: "true",
          BUZZ_ACP_SESSION_TITLE: "worker",
        },
        owner_pubkey: null,
      },
    });
    const result = await invokeStaged({ op: "deploy", agent: minted.agent });

    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
    const response = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(response["ok"]).toBe(false);
  });
});
