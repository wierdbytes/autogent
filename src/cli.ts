#!/usr/bin/env node
/**
 * `autogent-nostr` command line.
 *
 * Three of these commands run on the agent host and one — `attest` — runs on the
 * owner's machine. That split is the entire provisioning story: the owner's
 * secret key signs an attestation locally and never travels (plan §4).
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { applyEnv, defaultConfig, validateConfig } from "./config.js";
import { attestFromFile, DEFAULT_CONDITIONS } from "./provisioning/attest.js";
import {
  createDoctorFacade,
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
} from "./provisioning/doctor.js";
import { importAttestationFile } from "./provisioning/import.js";
import {
  applyMembership,
  isMemberRole,
  MEMBER_ROLES,
} from "./provisioning/channel-membership.js";
import { ARGV_SECRET_WARNING, type OwnerSecretSource } from "./provisioning/owner-secret.js";
import { createIdentityStore, ProvisioningError } from "./provisioning/identity-store.js";
import { initIdentity, initInstructions } from "./provisioning/init.js";
import { ProfileReconciler } from "./nostr/profile.js";
import { createEventBuilder } from "./nostr/event-builder.js";
import { RelaySupervisor } from "./nostr/relay-supervisor.js";
import { systemClock } from "./runtime/clock.js";
import { createLogger } from "./runtime/logger.js";
import { run } from "./main.js";

const USAGE = `autogent-nostr — standalone Nostr agent on the Pi SDK

Usage:
  autogent-nostr init [--relay <url>] [--name <name>] [--about <text>] [--force]
  autogent-nostr attest <pairing-request.json> --out <attestation.json>
                        [--owner-private-key <hex|nsec>] [--conditions <expr>]
  autogent-nostr provision import <attestation.json>
  autogent-nostr channel add    --channel <uuid> [--pubkey <hex>] [--role bot]
                                [--owner-private-key <hex|nsec>]
  autogent-nostr channel remove --channel <uuid> [--pubkey <hex>]
                                [--owner-private-key <hex|nsec>]
  autogent-nostr profile sync
  autogent-nostr doctor
  autogent-nostr run

Commands:
  init              Generate the agent identity and a pairing request (agent host).
  attest            Sign an owner attestation for a pairing request (OWNER host).
  provision import  Verify and store an attestation (agent host).
  channel add       Add a member to a channel (OWNER host — signs with the owner key).
  channel remove    Remove a member from a channel (OWNER host).
  profile sync      Republish kind 0 / kind 10100 if they are missing or stale.
  doctor            Check identity, permissions, configuration and Pi availability.
  run               Start the agent.

The channel commands default --pubkey to this host's agent and --role to bot.
The owner key is read interactively unless --owner-private-key is given; passing
it on the command line leaks the key into shell history and ps output.

Configuration comes from AUTOGENT_* environment variables; see README.
`;

interface Flags {
  positional: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

function parseFlags(argv: string[]): Flags {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      booleans.add(name);
      continue;
    }
    values.set(name, next);
    index += 1;
  }
  return { positional, values, booleans };
}

async function commandInit(flags: Flags): Promise<number> {
  const base = applyEnv(defaultConfig());
  const result = await initIdentity({
    stateDir: flags.values.get("state-dir") ?? base.stateDir,
    relayUrl: flags.values.get("relay") ?? base.relayUrl,
    profile: {
      name: flags.values.get("name") ?? base.profile.name,
      about: flags.values.get("about") ?? base.profile.about,
    },
    force: flags.booleans.has("force"),
  });
  process.stdout.write(`${initInstructions(result)}\n`);
  return 0;
}

async function commandAttest(flags: Flags): Promise<number> {
  const pairingRequestPath = flags.positional[0];
  const outPath = flags.values.get("out");
  if (!pairingRequestPath || !outPath) {
    process.stderr.write("attest requires <pairing-request.json> and --out <path>\n");
    return 2;
  }

  const attestation = await attestFromFile({
    pairingRequestPath,
    outPath,
    ownerSecret: ownerSecretSource(flags),
    conditions: flags.values.get("conditions") ?? DEFAULT_CONDITIONS,
  });

  process.stdout.write(
    `Signed attestation for agent ${attestation.agentPubkey}\n` +
      `  owner:      ${attestation.ownerPubkey}\n` +
      `  conditions: ${attestation.conditions === "" ? "(none)" : attestation.conditions}\n` +
      `  written to: ${outPath}\n\n` +
      `Copy it to the agent host and run:\n` +
      `  autogent-nostr provision import ${outPath}\n`,
  );
  return 0;
}

async function commandProvisionImport(flags: Flags): Promise<number> {
  const attestationPath = flags.positional[0];
  if (!attestationPath) {
    process.stderr.write("provision import requires <attestation.json>\n");
    return 2;
  }
  const config = applyEnv(defaultConfig());
  const result = await importAttestationFile({
    attestationPath,
    stateDir: flags.values.get("state-dir") ?? config.stateDir,
  });
  process.stdout.write(
    `Provisioned.\n  agent: ${result.agentPubkey}\n  owner: ${result.ownerPubkey}\n\n` +
      `The owner must also add this agent to the channels it should join.\n`,
  );
  return 0;
}

/**
 * Resolves the owner key source.
 *
 * Interactive by default. `--owner-private-key` exists for unattended use and
 * warns, because the value is then in shell history and visible via `ps`.
 */
