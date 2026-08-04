import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createEventBuilder, type AgentEventBuilder } from "../../src/nostr/event-builder.js";
import { signAttestation, type AuthTag } from "../../src/nostr/nip-oa.js";
import { createSigner, type Signer } from "../../src/nostr/signer.js";
import type { Clock } from "../../src/runtime/ports.js";
import { KIND, type NostrEvent, type NostrTag } from "../../src/nostr/types.js";

export interface TestIdentity {
  signer: Signer;
  agentPubkey: string;
  ownerSecret: Uint8Array;
  ownerPubkey: string;
  authTag: AuthTag;
  builder: AgentEventBuilder;
}

/** An agent keypair with a fresh owner attestation over `conditions`. */
export function createTestIdentity(clock: Clock, conditions = ""): TestIdentity {
  const signer = createSigner(generateSecretKey());
  const ownerSecret = generateSecretKey();
  const authTag = signAttestation(ownerSecret, signer.publicKey, conditions);
  return {
    signer,
    agentPubkey: signer.publicKey,
    ownerSecret,
    ownerPubkey: getPublicKey(ownerSecret),
    authTag,
    builder: createEventBuilder({ signer, authTag, clock }),
  };
}

/** A third-party identity: a human in a channel, or another agent. */
export function createPeer(): { signer: Signer; pubkey: string } {
  const signer = createSigner(generateSecretKey());
  return { signer, pubkey: signer.publicKey };
}

export function makeEvent(
  signer: Signer,
  draft: { kind: number; tags?: NostrTag[]; content?: string; created_at: number },
): NostrEvent {
  return signer.sign({
    pubkey: signer.publicKey,
    kind: draft.kind,
    tags: draft.tags ?? [],
    content: draft.content ?? "",
    created_at: draft.created_at,
  });
}

export function makeChatEvent(
  signer: Signer,
  params: { channelId: string; mention?: string; content?: string; created_at: number },
): NostrEvent {
  const tags: NostrTag[] = [["h", params.channelId]];
  if (params.mention !== undefined) tags.push(["p", params.mention]);
  return makeEvent(signer, {
    kind: KIND.CHAT,
    tags,
    content: params.content ?? "hello",
    created_at: params.created_at,
  });
}

export function makeChannelMetadata(
  signer: Signer,
  params: {
    channelId: string;
    name?: string;
    markers?: NostrTag[];
    created_at: number;
  },
): NostrEvent {
  const tags: NostrTag[] = [["d", params.channelId]];
  if (params.name !== undefined) tags.push(["name", params.name]);
  tags.push(...(params.markers ?? []));
  return makeEvent(signer, {
    kind: KIND.CHANNEL_METADATA,
    tags,
    created_at: params.created_at,
  });
}

export function makeMembership(
  signer: Signer,
  params: { channelId: string; agentPubkey: string; created_at: number },
): NostrEvent {
  return makeEvent(signer, {
    kind: KIND.CHANNEL_MEMBER,
    tags: [
      ["d", params.channelId],
      ["p", params.agentPubkey],
    ],
    created_at: params.created_at,
  });
}

export function makeMembershipNotice(
  signer: Signer,
  params: { kind: number; channelId: string; agentPubkey: string; created_at: number },
): NostrEvent {
  return makeEvent(signer, {
    kind: params.kind,
    tags: [
      ["p", params.agentPubkey],
      ["h", params.channelId],
    ],
    created_at: params.created_at,
  });
}
