/**
 * Subscription registry, replay floors and event dedup.
 *
 * Split out of the supervisor so "what do we ask the relay for after a
 * reconnect" is decidable — and testable — without a socket. Registered
 * subscriptions outlive connections: callers subscribe once and the supervisor
 * replays the REQ on every new socket with a floor derived from what was
 * actually delivered.
 */

import type { SubscribeOptions } from "../runtime/ports.js";
import type { NostrEvent, NostrFilter } from "./types.js";

/**
 * Tolerance subtracted from the replay floor on resubscribe, in seconds.
 *
 * Relay and agent clocks drift; without the overlap an event stamped a second
 * behind our last-seen value would fall outside the new window and be lost.
 * Duplicates from the overlap are absorbed by the seen-id set.
 */
export const REPLAY_SKEW_SEC = 5;

/** Entries in the live generation before it is rotated into the previous one. */
export const SEEN_ROTATE_AT = 6_000;

/**
 * Two-generation dedup set.
 *
 * A plain unbounded Set leaks for a long-lived process and an LRU costs a map
 * write per hit. Rotating whole generations keeps membership checks O(1) with a
 * hard bound of `2 * rotateAt` ids and no per-event bookkeeping.
 */
export class SeenEventIds {
  #current = new Set<string>();
  #previous = new Set<string>();

  constructor(private readonly rotateAt: number = SEEN_ROTATE_AT) {}

  /** Records `id` and returns false when it had already been seen. */
  admit(id: string): boolean {
    if (this.#current.has(id) || this.#previous.has(id)) return false;
    this.#current.add(id);
    if (this.#current.size >= this.rotateAt) {
      this.#previous = this.#current;
      this.#current = new Set();
    }
    return true;
  }

  has(id: string): boolean {
    return this.#current.has(id) || this.#previous.has(id);
  }

  get size(): number {
    return this.#current.size + this.#previous.size;
  }
}

export class SubscriptionRecord {
  readonly id: string;
  readonly filters: readonly NostrFilter[];
  readonly handlers: Pick<SubscribeOptions, "onEvent" | "onEose" | "onClosed">;
  /** Highest `created_at` handed to the consumer, in seconds. */
  lastSeen: number | null = null;
  /** Oldest `created_at` we failed to deliver since the last completed replay. */
  droppedSince: number | null = null;

  constructor(options: SubscribeOptions) {
    this.id = options.id;
    // The replay floor is transport state, not caller state: a caller-pinned
    // `since` would survive reconnects and re-deliver the whole window, so
    // filters are stored stripped and `since` is injected per REQ.
    this.filters = options.filters.map(({ since: _since, ...rest }) => rest);
    this.handlers = { onEvent: options.onEvent, onEose: options.onEose, onClosed: options.onClosed };
  }

  /**
   * The `since` to use for the next REQ.
   *
   * First connection uses the startup watermark captured before the socket
   * opened. Later ones rewind to the last delivered event, and further to the
   * oldest dropped event when delivery failed.
   */
  since(startupWatermark: number): number {
    const base = this.lastSeen === null ? startupWatermark : this.lastSeen - REPLAY_SKEW_SEC;
    return this.droppedSince === null ? base : Math.min(base, this.droppedSince);
  }

  filtersFor(startupWatermark: number): NostrFilter[] {
    const since = this.since(startupWatermark);
    return this.filters.map((filter) => ({ ...filter, since }));
  }

  noteDelivered(event: NostrEvent): void {
    if (this.lastSeen === null || event.created_at > this.lastSeen) this.lastSeen = event.created_at;
  }

  noteDropped(createdAt: number): void {
    if (this.droppedSince === null || createdAt < this.droppedSince) this.droppedSince = createdAt;
  }

  /** EOSE means the relay replayed the whole requested window, gap included. */
  noteReplayComplete(): void {
    this.droppedSince = null;
  }
}

export class SubscriptionRegistry {
  readonly #records = new Map<string, SubscriptionRecord>();
  readonly #seen: SeenEventIds;

  constructor(
    /** Seconds since the epoch, captured before the first socket is opened. */
    readonly startupWatermark: number,
    seen: SeenEventIds = new SeenEventIds(),
  ) {
    this.#seen = seen;
  }

  add(options: SubscribeOptions): SubscriptionRecord {
    const record = new SubscriptionRecord(options);
    this.#records.set(record.id, record);
    return record;
  }

  remove(id: string): boolean {
    return this.#records.delete(id);
  }

  get(id: string): SubscriptionRecord | undefined {
    return this.#records.get(id);
  }

  all(): SubscriptionRecord[] {
    return [...this.#records.values()];
  }

  get size(): number {
    return this.#records.size;
  }

  filtersFor(record: SubscriptionRecord): NostrFilter[] {
    return record.filtersFor(this.startupWatermark);
  }

  /**
   * Routes an event to its subscription, deduplicated across the whole relay.
   *
   * Returns false when the event was a replay duplicate. Delivery failures are
   * recorded as a drop so the next REQ rewinds far enough to see the event
   * again instead of silently losing it.
   */
  deliver(subscriptionId: string, event: NostrEvent): boolean {
    const record = this.#records.get(subscriptionId);
    if (record === undefined) return false;
    if (!this.#seen.admit(event.id)) return false;
    record.noteDelivered(event);
    try {
      record.handlers.onEvent(event);
    } catch (error) {
      record.noteDropped(event.created_at);
      throw error;
    }
    return true;
  }
}
