/**
 * Owner-side plumbing for acting *as* a remote agent over the relay.
 *
 * The owner's machine holds the agent nsec (Buzz Desktop's OS keyring, or an
 * explicit `--nsec-file`), which is what lets `auth login/revoke` and
 * `config show/publish` sign config records with the agent key. The NIP-OA
 * auth tag — required by the relay's NIP-42 handshake for agent membership —
 * is recovered from the agent's public kind 0 profile; it never touches the
 * record events themselves.
 */

import { readFile } from "node:fs/promises";
import { createEventBuilder } from "../nostr/event-builder.js";
import { extractAuthTag, type AuthTag } from "../nostr/nip-oa.js";
import { RelaySupervisor } from "../nostr/relay-supervisor.js";
import { createSigner, decodeSecretKey, type Signer } from "../nostr/signer.js";
import { KIND } from "../nostr/types.js";
import { systemClock } from "../runtime/clock.js";
import { nullLogger } from "../runtime/logger.js";
import { readAgentNsecFromKeyring } from "./keyring.js";

export interface AgentFlags {
  agent?: string;
  relay?: string;
  nsecFile?: string;
}

export async function resolveAgentSigner(agentPubkey: string, flags: AgentFlags): Promise<Signer> {
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

export function resolveRelayUrl(flags: AgentFlags): string {
  const url =
    flags.relay ?? process.env["AUTOGENT_RELAY_URL"] ?? process.env["BUZZ_RELAY_URL"] ?? null;
  if (url === null || !/^wss?:\/\//.test(url)) {
    throw new Error("relay URL required: pass --relay wss://… or set AUTOGENT_RELAY_URL");
  }
  return url;
}

/**
 * Opens an authenticated relay connection as the agent.
 *
 * A first, unauthenticated-identity probe recovers the NIP-OA auth tag from
 * the agent's kind 0 profile; the real connection then authenticates with it
 * (the relay gates agent membership on the attestation at NIP-42 time).
 * The caller owns the returned supervisor and must `close()` it.
 */
export async function connectAsAgent(signer: Signer, relayUrl: string): Promise<RelaySupervisor> {
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
    const profiles = await probe.query([
      { kinds: [KIND.METADATA], authors: [signer.publicKey], limit: 1 },
    ]);
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
  await relay.connect();
  return relay;
}
