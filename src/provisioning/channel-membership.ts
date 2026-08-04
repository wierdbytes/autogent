/**
 * Owner-side channel membership changes (plan §3, boundary 2).
 *
 * An agent cannot add itself to a channel — that needs an admin or owner
 * signature, and the owner key never reaches the agent host. This module is the
 * owner's half: it runs on their machine, signs a NIP-29 membership event with
 * their key, and publishes it.
 *
 * Buzz Desktop cannot do this for an externally-hosted agent. Its add-members
 * dialog filters out any agent that is not in the Desktop's own managed list
 * (`desktop/src/features/agents/lib/agentAutocompleteEligibility.ts`), so a
 * standalone agent is invisible there regardless of what it publishes.
 *
 * Event shape mirrors `build_add_member` / `build_remove_member` in
 * `crates/buzz-sdk/src/builders.rs`.
 */

import { createSigner, isPubkey, type Signer } from "../nostr/signer.js";
import { createPlainEventBuilder } from "../nostr/event-builder.js";
import { RelaySupervisor } from "../nostr/relay-supervisor.js";
import { KIND, type NostrEvent, type NostrTag } from "../nostr/types.js";
import { systemClock } from "../runtime/clock.js";
import { nullLogger } from "../runtime/logger.js";
import type { Clock, Logger, RelayPort } from "../runtime/ports.js";
import { ProvisioningError } from "./identity-store.js";
import { readOwnerSecret, type OwnerSecretSource } from "./owner-secret.js";

/** Roles the relay accepts on a membership event. */
export const MEMBER_ROLES = ["owner", "admin", "member", "guest", "bot"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChannelId(value: string): boolean {
  return UUID_RE.test(value);
}

export function isMemberRole(value: string): value is MemberRole {
  return (MEMBER_ROLES as readonly string[]).includes(value);
}

export interface MembershipChange {
  channelId: string;
  memberPubkey: string;
  /** Omitted on removal; defaults to `bot` when adding an agent. */
  role?: MemberRole;
}

function validate(change: MembershipChange): void {
  if (!isChannelId(change.channelId)) {
    throw new ProvisioningError(
      "invalid-args",
      `channel must be a UUID, got '${change.channelId}'`,
    );
  }
  // Case-insensitive, matching `build_add_member`, which lowercases rather than
  // rejecting: a key pasted from a UI that renders uppercase hex is still valid.
  if (!isPubkey(change.memberPubkey.toLowerCase())) {
    throw new ProvisioningError("invalid-args", "member pubkey must be 64-char hex");
  }
  if (change.role !== undefined && !isMemberRole(change.role)) {
    throw new ProvisioningError(
      "invalid-args",
      `role must be one of ${MEMBER_ROLES.join(", ")}`,
    );
  }
}

/** Kind 9000. The relay applies it and notifies the member with kind 44100. */
export function buildAddMemberEvent(
  signer: Signer,
  change: MembershipChange,
  createdAt: number,
): NostrEvent {
  validate(change);
  const tags: NostrTag[] = [
    ["h", change.channelId],
    ["p", change.memberPubkey.toLowerCase()],
  ];
  if (change.role) tags.push(["role", change.role]);
  return signer.sign({
    pubkey: signer.publicKey,
    created_at: createdAt,
    kind: KIND.MEMBER_ADD,
    tags,
    content: "",
  });
}

/** Kind 9001. The relay applies it and notifies the member with kind 44101. */
export function buildRemoveMemberEvent(
  signer: Signer,
  change: MembershipChange,
  createdAt: number,
): NostrEvent {
  validate({ ...change, role: undefined });
  return signer.sign({
    pubkey: signer.publicKey,
    created_at: createdAt,
    kind: KIND.MEMBER_REMOVE,
    tags: [
      ["h", change.channelId],
      ["p", change.memberPubkey.toLowerCase()],
    ],
    content: "",
  });
}

export interface ApplyMembershipOptions extends MembershipChange {
  relayUrl: string;
  ownerSecret: OwnerSecretSource;
  action: "add" | "remove";
  clock?: Clock;
  logger?: Logger;
  /** Injected by tests; production opens a real supervised connection. */
  relay?: RelayPort;
  readSecretLine?: (promptText: string) => Promise<string>;
}

export interface ApplyMembershipResult {
  eventId: string;
  ownerPubkey: string;
  channelId: string;
  memberPubkey: string;
  role: MemberRole | null;
}

/**
 * Signs and publishes a membership change as the owner.
 *
 * The secret stays resident for the whole call rather than being zeroed right
 * after signing: the relay demands NIP-42, and that handshake needs the same
 * owner key. It is zeroed in `finally`, once the connection is closed.
 */
export async function applyMembership(
  options: ApplyMembershipOptions,
): Promise<ApplyMembershipResult> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? nullLogger;
  const change: MembershipChange = {
    channelId: options.channelId,
    memberPubkey: options.memberPubkey,
    role: options.role,
  };
  validate(change);

  const secret = await readOwnerSecret(options.ownerSecret, options.readSecretLine);
  const signer = createSigner(secret);
  const ownerPubkey = signer.publicKey;

  try {
    if (ownerPubkey === change.memberPubkey.toLowerCase()) {
      throw new ProvisioningError("invalid-args", "owner and member must be different keys");
    }

    const createdAt = Math.floor(clock.now() / 1000);
    const event =
      options.action === "add"
        ? buildAddMemberEvent(signer, change, createdAt)
        : buildRemoveMemberEvent(signer, change, createdAt);

    const ownedRelay = options.relay === undefined;
    const relay =
      options.relay ??
      new RelaySupervisor({
        url: options.relayUrl,
        // The owner acts under their own key, so the NIP-42 event carries no
        // NIP-OA tag — attaching one would misstate who authorised it.
        builder: createPlainEventBuilder({ signer, clock }),
        clock,
        logger,
      });

    try {
      await relay.connect();
      const result = await relay.publish(event);
      if (!result.ok) {
        throw new ProvisioningError(
          "publish-rejected",
          `relay rejected the membership event: ${result.message}`,
        );
      }
    } finally {
      if (ownedRelay) await relay.close().catch(() => {});
    }

    return {
      eventId: event.id,
      ownerPubkey,
      channelId: change.channelId,
      memberPubkey: change.memberPubkey.toLowerCase(),
      role: change.role ?? null,
    };
  } finally {
    secret.fill(0);
  }
}
