/**
 * Fetches prior channel messages to seed a session or top it up (plan §15).
 *
 * Reads come straight off the relay with a bounded REQ — there is no Buzz HTTP
 * API or CLI in this service. Failures are non-fatal: a turn with less context
 * is better than a turn that never starts, so callers get `[]` instead of an
 * exception.
 *
 * Two modes:
 *
 * - `seed` — a brand-new session is being built. Everything relevant is
 *   returned, including the agent's own messages (they become `assistant`
 *   turns in the seeded transcript).
 * - `delta` — the session already carries memory. The agent's own replies live
 *   in the transcript as assistant turns and past triggering events were
 *   delivered verbatim as prompts or steers, so both are filtered out, along
 *   with anything at or before the caller's watermark.
 *
 * Events whose inbox disposition is `queued` are dropped in both modes: they
 * are waiting for a turn of their own, and including them here would deliver
 * them twice.
 */

import type { NostrEvent } from "../nostr/types.js";
import { INBOUND_MESSAGE_KINDS } from "../nostr/types.js";
import { parseThreadTags } from "./conversation-key.js";
import type { InboxDisposition, Logger, RelayPort } from "./ports.js";

/** One prior message, ready to become a seeded turn or an injected block. */
export interface HistoryMessage {
  eventId: string;
  authorPubkey: string;
  /** Unix seconds. */
  createdAt: number;
  content: string;
  /** True when the agent itself wrote the message. */
  fromAgent: boolean;
}

export interface FetchHistoryOptions {
  mode: "seed" | "delta";
  /** Only events strictly newer than this (unix seconds) are returned. */
  sinceExclusive?: number;
}

export interface HistoryFetcherDeps {
  relay: RelayPort;
  logger: Logger;
  /** Maximum messages to include. 0 disables history fetching entirely. */
  limit: number;
  /** How far back to look, in seconds. */
  lookbackSec?: number;
  timeoutMs?: number;
  /** The agent's own pubkey; marks messages as `fromAgent`. */
  agentPubkey: string;
  /**
   * Inbox disposition of an event id, when recorded. Backed by the inbox
   * repository; used to drop events a continuing session already received as a
   * prompt or steer, and events queued for their own turn.
   */
  dispositionOf?(eventId: string): InboxDisposition | null;
}

/**
 * Dispositions proving the event text already reached the session verbatim.
 * `rejected` and `dead_letter` are deliberately absent — those events were
 * never delivered, so history is their only way in.
 */
const DELIVERED_DISPOSITIONS: ReadonlySet<InboxDisposition> = new Set([
  "prompted",
  "steer_pending",
  "steer_delivered",
  "completed",
]);

const DEFAULT_LOOKBACK_SEC = 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 3_000;

export class HistoryFetcher {
  #limit: number;

  constructor(private readonly deps: HistoryFetcherDeps) {
    this.#limit = deps.limit;
  }

  /** Core-record hot update (remote plan §3.3). Takes effect on the next fetch. */
  setLimit(limit: number): void {
    this.#limit = limit;
  }

  /**
   * Prior messages of the trigger's conversation, oldest first.
   *
   * Thread triggers (`threadRootId !== trigger.id`) see only their thread;
   * top-level triggers see the whole channel.
   */
  async fetch(
    trigger: NostrEvent,
    threadRootId: string,
    opts: FetchHistoryOptions,
  ): Promise<HistoryMessage[]> {
    if (this.#limit <= 0) return [];

    const lookbackSince = trigger.created_at - (this.deps.lookbackSec ?? DEFAULT_LOOKBACK_SEC);
    const sinceExclusive = opts.sinceExclusive ?? null;
    const since = sinceExclusive === null ? lookbackSince : Math.max(lookbackSince, sinceExclusive + 1);
    const channelId = trigger.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channelId) return [];

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
      this.deps.logger.warn("history fetch failed", { channelId, error });
      return [];
    }

    const isThreaded = threadRootId !== trigger.id;
    const relevant = events
      .filter((event) => event.id !== trigger.id)
      .filter((event) => sinceExclusive === null || event.created_at > sinceExclusive)
      .filter((event) => {
        if (!isThreaded) return true;
        const { rootEventId } = parseThreadTags(event.tags);
        return event.id === threadRootId || rootEventId === threadRootId;
      })
      .filter((event) => {
        const disposition = this.deps.dispositionOf?.(event.id) ?? null;
        if (disposition === "queued") return false;
        if (opts.mode === "seed") return true;
        if (event.pubkey === this.deps.agentPubkey) return false;
        return disposition === null || !DELIVERED_DISPOSITIONS.has(disposition);
      })
      .sort((a, b) => a.created_at - b.created_at);

    const window = relevant.length > this.#limit ? relevant.slice(-this.#limit) : relevant;

    return window.map((event) => ({
      eventId: event.id,
      authorPubkey: event.pubkey,
      createdAt: event.created_at,
      content: event.content,
      fromAgent: event.pubkey === this.deps.agentPubkey,
    }));
  }
}
