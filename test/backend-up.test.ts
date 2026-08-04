/**
 * `autogent-nostr up` — the manual start path, driven against real processes.
 *
 * The properties pinned here are the ones that separate this command from a
 * hand-written `env … autogent-nostr run` recipe, and each of them is a way the
 * command could look fine and still be wrong:
 *
 * - It **converges** rather than launching: a live instance is adopted
 *   untouched, a dead one is replaced, and either way `instance.json` describes
 *   the process that is actually running. A second copy of the same agent key
 *   is what invariant I4 forbids.
 * - It **never reads the sealed key**. Pinned by making the key unreadable and
 *   asserting the start still succeeds — the one assertion a refactor that
 *   "simplified" this into a `deploy` call could not survive.
 * - It **fails closed before mutating**: an unprovisioned directory, an
 *   ambiguous selector and a dry run all leave the tree exactly as they found
 *   it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderConfig } from "../src/backend/config.js";
import { parseDeployPayload } from "../src/backend/payload.js";
import { deploy } from "../src/backend/reconcile.js";
import { instanceAlive, instancePaths, readInstance } from "../src/backend/registry.js";
import { up } from "../src/backend/up.js";
import { mintAgent } from "./helpers/backend-request.js";

const roots: string[] = [];
const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "autogent-up-"));
  roots.push(root);
  return root;
}

/** Stand-in for `autogent-nostr`: prints the runtime's boot line, then idles. */
function stubAgent(root: string, mode: "online" | "dies" = "online"): string {
  const path = join(root, `stub-${mode}.mjs`);
  const body =
    mode === "online"
      ? `console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "agent online" }));\nsetInterval(() => {}, 1000);`
      : `process.exit(1);`;
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function track(root: string, agentPubkey: string): number | null {
  const record = readInstance(instancePaths(root, agentPubkey), agentPubkey);
  if (record?.pid) spawned.push(record.pid);
  return record?.pid ?? null;
}

/** Provisions an instance the way the desktop would, then stops the process. */
async function seed(root: string, command: string, overrides: Record<string, unknown> = {}) {
  const minted = mintAgent(overrides);
  const payload = parseDeployPayload(minted.agent);
  const config = parseProviderConfig({
    command,
    state_root: root,
    startup_timeout_seconds: 10,
  });
  await deploy({ payload, config });
  const pid = track(root, payload.agentPubkey);
  return { minted, payload, config, pid, paths: instancePaths(root, payload.agentPubkey) };
}

function kill(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  // SIGKILL is not synchronous; give the kernel a moment to reap.
  const until = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > until) return;
  }
}

