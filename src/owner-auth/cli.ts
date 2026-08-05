/**
 * `autogent-nostr auth` — owner-side provider credentials (remote plan §7).
 *
 *   auth login  --agent <pubkey>   OAuth flow → per-agent auth.json → engram
 *   auth status [--agent <pubkey>] bindings and token freshness
 *   auth revoke --agent <pubkey>   tombstone the engram, drop the binding
 *
 * The OAuth flow itself is pi's (`ModelRuntime.login`), pointed at a per-agent
 * `authPath` so the credential lands in exactly the file shape the remote
 * harness materialises from the engram. The engram is signed with the agent's
 * key from Buzz Desktop's OS keyring; the NIP-OA auth tag is recovered from
 * the agent's published kind 0 profile on the relay.
 */

import { readFile } from "node:fs/promises";
import { EngramClient } from "../nostr/engram-client.js";
import { createEventBuilder } from "../nostr/event-builder.js";
import { PROVIDER_AUTH_SLUG } from "../nostr/nip-ae.js";
import { extractAuthTag, type AuthTag } from "../nostr/nip-oa.js";
import { RelaySupervisor } from "../nostr/relay-supervisor.js";
import { createSigner, decodeSecretKey, isPubkey, type Signer } from "../nostr/signer.js";
import { KIND } from "../nostr/types.js";
import { systemClock } from "../runtime/clock.js";
import { nullLogger } from "../runtime/logger.js";
import { readAgentNsecFromKeyring } from "./keyring.js";
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

/* -------------------------------------------------------------------------- */
/* Agent identity plumbing                                                    */
/* -------------------------------------------------------------------------- */

async function resolveAgentSigner(agentPubkey: string, flags: AuthFlags): Promise<Signer> {
  let nsec: string | null = null;
  if (flags.nsecFile) {
    nsec = (await readFile(flags.nsecFile, "utf8")).trim();
  } else {
    nsec = await readAgentNsecFromKeyring(agentPubkey);
  }
  if (nsec === null) {
    throw new Error(
      `agent key not found in the OS keyring (service buzz-desktop, account agent:${agentPubkey}). ` +
        `If the agent was not created by Buzz Desktop on this machine, pass --nsec-file <path>.`,
    );
  }
  const signer = createSigner(decodeSecretKey(nsec));
  if (signer.publicKey !== agentPubkey) {
    throw new Error(
      `the key resolved for --agent derives pubkey ${signer.publicKey}, not ${agentPubkey} — refusing`,
    );
  }
  return signer;
}

function resolveRelayUrl(flags: AuthFlags): string {
  const url =
    flags.relay ?? process.env["AUTOGENT_RELAY_URL"] ?? process.env["BUZZ_RELAY_URL"] ?? null;
  if (url === null || !/^wss?:\/\//.test(url)) {
    throw new Error("relay URL required: pass --relay wss://… or set AUTOGENT_RELAY_URL");
  }
  return url;
}

/**
 * Publishes (or tombstones) the provider-auth engram as the agent.
 *
 * The NIP-OA auth tag comes off the agent's own kind 0 profile: it is public,
 * relay-verified, and the one artifact that must exist for any provisioned
 * agent.
 */
async function publishAuthEngram(
  signer: Signer,
  relayUrl: string,
  value: string | null,
): Promise<void> {
  const probe = new RelaySupervisor({
    url: relayUrl,
    // The metadata query needs no NIP-OA identity of ours; a plain builder
    // would not authenticate as the agent though, so the real builder below
    // re-connects once the tag is known.
    builder: {
      build: (draft) =>
        signer.sign({
          pubkey: signer.publicKey,
          created_at: draft.created_at ?? Math.floor(Date.now() / 1000),
          kind: draft.kind,
          tags: draft.tags,
          content: draft.content,
        }),
    },
    clock: systemClock,
    logger: nullLogger,
  });

  let authTag: AuthTag | null = null;
  try {
    await probe.connect();
    const profiles = await probe.query([{ kinds: [KIND.METADATA], authors: [signer.publicKey], limit: 1 }]);
    authTag = profiles[0] ? extractAuthTag(profiles[0].tags) : null;
  } finally {
    await probe.close();
  }
  if (!authTag) {
    throw new Error(
      "could not recover the agent's NIP-OA auth tag from its kind 0 profile — has the agent " +
        "ever been provisioned on this relay?",
    );
  }

  const builder = createEventBuilder({ signer, authTag, clock: systemClock });
  const relay = new RelaySupervisor({ url: relayUrl, builder, clock: systemClock, logger: nullLogger });
  try {
    await relay.connect();
    const engrams = new EngramClient({ relay, signer, builder, clock: systemClock });
    await engrams.publish(PROVIDER_AUTH_SLUG, { slug: PROVIDER_AUTH_SLUG, value });
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
    await publishAuthEngram(signer, relayUrl, authJson);
    process.stdout.write(`Published mem/provider-auth for agent ${agent}\n`);
  } catch (error) {
    process.stderr.write(
      `credential stored locally, but the engram publish failed: ` +
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
  await publishAuthEngram(signer, relayUrl, null);
  const removed = await removeBinding(agent);
  process.stdout.write(
    `Tombstoned mem/provider-auth for ${agent}` +
      (removed ? " and removed the local binding\n" : " (no local binding was recorded)\n"),
  );
  return 0;
}
