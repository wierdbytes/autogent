/**
 * `autogent-nostr config show|publish` — owner-side config record management.
 *
 *   config show    --agent <pubkey>                 print the current core head
 *   config publish --agent <pubkey> --file <path>   publish a new core head
 *
 * Both sign with the agent key from Buzz Desktop's OS keyring (or
 * `--nsec-file`), exactly like `auth login/revoke`: the deploy tooling holds
 * the nsec by design, and the config channel is the agent's own self-encrypted
 * kind 30078 records. `publish` is the redeploy-free path for pushing a new
 * config version: the running agent's live subscription picks the head up and
 * reconfigures on the fly (app-runtime `#onCoreRecord`).
 *
 * `publish` verifies the write: after the relay OK it refetches the head and
 * requires it to be the event just published, surfacing a conflict (a
 * concurrent writer or a clock-poisoned prior head) instead of silently
 * losing the update.
 */

import { readFile } from "node:fs/promises";
import { CORE_SLUG, isCoreBody, PROVIDER_AUTH_SLUG, isTombstone } from "../nostr/config-records.js";
import { RecordClient } from "../nostr/record-client.js";
import { isPubkey } from "../nostr/signer.js";
import { systemClock } from "../runtime/clock.js";
import { parseCoreConfig } from "../runtime/remote-config.js";
import { connectAsAgent, resolveAgentSigner, resolveRelayUrl, type AgentFlags } from "./agent-relay.js";

export interface ConfigFlags extends AgentFlags {
  file?: string;
}

function requireAgent(flags: ConfigFlags, command: string): string | null {
  const agent = flags.agent;
  if (!agent || !isPubkey(agent)) {
    process.stderr.write(`config ${command} requires --agent <64-char hex pubkey>\n`);
    return null;
  }
  return agent;
}

export async function commandConfigShow(flags: ConfigFlags): Promise<number> {
  const agent = requireAgent(flags, "show");
  if (agent === null) return 2;
  const signer = await resolveAgentSigner(agent, flags);
  const relayUrl = resolveRelayUrl(flags);

  const relay = await connectAsAgent(signer, relayUrl);
  try {
    const records = new RecordClient({ relay, signer, clock: systemClock });

    const core = await records.fetchHead(CORE_SLUG);
    if (core && isCoreBody(core.body)) {
      process.stdout.write(
        `core head: created_at=${core.createdAt} event=${core.event.id}\n${core.body.profile}\n`,
      );
    } else {
      process.stdout.write("core head: (none) — the agent runs degraded until one is published\n");
    }

    // Presence only, never the credential bytes: this command may run in a
    // shell whose scrollback outlives the operator's intentions.
    const auth = await records.fetchHead(PROVIDER_AUTH_SLUG);
    if (auth === null) {
      process.stdout.write("provider-auth head: (none)\n");
    } else if (isTombstone(auth)) {
      process.stdout.write(`provider-auth head: tombstoned (created_at=${auth.createdAt})\n`);
    } else {
      process.stdout.write(`provider-auth head: present (created_at=${auth.createdAt})\n`);
    }
    return core ? 0 : 1;
  } finally {
    await relay.close();
  }
}

export async function commandConfigPublish(flags: ConfigFlags): Promise<number> {
  const agent = requireAgent(flags, "publish");
  if (agent === null) return 2;
  if (!flags.file) {
    process.stderr.write("config publish requires --file <core-config.json>\n");
    return 2;
  }

  let profile: string;
  try {
    profile = await readFile(flags.file, "utf8");
  } catch (error) {
    process.stderr.write(
      `cannot read ${flags.file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  // Validate before touching the network: publishing a document the agent
  // will reject only converts a local typo into a remote no-op.
  const parsed = parseCoreConfig(profile);
  if (!parsed.config) {
    for (const problem of parsed.problems) process.stderr.write(`invalid config: ${problem}\n`);
    return 2;
  }

  const signer = await resolveAgentSigner(agent, flags);
  const relayUrl = resolveRelayUrl(flags);

  const relay = await connectAsAgent(signer, relayUrl);
  try {
    const records = new RecordClient({ relay, signer, clock: systemClock });
    const head = await records.publish(CORE_SLUG, { slug: CORE_SLUG, profile });

    // Verify-after-write: the head we read back must be the event we wrote.
    const verified = await records.fetchHead(CORE_SLUG);
    if (verified === null || verified.event.id !== head.event.id) {
      process.stderr.write(
        `conflict: the relay's core head is ${verified ? verified.event.id : "absent"}, ` +
          `not the event just published (${head.event.id}) — retry after checking for a ` +
          `concurrent writer\n`,
      );
      return 1;
    }
    process.stdout.write(
      `Published core config for agent ${agent} (created_at=${head.createdAt}, event=${head.event.id})\n`,
    );
    return 0;
  } finally {
    await relay.close();
  }
}