function ownerSecretSource(flags: Flags): OwnerSecretSource {
  const literal = flags.values.get("owner-private-key");
  if (literal !== undefined) {
    process.stderr.write(`${ARGV_SECRET_WARNING}\n`);
    return { from: "literal", value: literal };
  }
  const file = flags.values.get("owner-secret-file");
  if (file !== undefined) return { from: "file", path: file };
  return { from: "stdin" };
}

async function commandChannel(action: "add" | "remove", flags: Flags): Promise<number> {
  const config = applyEnv(defaultConfig());
  const channelId = flags.values.get("channel");
  if (!channelId) {
    process.stderr.write("channel requires --channel <uuid>\n");
    return 2;
  }

  // Defaulting to the local agent is the overwhelmingly common case, and it
  // removes a copy-paste step that is easy to get wrong.
  let memberPubkey = flags.values.get("pubkey");
  if (!memberPubkey) {
    const record = await createIdentityStore({ stateDir: config.stateDir }).readRecord();
    if (!record) {
      process.stderr.write(
        "no local agent identity; pass --pubkey <hex> explicitly\n",
      );
      return 2;
    }
    memberPubkey = record.agentPubkey;
  }

  const role = action === "add" ? (flags.values.get("role") ?? "bot") : undefined;
  if (role !== undefined && !isMemberRole(role)) {
    process.stderr.write(`role must be one of ${MEMBER_ROLES.join(", ")}\n`);
    return 2;
  }

  const result = await applyMembership({
    action,
    relayUrl: config.relayUrl,
    channelId,
    memberPubkey,
    role,
    ownerSecret: ownerSecretSource(flags),
    logger: createLogger(config.logLevel),
  });

  const verb = action === "add" ? "Added" : "Removed";
  process.stdout.write(
    `${verb} ${result.memberPubkey}\n` +
      `  channel: ${result.channelId}\n` +
      (result.role ? `  role:    ${result.role}\n` : "") +
      `  owner:   ${result.ownerPubkey}\n` +
      `  event:   ${result.eventId}\n\n` +
      (action === "add"
        ? "The agent picks this up live via a kind 44100 notification; no restart needed.\n"
        : ""),
  );
  return 0;
}

async function commandProfileSync(): Promise<number> {
  const config = applyEnv(defaultConfig());
  const logger = createLogger(config.logLevel);
  const store = createIdentityStore({ stateDir: config.stateDir });
  const record = await store.requireRecord();
  if (!record.auth) {
    process.stderr.write("agent is not provisioned; run `provision import` first\n");
    return 2;
  }

  const signer = await store.loadSigner();
  const builder = createEventBuilder({ signer, authTag: record.auth, clock: systemClock });
  const relay = new RelaySupervisor({
    url: config.relayUrl,
    builder,
    clock: systemClock,
    logger: logger.child({ component: "relay" }),
  });

  try {
    await relay.connect();
    const reconciler = new ProfileReconciler({ relay, builder, profile: config.profile, logger });
    const outcome = await reconciler.reconcile({
      status: "offline",
      capabilities: [],
      channels: [],
      channelIds: [],
    });
    const state = (published: boolean) => (published ? "republished" : "already current");
    process.stdout.write(
      `kind 0:     ${state(outcome.metadataPublished)}\n` +
        `kind 10100: ${state(outcome.agentProfilePublished)}\n`,
    );
    return 0;
  } finally {
    await relay.close();
  }
}

async function commandDoctor(): Promise<number> {
  const config = applyEnv(defaultConfig());
  const store = createIdentityStore({ stateDir: config.stateDir });
  const results = await runDoctor(config, createDoctorFacade({ store, agentDir: config.pi.agentDir }));
  process.stdout.write(`${formatDoctorReport(results)}\n`);
  return doctorExitCode(results);
}

function commandConfig(): number {
  const config = applyEnv(defaultConfig());
  const problems = validateConfig(config);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  for (const problem of problems) process.stderr.write(`warning: ${problem}\n`);
  return problems.length === 0 ? 0 : 2;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case "init":
      return commandInit(flags);
    case "attest":
      return commandAttest(flags);
    case "provision":
      if (flags.positional[0] !== "import") {
        process.stderr.write("unknown provision subcommand; expected `import`\n");
        return 2;
      }
      return commandProvisionImport({ ...flags, positional: flags.positional.slice(1) });
    case "channel": {
      const sub = flags.positional[0];
      if (sub !== "add" && sub !== "remove") {
        process.stderr.write("unknown channel subcommand; expected `add` or `remove`\n");
        return 2;
      }
      return commandChannel(sub, flags);
    }
    case "profile":
      if (flags.positional[0] !== "sync") {
        process.stderr.write("unknown profile subcommand; expected `sync`\n");
        return 2;
      }
      return commandProfileSync();
    case "doctor":
      return commandDoctor();
    case "config":
      return commandConfig();
    case "run":
    case undefined:
      return run();
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

/**
 * True when this module is the process entry rather than a test import.
 *
 * `process.argv[1]` is the path as invoked, which for an installed bin is a
 * symlink into `node_modules`, while `import.meta.url` is always the resolved
 * real path. Comparing them without `realpathSync` makes the guard fail for
 * every global install — the CLI then exits 0 having done nothing.
 */
function invokedDirectly(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message =
        error instanceof ProvisioningError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    });
}

export { USAGE };
