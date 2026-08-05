/**
 * `autogent-nostr auth` — owner-side provider credentials (remote plan §7).
 *
 *   auth login  --agent <pubkey> [--provider <id>] [--type oauth|api_key]
 *               login flow → per-agent auth.json → config record
 *   auth status [--agent <pubkey>] bindings and token freshness
 *   auth revoke --agent <pubkey>   tombstone the record, drop the bindings
 *
 * The login flow itself is pi's (`ModelRuntime.login`) — any provider pi
 * supports, OAuth or API key — pointed at a per-agent
 * `authPath` so the credential lands in exactly the file shape the remote
 * harness materialises from the record. The record is signed with the agent's
 * key from Buzz Desktop's OS keyring; the NIP-OA auth tag is recovered from
 * the agent's published kind 0 profile on the relay and is used only for the
 * NIP-42 connection handshake — the record event itself carries no auth tag.
 */

import { RecordClient } from "../nostr/record-client.js";
import { AUTH_SLUG } from "../nostr/config-records.js";
import { isPubkey, type Signer } from "../nostr/signer.js";
import { systemClock } from "../runtime/clock.js";
import { authValueFromContent } from "../runtime/provider-auth.js";
import { connectAsAgent, resolveAgentSigner, resolveRelayUrl } from "./agent-relay.js";
import { createInterface } from "node:readline/promises";
import { listLoginChoices, runProviderLogin, type LoginChoice } from "./oauth.js";
import {
  agentAuthPath,
  ensureAgentAuthDir,
  readAgentAuth,
  readBindings,
  recordBinding,
  removeBinding,
} from "./store.js";

interface AuthFlags {
  agent?: string;
  relay?: string;
  nsecFile?: string;
  /** Provider id, e.g. `anthropic`, `openai-codex`, `google`. */
  provider?: string;
  /** Auth type when a provider supports both: `oauth` or `api_key`. */
  type?: string;
}

/**
 * Resolves the provider/auth-type pair to log in with: `--provider` (and
 * `--type` when the provider supports both) when given, an interactive
 * numbered list otherwise.
 */
async function resolveLoginChoice(
  choices: LoginChoice[],
  flags: AuthFlags,
): Promise<LoginChoice | null> {
  if (flags.provider !== undefined) {
    const matches = choices.filter((choice) => choice.providerId === flags.provider);
    if (matches.length === 0) {
      process.stderr.write(
        `unknown or non-interactive provider ${JSON.stringify(flags.provider)}; available:\n` +
          choices.map((choice) => `  ${choice.providerId} (${choice.type})\n`).join(""),
      );
      return null;
    }
    if (flags.type !== undefined) {
      const byType = matches.find((choice) => choice.type === flags.type);
      if (!byType) {
        process.stderr.write(
          `provider ${flags.provider} does not support --type ${flags.type}; ` +
            `available: ${matches.map((choice) => choice.type).join(", ")}\n`,
        );
        return null;
      }
      return byType;
    }
    // Prefer OAuth when both are available — the subscription flow is the default.
    return matches.find((choice) => choice.type === "oauth") ?? matches[0] ?? null;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    choices.forEach((choice, index) => {
      process.stdout.write(`  ${index + 1}. ${choice.label}  [${choice.providerId}, ${choice.type}]\n`);
    });
    const answer = (await rl.question("Select a provider (number): ")).trim();
    const choice = choices[Number(answer) - 1];
    if (!choice) {
      process.stderr.write(`invalid selection ${JSON.stringify(answer)}\n`);
      return null;
    }
    return choice;
  } finally {
    rl.close();
  }
}

/**
 * Publishes (or tombstones) the provider-auth record as the agent.
 *
 * The NIP-OA auth tag (recovered from the agent's kind 0 profile inside
 * `connectAsAgent`) authenticates the relay connection; the record itself is
 * a plain self-signed kind 30078 event.
 */
