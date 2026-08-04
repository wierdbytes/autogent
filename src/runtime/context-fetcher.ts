/**
 * Fetches prior channel messages to include as prompt context (plan §15).
 *
 * Reads come straight off the relay with a bounded REQ — there is no Buzz HTTP
 * API or CLI in this service. Failures are non-fatal: a turn with less context
 * is better than a turn that never starts, so callers get `null` instead of an
 * exception.
 */

import type { NostrEvent } from "../nostr/types.js";
import { INBOUND_MESSAGE_KINDS } from "../nostr/types.js";
import { parseThreadTags } from "./conversation-key.js";
import type { ConversationContext, ContextMessage } from "./prompt-formatter.js";
import type { Logger, RelayPort } from "./ports.js";

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
}

const DEFAULT_LOOKBACK_SEC = 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 3_000;

export class ContextFetcher {
  constructor(private readonly deps: ContextFetcherDeps) {}

  async fetch(trigger: NostrEvent, threadRootId: string): Promise<ConversationContext | null> {
    if (this.deps.limit <= 0) return null;

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
            limit: Math.max(this.deps.limit * 4, 40),
          },
        ],
        this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    } catch (error) {
      this.deps.logger.warn("context fetch failed", { channelId, error });
      return null;
    }

    const isThreaded = threadRootId !== trigger.id;
    const relevant = events
      .filter((event) => event.id !== trigger.id)
      .filter((event) => {
        if (!isThreaded) return true;
        const { rootEventId } = parseThreadTags(event.tags);
        return event.id === threadRootId || rootEventId === threadRootId;
      })
      .sort((a, b) => a.created_at - b.created_at);

    if (relevant.length === 0) return null;

    const truncated = relevant.length > this.deps.limit;
    const window = truncated ? relevant.slice(-this.deps.limit) : relevant;

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
