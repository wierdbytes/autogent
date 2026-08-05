/**
 * `autogent-nostr auth` — owner-side provider credentials (remote plan §7).
 *
 *   auth login  --agent <pubkey>   OAuth flow → per-agent auth.json → config record
 *   auth status [--agent <pubkey>] bindings and token freshness
 *   auth revoke --agent <pubkey>   tombstone the record, drop the binding
 *
 * The OAuth flow itself is pi's (`ModelRuntime.login`), pointed at a per-agent
 * `authPath` so the credential lands in exactly the file shape the remote
 * harness materialises from the record. The record is signed with the agent's
 * key from Buzz Desktop's OS keyring; the NIP-OA auth tag is recovered from
 * the agent's published kind 0 profile on the relay and is used only for the
 * NIP-42 connection handshake — the record event itself carries no auth tag.
 */

import { RecordClient } from "../nostr/record-client.js";
import { PROVIDER_AUTH_SLUG } from "../nostr/config-records.js";
import { isPubkey, type Signer } from "../nostr/signer.js";
import { systemClock } from "../runtime/clock.js";
import { connectAsAgent, resolveAgentSigner, resolveRelayUrl } from "./agent-relay.js";
import { runOAuthLogin } from "./oauth.js";
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
  value: string | null,
): Promise<void> {
  const relay = await connectAsAgent(signer, relayUrl);
  try {
    const records = new RecordClient({ relay, signer, clock: systemClock });
    await records.publish(PROVIDER_AUTH_SLUG, { slug: PROVIDER_AUTH_SLUG, value });
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
  await runOAuthLogin(authPath);

  const authJson = await readAgentAuth(agent);
  if (authJson === null) {
    process.stderr.write("OAuth flow completed but no credential was stored — aborting\n");
    return 1;
  }

  const binding = await recordBinding(agent, authJson);
  if (!binding.ok) {
    process.stderr.write(
      `this OAuth account is already bound to agent ${binding.conflict.agentPubkey} — ` +
        `one account drives exactly one agent (remote plan §1.5). Use a different account.\n`,
    );
    return 2;
  }

  try {
    await publishAuthRecord(signer, relayUrl, authJson);
    process.stdout.write(`Published mem/provider-auth for agent ${agent}\n`);
  } catch (error) {
    process.stderr.write(
      `credential stored locally, but the record publish failed: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `The next deploy will publish it.\n`,
    );
  }
  return 0;
}

export async function commandAuthStatus(flags: AuthFlags): Promise<number> {
  const bindings = (await readBindings()).bindings.filter(
    (binding) => !flags.agent || binding.agentPubkey === flags.agent,
  );
  if (bindings.length === 0) {
    process.stdout.write("no agents have provider credentials bound on this machine\n");
    return 0;
  }
  for (const binding of bindings) {
    const authJson = await readAgentAuth(binding.agentPubkey);
    let expiry = "no credential file";
    if (authJson !== null) {
      try {
        const parsed = JSON.parse(authJson) as Record<string, { expires?: number }>;
        const expires = parsed["anthropic"]?.expires;
        expiry =
          typeof expires === "number"
            ? expires > Date.now()
              ? `access token valid until ${new Date(expires).toISOString()}`
              : "access token expired (refresh on next use)"
            : "credential present";
      } catch {
        expiry = "credential unreadable";
      }
    }
    process.stdout.write(
      `${binding.agentPubkey}\n  provider: ${binding.providerId}\n  bound:    ${new Date(binding.createdAt).toISOString()}\n  status:   ${expiry}\n  file:     ${agentAuthPath(binding.agentPubkey)}\n`,
    );
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
    `Tombstoned mem/provider-auth for ${agent}` +
      (removed ? " and removed the local binding\n" : " (no local binding was recorded)\n"),
  );
  return 0;
}