async function publishAuthRecord(
  signer: Signer,
  relayUrl: string,
  value: Record<string, unknown> | null,
): Promise<void> {
  const relay = await connectAsAgent(signer, relayUrl);
  try {
    const records = new RecordClient({ relay, signer, clock: systemClock });
    await records.publish(AUTH_SLUG, { slug: AUTH_SLUG, value });
  } finally {
    await relay.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export async function commandAuthLogin(flags: AuthFlags): Promise<number> {
  const agent = flags.agent;
  if (!agent || !isPubkey(agent)) {
    process.stderr.write("auth login requires --agent <64-char hex pubkey>\n");
    return 2;
  }

  // Resolve the signing key *before* the OAuth dance: failing after the user
  // has clicked through the browser flow is gratuitous.
  const signer = await resolveAgentSigner(agent, flags);
  const relayUrl = resolveRelayUrl(flags);

  const authPath = await ensureAgentAuthDir(agent);
  const choices = await listLoginChoices(authPath);
  const choice = await resolveLoginChoice(choices, flags);
  if (choice === null) return 2;
  await runProviderLogin(authPath, choice.providerId, choice.type);

  const authJson = await readAgentAuth(agent);
  if (authJson === null) {
    process.stderr.write("login flow completed but no credential was stored — aborting\n");
    return 1;
  }

  const binding = await recordBinding(agent, authJson);
  if (!binding.ok) {
    process.stderr.write(
      `the ${binding.conflict.providerId} account is already bound to agent ` +
        `${binding.conflict.agentPubkey} — one account drives exactly one agent ` +
        `(remote plan §1.5). Use a different account.\n`,
    );
    return 2;
  }

  try {
    const value = authValueFromContent(authJson);
    if (value === null) {
      process.stderr.write("the stored credential is not a JSON object — aborting\n");
      return 1;
    }
    await publishAuthRecord(signer, relayUrl, value);
    process.stdout.write(`Published autogent/auth for agent ${agent}\n`);
  } catch (error) {
    process.stderr.write(
      `credential stored locally, but the record publish failed: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `The next deploy will publish it.\n`,
    );
  }
  return 0;
}

function providerStatus(credential: { type?: string; expires?: number } | undefined): string {
  if (credential === undefined) return "no credential stored";
  if (credential.type === "api_key") return "API key stored";
  const expires = credential.expires;
  if (typeof expires !== "number") return "credential present";
  return expires > Date.now()
    ? `access token valid until ${new Date(expires).toISOString()}`
    : "access token expired (refresh on next use)";
}

export async function commandAuthStatus(flags: AuthFlags): Promise<number> {
  const bindings = (await readBindings()).bindings.filter(
    (binding) => !flags.agent || binding.agentPubkey === flags.agent,
  );
  if (bindings.length === 0) {
    process.stdout.write("no agents have provider credentials bound on this machine\n");
    return 0;
  }
  const byAgent = new Map<string, typeof bindings>();
  for (const binding of bindings) {
    byAgent.set(binding.agentPubkey, [...(byAgent.get(binding.agentPubkey) ?? []), binding]);
  }
  for (const [agentPubkey, agentBindings] of byAgent) {
    const authJson = await readAgentAuth(agentPubkey);
    let credentials: Record<string, { type?: string; expires?: number }> = {};
    let fileNote = "no credential file";
    if (authJson !== null) {
      try {
        credentials = JSON.parse(authJson) as typeof credentials;
        fileNote = agentAuthPath(agentPubkey);
      } catch {
        fileNote = "credential file unreadable";
      }
    }
    process.stdout.write(`${agentPubkey}\n`);
    for (const binding of agentBindings) {
      process.stdout.write(
        `  provider: ${binding.providerId}\n` +
          `    bound:  ${new Date(binding.createdAt).toISOString()}\n` +
          `    status: ${providerStatus(credentials[binding.providerId])}\n`,
      );
    }
    process.stdout.write(`  file:     ${fileNote}\n`);
  }
  return 0;
}

export async function commandAuthRevoke(flags: AuthFlags): Promise<number> {
  const agent = flags.agent;
  if (!agent || !isPubkey(agent)) {
    process.stderr.write("auth revoke requires --agent <64-char hex pubkey>\n");
    return 2;
  }

  const signer = await resolveAgentSigner(agent, flags);
  const relayUrl = resolveRelayUrl(flags);
  await publishAuthRecord(signer, relayUrl, null);
  const removed = await removeBinding(agent);
  process.stdout.write(
    `Tombstoned autogent/auth for ${agent}` +
      (removed ? " and removed the local binding\n" : " (no local binding was recorded)\n"),
  );
  return 0;
}
