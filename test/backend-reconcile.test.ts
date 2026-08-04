/**
 * The deploy state machine, driven against real processes.
 *
 * The agent is stubbed — a few lines of Node that write the same "agent online"
 * line the real runtime writes, or deliberately fail to — but everything else is
 * real: real directories, real spawns, real pids, real `ps`. The failure modes
 * this file pins are the ones that are cheap to reason about wrongly:
 *
 * - Start on a running agent must be a **strict no-op**, mutating nothing —
 *   otherwise pressing Start twice kills an agent mid-turn.
 * - A slow startup must be **observed, never replaced**, on this call and every
 *   later one — otherwise a slow machine becomes a livelock in which every
 *   individual decision looked right.
 * - A *changed* configuration must replace a never-started instance —
 *   otherwise a wedged instance swallows every edit the user makes to fix it.
 * - One create attempt per call — otherwise a deterministic startup failure
 *   spawns a fresh process every poll interval until the deadline.
 */

import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderConfig } from "../src/backend/config.js";
import { parseDeployPayload } from "../src/backend/payload.js";
import { deploy } from "../src/backend/reconcile.js";
import { instanceAlive, instancePaths, readInstance } from "../src/backend/registry.js";
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
  const root = mkdtempSync(join(tmpdir(), "autogent-test-"));
  roots.push(root);
  return root;
}

/**
 * A stand-in for `autogent-nostr`.
 *
 * `online` prints the runtime's own boot line and stays alive; `silent` stays
 * alive without ever reporting itself; `dies` exits immediately; `fatal` logs a
 * deterministic startup failure the way the real runtime does, then exits.
 */
