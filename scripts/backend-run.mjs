#!/usr/bin/env node
/**
 * Drives `buzz-backend-autogent` by hand, the way Buzz Desktop drives it.
 *
 * The point is not convenience — it is fidelity. By default every request runs
 * against a **staged copy** of the bundle: copied into a temp directory, named
 * `provider` with no extension, chmod 0500. That is exactly what the desktop
 * does before handing a provider an nsec, and it is the one property a normal
 * `node dist/backend/…` invocation would silently fail to test.
 *
 * Usage:
 *   node scripts/backend-run.mjs info
 *   node scripts/backend-run.mjs mint --relay ws://localhost:3000 [--out req.json]
 *   node scripts/backend-run.mjs deploy req.json [--config '{"log_level":"debug"}']
 *   node scripts/backend-run.mjs status req.json
 *
 * `mint` generates a throwaway owner keypair, signs a real NIP-OA attestation
 * for a fresh agent key, and writes a deploy request that is byte-compatible
 * with the desktop's. It is a test fixture, not a provisioning tool: the owner
 * key it invents exists only inside the generated file.
 */

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist", "backend", "buzz-backend-autogent.cjs");

function parseArgs(argv) {
  const positional = [];
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(name);
      continue;
    }
    values.set(name, next);
    index += 1;
  }
  return { positional, values, flags };
}

/** Copies the bundle the way the desktop stages a provider before deploy. */
function stage() {
  const dir = mkdtempSync(join(tmpdir(), "autogent-stage-"));
  const staged = join(dir, "provider");
  copyFileSync(bundle, staged);
  chmodSync(staged, 0o500);
  return { dir, staged };
}

async function invoke(request, { staged = true } = {}) {
  const stagedCopy = staged ? stage() : null;
  const binary = stagedCopy ? stagedCopy.staged : bundle;
  try {
    return await new Promise((done, reject) => {
      const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => done({ code, out }));
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  } finally {
    if (stagedCopy) rmSync(stagedCopy.dir, { recursive: true, force: true });
  }
}

function report({ code, out }) {
  const trimmed = out.trim();
  process.stdout.write(`exit=${code}\n`);
  try {
    process.stdout.write(`${JSON.stringify(JSON.parse(trimmed), null, 2)}\n`);
  } catch {
    process.stdout.write(`${trimmed}\n`);
  }
  return code === 0 && trimmed.includes('"ok":true') ? 0 : 1;
}

async function commandInfo() {
  return report(await invoke({ op: "info", request_id: randomUUID() }));
}

async function commandMint(flags) {
  const { createSigner } = await import(join(root, "dist", "nostr", "signer.js"));
  const { signAttestation, toNostrTag } = await import(join(root, "dist", "nostr", "nip-oa.js"));
  const { randomBytes } = await import("node:crypto");
  const { nsecEncode } = await import("nostr-tools/nip19");

  const agentSecret = Uint8Array.from(randomBytes(32));
  const ownerSecret = Uint8Array.from(randomBytes(32));
  // `createSigner` takes ownership of the array it is handed, so each key is
  // decoded into its own copy.
  const agentPubkey = createSigner(Uint8Array.from(agentSecret)).publicKey;
  const ownerPubkey = createSigner(Uint8Array.from(ownerSecret)).publicKey;

  const conditions = "";
  const auth = signAttestation(ownerSecret, agentPubkey, conditions);

  const relay = flags.values.get("relay") ?? "ws://localhost:3000";
  const name = flags.values.get("name") ?? "Autogent Test Agent";

  const request = {
    op: "deploy",
    request_id: randomUUID(),
    agent: {
      name,
      relay_url: relay,
      private_key_nsec: nsecEncode(agentSecret),
      auth_tag: JSON.stringify(toNostrTag(auth)),
      agent_command: "autogent-nostr",
      agent_args: [],
      system_prompt: null,
      model: null,
      provider: null,
      turn_timeout_seconds: 300,
      idle_timeout_seconds: null,
      max_turn_duration_seconds: null,
      parallelism: 4,
      respond_to: "owner-only",
      respond_to_allowlist: [],
      env_vars: {},
      launch: {
        command: "autogent-nostr",
        args: [],
        env: {},
        policy_env: {},
        owner_pubkey: ownerPubkey,
      },
    },
    provider_config: {},
  };

  const out = flags.values.get("out");
  const text = `${JSON.stringify(request, null, 2)}\n`;
  if (out) {
    writeFileSync(out, text, { mode: 0o600 });
    process.stdout.write(
      `wrote ${out}\n  agent: ${agentPubkey}\n  owner: ${ownerPubkey}\n` +
        `\nThis file contains a private key. It is a throwaway test identity.\n`,
    );
  } else {
    process.stdout.write(text);
  }
  return 0;
}

async function commandDeploy(flags) {
  const file = flags.positional[0];
  if (!file) {
    process.stderr.write("deploy requires a request file (see: backend-run.mjs mint --out …)\n");
    return 2;
  }
  const request = JSON.parse(readFileSync(file, "utf8"));
  const configOverride = flags.values.get("config");
  if (configOverride) request.provider_config = JSON.parse(configOverride);
  request.op = "deploy";
  request.request_id = randomUUID();
  return report(await invoke(request, { staged: !flags.flags.has("no-stage") }));
}

/** Prints where a deployed agent's files live, straight from the request. */
async function commandStatus(flags) {
  const file = flags.positional[0];
  if (!file) {
    process.stderr.write("status requires the same request file used for deploy\n");
    return 2;
  }
  const request = JSON.parse(readFileSync(file, "utf8"));
  const { createSigner, decodeSecretKey } = await import(join(root, "dist", "nostr", "signer.js"));
  const pubkey = createSigner(decodeSecretKey(request.agent.private_key_nsec)).publicKey;

  const { parseProviderConfig } = await import(join(root, "dist", "backend", "config.js"));
  const { instancePaths, readInstance, instanceAlive } = await import(
    join(root, "dist", "backend", "registry.js")
  );
  const configOverride = flags.values.get("config");
  const config = parseProviderConfig(
    configOverride ? JSON.parse(configOverride) : (request.provider_config ?? {}),
  );
  const paths = instancePaths(config.stateRoot, pubkey);
  const record = readInstance(paths, pubkey);

  process.stdout.write(
    `${JSON.stringify(
      {
        agent_pubkey: pubkey,
        instance_dir: paths.dir,
        log: paths.logPath,
        record,
        alive: record ? instanceAlive(record) : false,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

const commands = {
  info: commandInfo,
  mint: commandMint,
  deploy: commandDeploy,
  status: commandStatus,
};

const handler = commands[command ?? ""];
if (!handler) {
  process.stderr.write(
    "usage: backend-run.mjs <info|mint|deploy|status> [options]\n" +
      "  info                              probe the provider\n" +
      "  mint --relay <url> --out <file>   generate a throwaway deploy request\n" +
      "  deploy <file> [--no-stage]        run a deploy request\n" +
      "  status <file> [--config <json>]   show the instance record on disk\n",
  );
  process.exit(2);
}

process.exitCode = await handler(flags);
