/**
 * Core Nostr wire types and the Buzz kind registry.
 *
 * This module is the single source of truth for event/tag shapes used by the
 * standalone agent. It deliberately contains no I/O so it can be imported by
 * fixtures and tests without pulling in a relay or the Pi SDK.
 */

/** A raw Nostr tag: an ordered array of strings, first element is the tag name. */
export type NostrTag = string[];

/** An unsigned Nostr event, before id/sig computation (NIP-01). */
export interface UnsignedNostrEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: NostrTag[];
  content: string;
}

/** A fully signed Nostr event (NIP-01). */
export interface NostrEvent extends UnsignedNostrEvent {
  id: string;
  sig: string;
}

/** A relay subscription filter (NIP-01). Tag filters use the `#<letter>` form. */
export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  /** NIP-50 full-text query; results come back relevance-sorted. */
  search?: string;
  [tagFilter: `#${string}`]: string[] | undefined | number | number[] | string;
}

/* -------------------------------------------------------------------------- */
/* Kind registry                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every Nostr kind this service reads or writes.
 *
 * Sourced from the Buzz protocol; see docs/plans/20260803-standalone-nostr-agent.md
 * §6 and the NIP-OA / NIP-AO / NIP-AM specs in the Buzz repository.
 */
export const KIND = {
  /** NIP-01 profile metadata. Carries the NIP-OA owner attestation tag. */
  METADATA: 0,
  /** NIP-C7 chat message. The agent's read and write surface for conversation. */
  CHAT: 9,
  /**
   * Buzz agent profile (replaceable, authored by the agent itself).
   *
   * Buzz Desktop's `list_relay_agents` command queries `{kinds:[10100]}` and
   * builds its relay-agent roster from these events. Publishing kind 0 alone is
   * NOT enough to be discovered — see docs/plans/20260803-standalone-nostr-agent.md
   * §8.1 and the deviation note in README.
   */
  AGENT_PROFILE: 10100,
  /**
   * NIP-29 add-member command, signed by a channel owner or admin.
   *
   * The agent never publishes this — it cannot authorise its own membership.
   * It is built owner-side by `autogent-nostr channel add`.
   */
  MEMBER_ADD: 9000,
  /** NIP-29 remove-member command, signed by a channel owner or admin. */
  MEMBER_REMOVE: 9001,
  /** NIP-42 client authentication event. */
  CLIENT_AUTH: 22242,
  /** Buzz agent presence (ephemeral). */
  PRESENCE: 20001,
  /** NIP-AO observability frame (ephemeral, NIP-44 encrypted agent<->owner). */
  OBSERVER: 24200,
  /** Scheduled channel reminder. Read like a chat message. */
  STREAM_REMINDER: 40007,
  /** Workflow approval request. Read like a chat message. */
  WORKFLOW_APPROVAL_REQUESTED: 46010,
  /** Buzz channel metadata (addressable). */
  CHANNEL_METADATA: 39000,
  /** Buzz channel membership (addressable). */
  CHANNEL_MEMBER: 39002,
  /** Membership granted notification. */
  MEMBERSHIP_ADDED: 44100,
  /** Membership revoked notification. */
  MEMBERSHIP_REMOVED: 44101,
  /** NIP-AM usage metrics (durable, NIP-44 encrypted agent->owner). */
  USAGE_METRIC: 44200,
  /**
   * NIP-78 application-specific data (parameterised replaceable).
   *
   * Carries the agent's own config records: the `autogent/config` record and
   * the `autogent/auth` credentials record, self-signed and NIP-44
   * self-encrypted (d-tags are HMAC-derived, see nostr/config-records.ts).
   * The Buzz relay accepts this kind with the same `UsersWrite` scope as
   * profiles; NIP-RS read-state shares the kind but is keyed by
   * `read-state:<slot>` d-tags and cannot collide with the HMAC d-tags here.
   */
  APP_DATA: 30078,
  /** NIP-34 git repository announcement (read-only for the agent). */
  GIT_REPO_ANNOUNCEMENT: 30617,
  /** NIP-34 git repository state (read-only for the agent). */
  GIT_REPO_STATE: 30618,
  /** NIP-98 HTTP auth event (signed per request, never stored by the relay). */
  HTTP_AUTH: 27235,
} as const;

export type KindName = keyof typeof KIND;
export type KindValue = (typeof KIND)[KindName];

/**
 * Kinds the agent itself publishes. Used to validate NIP-OA conditions at boot.
 *
 * Includes {@link KIND.CLIENT_AUTH}: the NIP-42 auth event also carries the
 * `auth` tag, so an attestation restricted with `kind=` clauses that omitted
 * 22242 would pass this check and then fail at connection time.
 */
export const AGENT_PUBLISHED_KINDS: readonly number[] = [
  KIND.METADATA,
  KIND.CHAT,
  KIND.AGENT_PROFILE,
  KIND.CLIENT_AUTH,
  KIND.PRESENCE,
  KIND.OBSERVER,
  KIND.USAGE_METRIC,
  // Remote agents publish NIP-98 auth events for git/media; an attestation
  // that misses these strands the agent mid-request instead of at boot.
  // KIND.APP_DATA is intentionally absent: config records are signed directly
  // by the agent key without the NIP-OA auth tag (the record channel carries
  // no owner linkage), so attestation coverage does not apply to them.
  KIND.HTTP_AUTH,
];

/**
 * Inbound kinds treated as conversation triggers.
 *
 * Mirrors buzz-acp's default `--kinds` list (`relay.rs`): chat plus the two
 * notification kinds that render as channel messages.
 */
export const INBOUND_MESSAGE_KINDS: readonly number[] = [
  KIND.CHAT,
  KIND.STREAM_REMINDER,
  KIND.WORKFLOW_APPROVAL_REQUESTED,
];

/* -------------------------------------------------------------------------- */
/* Relay protocol messages                                                    */
/* -------------------------------------------------------------------------- */

/** Client -> relay messages (NIP-01, NIP-42). */
export type ClientMessage =
  | ["EVENT", NostrEvent]
  | ["REQ", string, ...NostrFilter[]]
  | ["CLOSE", string]
  | ["AUTH", NostrEvent];

/** Relay -> client messages (NIP-01, NIP-42). */
export type RelayMessage =
  | ["EVENT", string, NostrEvent]
  | ["OK", string, boolean, string]
  | ["EOSE", string]
  | ["CLOSED", string, string]
  | ["NOTICE", string]
  | ["AUTH", string];

/* -------------------------------------------------------------------------- */
/* Tag helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Returns the value (index 1) of the first tag with the given name. */
export function tagValue(event: { tags: NostrTag[] }, name: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === name && tag.length > 1) return tag[1];
  }
  return undefined;
}

/** Returns the values (index 1) of every tag with the given name, in order. */
export function tagValues(event: { tags: NostrTag[] }, name: string): string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === name && tag.length > 1) out.push(tag[1] as string);
  }
  return out;
}

/** Returns every tag with the given name, in order. */
export function tagsNamed(event: { tags: NostrTag[] }, name: string): NostrTag[] {
  return event.tags.filter((tag) => tag[0] === name);
}

/** The Buzz channel id carried by an event, from its `h` tag. */
export function channelIdOf(event: { tags: NostrTag[] }): string | undefined {
  return tagValue(event, "h");
}