function stubAgent(root: string, mode: "online" | "silent" | "dies" | "fatal"): string {
  const path = join(root, `stub-${mode}.mjs`);
  const bodies: Record<string, string> = {
    online: `console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "agent online" }));
setInterval(() => {}, 1000);`,
    silent: `setInterval(() => {}, 1000);`,
    dies: `process.exit(1);`,
    fatal: `console.log(JSON.stringify({ level: "error", msg: "startup failed", error: "no provider credential" }));
setInterval(() => {}, 1000);`,
  };
  writeFileSync(path, `#!/usr/bin/env node\n${bodies[mode]}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

interface Scenario {
  payload: ReturnType<typeof parseDeployPayload>;
  config: ReturnType<typeof parseProviderConfig>;
  root: string;
}

function scenario(
  root: string,
  command: string,
  extraConfig: Record<string, unknown> = {},
): Scenario {
  const payload = parseDeployPayload(mintAgent().agent);
  const config = parseProviderConfig({
    command,
    state_root: root,
    startup_timeout_seconds: 5,
    ...extraConfig,
  });
  return { payload, config, root };
}

async function run(input: Scenario): Promise<{ agentId: string; noop: boolean }> {
  const outcome = await deploy({ payload: input.payload, config: input.config });
  const paths = instancePaths(input.config.stateRoot, input.payload.agentPubkey);
  const record = readInstance(paths, input.payload.agentPubkey);
  if (record?.pid) spawned.push(record.pid);
  return outcome;
}

describe("deploy reconciliation", () => {
  it("creates, waits for the agent to actually come up, and returns its id", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "online"));
    const outcome = await run(input);

    expect(outcome.agentId).toBe(`buzz-agent-${input.payload.agentPubkey.slice(0, 12)}`);
    const paths = instancePaths(root, input.payload.agentPubkey);
    const record = readInstance(paths, input.payload.agentPubkey);
    expect(record).not.toBeNull();
    expect(instanceAlive(record!)).toBe(true);
    // The identity was sealed into the state directory, never into the env.
    expect(readFileSync(join(paths.stateDir, "identity.json"), "utf8")).toContain(
      input.payload.agentPubkey,
    );
  });

  it("returns a live agent untouched — same id, same process, nothing rewritten", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "online"));
    await run(input);

    const paths = instancePaths(root, input.payload.agentPubkey);
    const before = readFileSync(paths.recordPath, "utf8");
    const keyBefore = readFileSync(join(paths.stateDir, "agent.key"), "utf8");

    const second = await run(input);
    expect(second.noop).toBe(true);
    expect(readFileSync(paths.recordPath, "utf8")).toBe(before);
    expect(readFileSync(join(paths.stateDir, "agent.key"), "utf8")).toBe(keyBefore);
  });

  it("no-ops on a live agent even when the configuration has since changed", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "online"));
    await run(input);
    const paths = instancePaths(root, input.payload.agentPubkey);
    const before = readFileSync(paths.recordPath, "utf8");

    // A different intent — but the agent is *started*, so it is left alone.
    const edited: Scenario = {
      ...input,
      config: { ...input.config, logLevel: "debug" },
    };
    const outcome = await run(edited);
    expect(outcome.noop).toBe(true);
    expect(readFileSync(paths.recordPath, "utf8")).toBe(before);
  });

  it("revives a dead agent: residue is cleared and a fresh generation starts", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "online"));
    await run(input);

    const paths = instancePaths(root, input.payload.agentPubkey);
    const first = readInstance(paths, input.payload.agentPubkey)!;
    process.kill(first.pid!, "SIGKILL");
    await new Promise((done) => setTimeout(done, 300));

    const outcome = await run(input);
    const second = readInstance(paths, input.payload.agentPubkey)!;
    expect(outcome.agentId).toBe(first.agent_id);
    expect(second.pid).not.toBe(first.pid);
    expect(second.generation).not.toBe(first.generation);
  });

  it("observes a slow startup to the deadline and leaves the process alone", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "silent"), { startup_timeout_seconds: 5 });

    await expect(run(input)).rejects.toThrow(/startup was not confirmed/);

    const paths = instancePaths(root, input.payload.agentPubkey);
    const record = readInstance(paths, input.payload.agentPubkey)!;
    spawned.push(record.pid!);
    expect(instanceAlive(record)).toBe(true);
  });

  it("never replaces a still-starting instance on a repeated identical Start", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "silent"), { startup_timeout_seconds: 5 });

    await expect(run(input)).rejects.toThrow(/startup was not confirmed/);
    const paths = instancePaths(root, input.payload.agentPubkey);
    const first = readInstance(paths, input.payload.agentPubkey)!;
    spawned.push(first.pid!);

    await expect(run(input)).rejects.toThrow(/startup was not confirmed/);
    const second = readInstance(paths, input.payload.agentPubkey)!;
    expect(second.pid).toBe(first.pid);
    expect(second.generation).toBe(first.generation);
    expect(second.created_at).toBe(first.created_at);
  });

  it("replaces a never-started instance once the configuration changes", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "silent"), { startup_timeout_seconds: 5 });
    await expect(run(input)).rejects.toThrow(/startup was not confirmed/);

    const paths = instancePaths(root, input.payload.agentPubkey);
    const first = readInstance(paths, input.payload.agentPubkey)!;
    spawned.push(first.pid!);

    // The user fixes the thing it was wedged on. The edit has to be able to
    // reach it, or there is no way out short of deleting files by hand.
    const fixed: Scenario = {
      ...input,
      config: parseProviderConfig({
        command: stubAgent(root, "online"),
        state_root: root,
        startup_timeout_seconds: 5,
      }),
    };
    const outcome = await run(fixed);
    const second = readInstance(paths, input.payload.agentPubkey)!;
    expect(outcome.noop).toBe(false);
    expect(second.pid).not.toBe(first.pid);
    expect(instanceAlive(second)).toBe(true);
    expect(instanceAlive(first)).toBe(false);
  });

  it("abandons a kill when the agent comes up between classification and signal", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "silent"), { startup_timeout_seconds: 5 });
    await expect(run(input)).rejects.toThrow(/startup was not confirmed/);

    const paths = instancePaths(root, input.payload.agentPubkey);
    const first = readInstance(paths, input.payload.agentPubkey)!;
    spawned.push(first.pid!);

    // The instance finishes starting up — exactly in the window between the
    // classifying read and the signal a divergent deploy would send.
    appendFileSync(
      paths.logPath,
      `${JSON.stringify({ level: "info", msg: "agent online" })}\n`,
    );

    // A deploy whose intent differs would otherwise take the replace row.
    const diverged: Scenario = {
      ...input,
      config: parseProviderConfig({
        command: stubAgent(root, "online"),
        state_root: root,
        startup_timeout_seconds: 5,
      }),
    };
    const outcome = await run(diverged);

    expect(outcome.noop).toBe(true);
    const after = readInstance(paths, input.payload.agentPubkey)!;
    expect(after.pid).toBe(first.pid);
    expect(instanceAlive(after)).toBe(true);
  });

  it("records the harness the desktop asked for, even though it runs its own", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "online"));
    input.payload.launch = { ...input.payload.launch!, command: "goose" };
    await run(input);

    const paths = instancePaths(root, input.payload.agentPubkey);
    expect(readInstance(paths, input.payload.agentPubkey)!.requested_command).toBe("goose");
  });

  it("reports a deterministic startup failure with the agent's own reason", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "fatal"));
    await expect(run(input)).rejects.toThrow(/no provider credential/);
  });

  it("makes exactly one create attempt per call", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "dies"), { startup_timeout_seconds: 5 });

    const started = Date.now();
    await expect(run(input)).rejects.toThrow(/exited during startup|disappeared immediately/);
    // A retry loop would have burned the whole deadline spawning processes.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("refuses to touch a record it cannot prove it wrote", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "online"));
    const paths = instancePaths(root, input.payload.agentPubkey);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.recordPath, JSON.stringify({ managed_by: "something-else" }));

    await expect(run(input)).rejects.toThrow(/not managed by/);
  });

  it("refuses a record whose short name collides with another agent key", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "online"));
    const paths = instancePaths(root, input.payload.agentPubkey);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.recordPath,
      JSON.stringify({ managed_by: "buzz-backend-autogent", agent_pubkey: "f".repeat(64) }),
    );

    await expect(run(input)).rejects.toThrow(/collision/);
  });

  it("keeps the agent's database and identity across generations", async () => {
    const root = newRoot();
    const input = scenario(root, stubAgent(root, "online"));
    await run(input);

    const paths = instancePaths(root, input.payload.agentPubkey);
    const identityBefore = JSON.parse(
      readFileSync(join(paths.stateDir, "identity.json"), "utf8"),
    ) as Record<string, unknown>;
    const keyBefore = readFileSync(join(paths.stateDir, "agent.key"), "utf8");
    writeFileSync(join(paths.stateDir, "agent.db"), "pretend-database");

    const record = readInstance(paths, input.payload.agentPubkey)!;
    process.kill(record.pid!, "SIGKILL");
    await new Promise((done) => setTimeout(done, 300));
    await run(input);

    // Restart safety depends on this: the dedup ledger and signed outbox are
    // what make a restart re-send identical bytes instead of a second message.
    expect(readFileSync(join(paths.stateDir, "agent.db"), "utf8")).toBe("pretend-database");
    expect(readFileSync(join(paths.stateDir, "agent.key"), "utf8")).toBe(keyBefore);

    // The identity itself is unchanged; only `provisionedAt` moves, because a
    // redeploy really is a fresh provisioning of the same key.
    const identityAfter = JSON.parse(
      readFileSync(join(paths.stateDir, "identity.json"), "utf8"),
    ) as Record<string, unknown>;
    expect({ ...identityAfter, provisionedAt: null }).toEqual({
      ...identityBefore,
      provisionedAt: null,
    });
  });
});
