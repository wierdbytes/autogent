/**
 * Fetches prior channel messages to include as prompt context (plan §15).
 *
 * Reads come straight off the relay with a bounded REQ — there is no Buzz HTTP
 * API or CLI in this service. Failures are non-fatal: a turn with less context
 * is better than a turn that never starts, so callers get `null` instead of an
 * exception.
 *
 * A continuing session (`sessionHasHistory`) already carries most of the
 * channel: its own replies live in the transcript as assistant messages, and
 * past triggering events were delivered verbatim as prompts or steers. Re-
 * injecting them every turn only bloats the prompt and inflates cacheWrite
 * cost, so both are filtered out here. A fresh session (new, or just rotated)
 * has no such memory — the fetched context is its only seed — so it gets
 * everything.
 */

import type { NostrEvent } from "../nostr/types.js";
import { INBOUND_MESSAGE_KINDS } from "../nostr/types.js";
import { parseThreadTags } from "./conversation-key.js";
import type { ConversationContext, ContextMessage } from "./prompt-formatter.js";
import type { InboxDisposition, Logger, RelayPort } from "./ports.js";

export interface ContextFetcherDeps {
  relay: RelayPort;
  logger: Logger;
  /** Maximum messages to include. 0 disables context fetching entirely. */
  limit: number;
  /** How far back to look, in seconds. */
  lookbackSec?: number;
  timeoutMs?: number;
  /** Resolves a display name for a pubkey, when one is known. */
  resolveLabel?(pubkey: string): string | null;
  /** The agent's own events are dropped for continuing sessions. */
  agentPubkey: string;
  /**
   * Inbox disposition of an event id, when recorded. Backed by the inbox
   * repository; used to drop events a continuing session already received as a
   * prompt or steer.
   */
  deliveredDispositionOf?(eventId: string): InboxDisposition | null;
}

/**
 * Dispositions proving the event text already reached the session verbatim.
 * `queued`, `rejected` and `dead_letter` are deliberately absent — those
 * events were never delivered, so context is their only way in.
 */
const DELIVERED_DISPOSITIONS: ReadonlySet<InboxDisposition> = new Set([
  "prompted",
  "steer_pending",
  "steer_delivered",
  "completed",
]);

const DEFAULT_LOOKBACK_SEC = 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 3_000;

export class ContextFetcher {
  #limit: number;

  constructor(private readonly deps: ContextFetcherDeps) {
    this.#limit = deps.limit;
  }

  /** Core-record hot update (remote plan §3.3). Takes effect on the next fetch. */
  setLimit(limit: number): void {
    this.#limit = limit;
  }

  async fetch(
    trigger: NostrEvent,
    threadRootId: string,
    opts: { sessionHasHistory: boolean },
  ): Promise<ConversationContext | null> {
    if (this.#limit <= 0) return null;

    const since = trigger.created_at - (this.deps.lookbackSec ?? DEFAULT_LOOKBACK_SEC);
    const channelId = trigger.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channelId) return null;

    let events: NostrEvent[];
    try {
      events = await this.deps.relay.query(
        [
          {
            kinds: [...INBOUND_MESSAGE_KINDS],
            "#h": [channelId],
            since,
            // Over-fetch: the thread filter below discards most of it, and a
            // second round trip costs more than a slightly larger response.
            limit: Math.max(this.#limit * 4, 40),
          },
        ],
        this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    } catch (error) {
      this.deps.logger.warn("context fetch failed", { channelId, error });
      return null;
    }

    const isThreaded = threadRootId !== trigger.id;
    let relevant = events
      .filter((event) => event.id !== trigger.id)
      .filter((event) => {
        if (!isThreaded) return true;
        const { rootEventId } = parseThreadTags(event.tags);
        return event.id === threadRootId || rootEventId === threadRootId;
      })
      .sort((a, b) => a.created_at - b.created_at);

    // Dedup against the session's own memory (see module doc). Applied before
    // the truncation window so filtered events do not eat context slots, and
    // `total`/`truncated` describe what could actually have been included.
    //
    // Accepted edge case: after a rotation, triggers delivered to the
    // *previous* session get filtered on the new session's second and later
    // turns. That is fine — the rotation's first turn (fresh session, no
    // filtering) already re-seeded the full context.
    if (opts.sessionHasHistory) {
      relevant = relevant.filter((event) => {
        if (event.pubkey === this.deps.agentPubkey) return false;
        const disposition = this.deps.deliveredDispositionOf?.(event.id) ?? null;
        return disposition === null || !DELIVERED_DISPOSITIONS.has(disposition);
      });
    }

    if (relevant.length === 0) return null;

    const truncated = relevant.length > this.#limit;
    const window = truncated ? relevant.slice(-this.#limit) : relevant;

    const messages: ContextMessage[] = window.map((event) => ({
      eventId: event.id,
      authorPubkey: event.pubkey,
      authorLabel: this.deps.resolveLabel?.(event.pubkey) ?? null,
      createdAt: event.created_at,
      content: event.content,
    }));

    return {
      kind: isThreaded ? "thread" : "conversation",
      messages,
      total: relevant.length,
      truncated,
    };
  }
}
