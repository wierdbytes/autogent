/**
 * Canonical thread identity (plan §1.4).
 *
 * Two inbound events belong to the same conversation when they resolve to the
 * same `ConversationKey`. Only same-key events may steer a running turn.
 */

import type { NostrEvent, NostrTag } from "../nostr/types.js";

/** `relayId + channelId + canonicalThreadRootEventId`, joined with a separator. */
export type ConversationKey = string & { readonly __brand: "ConversationKey" };

const HEX64 = /^[0-9a-f]{64}$/;

export function isEventId(value: string | undefined): value is string {
  return typeof value === "string" && HEX64.test(value);
}

export function conversationKey(
  relayId: string,
  channelId: string,
  threadRootEventId: string,
): ConversationKey {
  return `${relayId}\u0000${channelId}\u0000${threadRootEventId}` as ConversationKey;
}

/** NIP-10 thread markers extracted from an event's `e` tags. */
export interface ThreadTags {
  rootEventId: string | null;
  replyEventId: string | null;
}

/**
 * Parses NIP-10 `e` tags, preferring explicit markers.
 *
 * Falls back to the deprecated positional form (first `e` = root, last `e` =
 * reply). Anything that is not a valid 64-hex event id is discarded rather than
 * trusted — malformed thread tags must never become routing data (plan §6.4).
 */
export function parseThreadTags(tags: readonly NostrTag[]): ThreadTags {
  let root: string | null = null;
  let reply: string | null = null;
  const unmarked: string[] = [];

  for (const tag of tags) {
    if (tag[0] !== "e") continue;
    const id = tag[1];
    if (!isEventId(id)) continue;
    const marker = tag[3];
    if (marker === "root") {
      root = id;
    } else if (marker === "reply") {
      reply = id;
    } else if (marker === undefined || marker === "") {
      unmarked.push(id);
    }
    // "mention" and unknown markers are intentionally ignored.
  }

  if (root === null && unmarked.length > 0) {
    root = unmarked[0] as string;
  }
  if (reply === null && unmarked.length > 1) {
    reply = unmarked[unmarked.length - 1] as string;
  }
  return { rootEventId: root, replyEventId: reply };
}

/**
 * The thread root an inbound event belongs to.
 *
 * A valid NIP-10 root wins; otherwise the event is itself a top-level message
 * and becomes its own root. This is fail-safe: a garbled `e` tag starts a fresh
 * canonical thread instead of hijacking an existing one.
 */
export function canonicalThreadRoot(event: Pick<NostrEvent, "id" | "tags">): string {
  const { rootEventId } = parseThreadTags(event.tags);
  return rootEventId ?? event.id;
}
