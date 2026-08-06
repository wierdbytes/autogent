/**
 * `autogent-nostr langfuse set|revoke|status` — owner-side Langfuse API keys
 * (tracing plan §5.2, §9 step 4).
 *
 *   langfuse set    --agent <pubkey> [--public-key <pk-lf-...>] [--secret-key <sk-lf-...>]
 *                    publish (or replace) the autogent/langfuse config record
 *   langfuse status [--agent <pubkey>]
 *                    print whether keys are set, tombstoned, or absent
 *   langfuse revoke --agent <pubkey>
 *                    tombstone the record: the running agent turns tracing off live
 *
 * Same shape as `auth login/revoke` (`owner-auth/cli.ts`): the record is
 * signed with the agent's own key (`resolveAgentSigner`, Buzz Desktop's OS
 * keyring or `--nsec-file`), over an authenticated agent connection
 * (`connectAsAgent`), and carries no owner linkage. Unlike provider auth,
 * Langfuse keys never touch pi's `auth.json` — they live only in this
 * dedicated record (`LANGFUSE_SLUG`), read by the runtime's credential
 * resolver (tracing plan §5.2) and never by pi itself.
 */

import { createInterface } from "node:readline/promises";
import { LANGFUSE_SLUG } from "../nostr/config-records.js";
import { RecordClient } from "../nostr/record-client.js";
import { isPubkey } from "../nostr/signer.js";
import { systemClock } from "../runtime/clock.js";
import { connectAsAgent, resolveAgentSigner, resolveRelayUrl, type AgentFlags } from "./agent-relay.js";

export interface LangfuseFlags extends AgentFlags {
  publicKey?: string;
  secretKey?: string;
}

/** Shape carried in the record body's `value` — public key readable, secret key not. */
interface LangfuseKeys {
  public_key: string;
  secret_key: string;
}

function requireAgent(flags: LangfuseFlags, command: string): string | null {
  const agent = flags.agent;
  if (!agent || !isPubkey(agent)) {
    process.stderr.write(`langfuse ${command} requires --agent <64-char hex pubkey>\n`);
    return null;
  }
  return agent;
}

/**
 * Shape warnings for a Langfuse key pair. Standard Langfuse public/secret
 * keys are prefixed `pk-lf-`/`sk-lf-`; self-hosted deployments could in
 * principle mint different-looking keys, so a mismatch is a warning, never a
 * rejection — we still publish what the operator gave us.
 */
export function checkLangfuseKeyShape(publicKey: string, secretKey: string): string[] {
  const warnings: string[] = [];
  if (!publicKey.startsWith("pk-lf-")) {
    warnings.push(`public key does not start with "pk-lf-" — double-check it is the public key, not the secret`);
  }
  if (!secretKey.startsWith("sk-lf-")) {
    warnings.push(`secret key does not start with "sk-lf-" — double-check it is the secret key, not the public`);
  }
  return warnings;
}

/**
 * Resolves the key pair to publish: `--public-key`/`--secret-key` when both
 * are given, an interactive prompt otherwise (plain `question`, like the
 * provider picker in `auth login` — Langfuse keys are not secrets that need
 * a masked prompt in the same way an owner nsec does, and the operator
 * already sees them in the Langfuse dashboard).
 */
async function resolveLangfuseKeys(flags: LangfuseFlags): Promise<LangfuseKeys | null> {
  if (flags.publicKey !== undefined && flags.secretKey !== undefined) {
    return { public_key: flags.publicKey, secret_key: flags.secretKey };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const publicKey = flags.publicKey ?? (await rl.question("Langfuse public key (pk-lf-...): ")).trim();
    const secretKey = flags.secretKey ?? (await rl.question("Langfuse secret key (sk-lf-...): ")).trim();
    if (!publicKey || !secretKey) {
      process.stderr.write("both a public key and a secret key are required\n");
      return null;
    }
    return { public_key: publicKey, secret_key: secretKey };
  } finally {
    rl.close();
  }
}

export async function commandLangfuseSet(flags: LangfuseFlags): Promise<number> {
  const agent = requireAgent(flags, "set");
  if (agent === null) return 2;

  const keys = await resolveLangfuseKeys(flags);
  if (keys === null) return 2;

  for (const warning of checkLangfuseKeyShape(keys.public_key, keys.secret_key)) {
    process.stderr.write(`warning: ${warning}\n`);
  }

  const signer = await resolveAgentSigner(agent, flags);
  const relayUrl = resolveRelayUrl(flags);

  const relay = await connectAsAgent(signer, relayUrl);
  try {
    const records = new RecordClient({ relay, signer, clock: systemClock });
    // Never echo the keys back — the log/scrollback of this shell may outlive
    // the operator's intentions.
    const head = await records.publish(LANGFUSE_SLUG, { slug: LANGFUSE_SLUG, value: keys });
    process.stdout.write(
      `Published autogent/langfuse for agent ${agent} (created_at=${head.createdAt}, ` +
        `public_key=${keys.public_key})\n`,
    );
    return 0;
  } finally {
    await relay.close();
  }
}

export async function commandLangfuseRevoke(flags: LangfuseFlags): Promise<number> {
  const agent = requireAgent(flags, "revoke");
  if (agent === null) return 2;

  const signer = await resolveAgentSigner(agent, flags);
  const relayUrl = resolveRelayUrl(flags);

  const relay = await connectAsAgent(signer, relayUrl);
  try {
    const records = new RecordClient({ relay, signer, clock: systemClock });
    const head = await records.publish(LANGFUSE_SLUG, { slug: LANGFUSE_SLUG, value: null });
    process.stdout.write(
      `Tombstoned autogent/langfuse for agent ${agent} (created_at=${head.createdAt}) — ` +
        `tracing turns off live, the agent keeps running\n`,
    );
    return 0;
  } finally {
    await relay.close();
  }
}

export async function commandLangfuseStatus(flags: LangfuseFlags): Promise<number> {
  const agent = requireAgent(flags, "status");
  if (agent === null) return 2;

  const signer = await resolveAgentSigner(agent, flags);
  const relayUrl = resolveRelayUrl(flags);

  const relay = await connectAsAgent(signer, relayUrl);
  try {
    const records = new RecordClient({ relay, signer, clock: systemClock });
    const head = await records.fetchHead(LANGFUSE_SLUG);
    if (head === null) {
      process.stdout.write(`langfuse head: (none) — no keys have ever been published for ${agent}\n`);
      return 1;
    }
    if (head.body.value === null) {
      process.stdout.write(
        `langfuse head: tombstoned (created_at=${head.createdAt}) — tracing is off for ${agent}\n`,
      );
      return 1;
    }
    const value = head.body.value as Partial<LangfuseKeys>;
    const publicKey = typeof value.public_key === "string" ? value.public_key : "(malformed)";
    process.stdout.write(
      `langfuse head: set (created_at=${head.createdAt})\n` +
        `  public_key: ${publicKey}\n` +
        `  secret_key: sk-lf-***\n`,
    );
    return 0;
  } finally {
    await relay.close();
  }
}