describe("up: starting a provisioned instance by hand", () => {
  it("revives a stopped instance, recording a fresh generation and a live pid", async () => {
    const root = newRoot();
    const command = stubAgent(root);
    const seeded = await seed(root, command);
    const before = readInstance(seeded.paths, seeded.payload.agentPubkey);
    kill(seeded.pid);

    const result = await up({
      stateRoot: root,
      command,
      startupTimeoutSeconds: 10,
      relayUrl: "ws://localhost:3000",
    });
    track(root, seeded.payload.agentPubkey);

    expect(result.noop).toBe(false);
    expect(result.agentPubkey).toBe(seeded.payload.agentPubkey);
    expect(result.agentId).toBe(`buzz-agent-${seeded.payload.agentPubkey.slice(0, 12)}`);
    expect(result.pid).toBeTypeOf("number");
    expect(result.pid).not.toBe(seeded.pid);

    const after = readInstance(seeded.paths, seeded.payload.agentPubkey);
    expect(after).not.toBeNull();
    expect(instanceAlive(after!)).toBe(true);
    // A new life, not a rewritten record: the generation is the correlator that
    // ties this pid to the log lines it produced.
    expect(after!.generation).not.toBe(before!.generation);
    expect(after!.pid_signature).not.toBeNull();
  });

  it("adopts a live instance untouched", async () => {
    const root = newRoot();
    const command = stubAgent(root);
    const seeded = await seed(root, command);
    const before = readFileSync(seeded.paths.recordPath, "utf8");

    const result = await up({ stateRoot: root, command, startupTimeoutSeconds: 10 });

    expect(result.noop).toBe(true);
    expect(result.pid).toBe(seeded.pid);
    expect(readFileSync(seeded.paths.recordPath, "utf8")).toBe(before);
  });

  it("starts without being able to read the sealed key", async () => {
    const root = newRoot();
    const command = stubAgent(root);
    const seeded = await seed(root, command);
    kill(seeded.pid);

    // The key stays where it is and stays required — it is simply not readable
    // by this process. `deploy` could not get past `provisionStateDir` here.
    const keyPath = join(seeded.paths.stateDir, "agent.key");
    const keyBefore = readFileSync(keyPath, "utf8");
    chmodSync(keyPath, 0o000);
    try {
      const result = await up({ stateRoot: root, command, startupTimeoutSeconds: 10 });
      track(root, seeded.payload.agentPubkey);
      expect(result.noop).toBe(false);
      expect(result.pid).toBeTypeOf("number");
    } finally {
      chmodSync(keyPath, 0o600);
    }
    expect(readFileSync(keyPath, "utf8")).toBe(keyBefore);
  });

  it("refuses a directory that was never provisioned, without creating one", async () => {
    const root = newRoot();
    await expect(up({ stateRoot: root })).rejects.toThrow(/no instances under/);
    expect(existsSync(join(root, "instances"))).toBe(false);
  });

  it("refuses an ambiguous selector and names the candidates", async () => {
    const root = newRoot();
    const command = stubAgent(root);
    const first = await seed(root, command);
    const second = await seed(root, command);

    await expect(up({ stateRoot: root, command })).rejects.toThrow(/pass --agent/);
    // Both keys are offered, so the error is actionable rather than merely correct.
    await expect(up({ stateRoot: root, command })).rejects.toThrow(
      new RegExp(first.payload.agentPubkey),
    );
    await expect(up({ stateRoot: root, command })).rejects.toThrow(
      new RegExp(second.payload.agentPubkey),
    );
  });

  it("selects by pubkey prefix", async () => {
    const root = newRoot();
    const command = stubAgent(root);
    const first = await seed(root, command);
    await seed(root, command);
    kill(first.pid);

    const result = await up({
      stateRoot: root,
      agent: first.payload.agentPubkey.slice(0, 8),
      command,
      startupTimeoutSeconds: 10,
    });
    track(root, first.payload.agentPubkey);
    expect(result.agentPubkey).toBe(first.payload.agentPubkey);
  });

  it("dry run resolves the plan and mutates nothing", async () => {
    const root = newRoot();
    const command = stubAgent(root);
    const seeded = await seed(root, command);
    kill(seeded.pid);
    const before = readFileSync(seeded.paths.recordPath, "utf8");

    const result = await up({ stateRoot: root, command, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.pid).toBeNull();
    expect(result.command).toContain(command);
    expect(readFileSync(seeded.paths.recordPath, "utf8")).toBe(before);
  });

  it("takes the relay and profile from identity.json when no flag overrides them", async () => {
    const root = newRoot();
    const command = stubAgent(root);
    const seeded = await seed(root, command, {
      relay_url: "wss://relay.example",
      name: "Sealed Name",
    });
    kill(seeded.pid);

    const result = await up({ stateRoot: root, command, dryRun: true, ambient: {} });
    expect(result.relayUrl).toBe("wss://relay.example");
    expect(result.profileName).toBe("Sealed Name");
  });

  it("lets AUTOGENT_* in this process supply what deploy did not persist", async () => {
    const root = newRoot();
    const command = stubAgent(root);
    const seeded = await seed(root, command);
    kill(seeded.pid);

    const plain = await up({ stateRoot: root, command, dryRun: true, ambient: {} });
    const overridden = await up({
      stateRoot: root,
      command,
      dryRun: true,
      ambient: { AUTOGENT_PROFILE_NAME: "From Env", AUTOGENT_RELAY_URL: "wss://from.env" },
    });

    expect(plain.profileName).not.toBe("From Env");
    expect(overridden.profileName).toBe("From Env");
    expect(overridden.relayUrl).toBe("wss://from.env");
  });

  it("refuses a relay url that is not a websocket url", async () => {
    const root = newRoot();
    const command = stubAgent(root);
    const seeded = await seed(root, command);
    kill(seeded.pid);

    await expect(
      up({ stateRoot: root, command, relayUrl: "https://relay.example" }),
    ).rejects.toThrow(/ws:\/\/ or wss:\/\//);
  });
});
