/**
 * Durable outbox publisher (plan §6.5, §9.3).
 *
 * Serial by construction: outputs of one turn must reach the channel in
 * `(turnId, ordinal)` order, and a relay that accepts frame 2 before frame 1
 * would reorder the conversation. Retries re-send the *stored* signed event, so
 * a lost `OK` can never produce a second event id for the same message.
 */

import { nullLogger } from "../runtime/logger.js";
import type { Clock, Logger, OutboxRecord, OutboxRepository, RelayPort } from "../runtime/ports.js";

export const DEFAULT_MAX_ATTEMPTS = 6;
export const DEFAULT_BASE_RETRY_MS = 1_000;
export const DEFAULT_MAX_RETRY_MS = 300_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;

export interface OutboxPublisherOptions {
  outbox: OutboxRepository;
  relay: RelayPort;
  clock: Clock;
  logger?: Logger;
  maxAttempts?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  pollIntervalMs?: number;
}

/** `${turnId}:${piMessageId}:${ordinal}` — see `OutputIntent.logicalId`. */
function splitLogicalId(logicalId: string): { turnId: string; ordinal: number } {
  const firstColon = logicalId.indexOf(":");
  const lastColon = logicalId.lastIndexOf(":");
  if (firstColon <= 0 || lastColon === firstColon) return { turnId: logicalId, ordinal: 0 };
  const ordinal = Number(logicalId.slice(lastColon + 1));
  return {
    turnId: logicalId.slice(0, firstColon),
    ordinal: Number.isFinite(ordinal) ? ordinal : 0,
  };
}

/**
 * Groups records by turn in first-seen order and orders each group by ordinal.
 *
 * Turn interleaving is harmless — different channels are independent — but two
 * outputs of the same turn are not, so only the within-turn order is imposed.
 */
export function orderForPublish(records: readonly OutboxRecord[]): OutboxRecord[] {
  const groups = new Map<string, Array<{ ordinal: number; index: number; record: OutboxRecord }>>();
  records.forEach((record, index) => {
    const { turnId, ordinal } = splitLogicalId(record.logicalId);
    const group = groups.get(turnId);
    if (group === undefined) groups.set(turnId, [{ ordinal, index, record }]);
    else group.push({ ordinal, index, record });
  });
  const ordered: OutboxRecord[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.ordinal - b.ordinal || a.index - b.index);
    for (const entry of group) ordered.push(entry.record);
  }
  return ordered;
}

export class OutboxPublisher {
  readonly #outbox: OutboxRepository;
  readonly #relay: RelayPort;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #maxAttempts: number;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #pollIntervalMs: number;
  readonly #abort = new AbortController();
  #running = false;
  #stopped = false;
  #loop: Promise<void> | null = null;
  /** Resolves the current inter-drain sleep early when new work is enqueued. */
  #wake: (() => void) | null = null;
  #woken = false;

  constructor(options: OutboxPublisherOptions) {
    this.#outbox = options.outbox;
    this.#relay = options.relay;
    this.#clock = options.clock;
    this.#logger = options.logger ?? nullLogger;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#baseRetryMs = options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
    this.#maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abort.abort();
    await this.#loop?.catch(() => {});
    this.#running = false;
  }

  /**
   * Wakes the loop immediately instead of waiting out the poll interval.
   *
   * A reply that sat in the outbox for the full interval would add that latency
   * to every message, which is plainly visible in a chat client.
   */
  notify(): void {
    this.#woken = true;
    this.#wake?.();
  }

  /** Publishes everything currently due. Returns how many the relay accepted. */
  async drainOnce(): Promise<number> {
    const due = orderForPublish(this.#outbox.duePublishes(this.#clock.now()));
    const blockedTurns = new Set<string>();
    let published = 0;

    for (const record of due) {
      if (this.#stopped) break;
      const { turnId } = splitLogicalId(record.logicalId);
      // A gap in one turn must not be filled by its own later outputs.
      if (blockedTurns.has(turnId)) continue;

      const result = await this.#relay.publish(record.signedEvent);
      if (result.ok) {
        this.#outbox.markPublished(record.logicalId);
        published += 1;
        continue;
      }

      const attempts = record.attempts + 1;
      blockedTurns.add(turnId);
      if (result.terminal) {
        this.#logger.error("outbox entry rejected permanently", {
          logicalId: record.logicalId,
          eventId: record.eventId,
          message: result.message,
        });
        this.#outbox.markDeadLetter(record.logicalId, result.message);
        continue;
      }
      if (attempts >= this.#maxAttempts) {
        this.#logger.error("outbox entry exhausted its retries", {
          logicalId: record.logicalId,
          eventId: record.eventId,
          attempts,
        });
        this.#outbox.markDeadLetter(record.logicalId, result.message);
        continue;
      }
      const nextRetryAt = this.#clock.now() + this.#retryDelayMs(attempts);
      this.#logger.warn("outbox publish failed; will retry the same event", {
        logicalId: record.logicalId,
        eventId: record.eventId,
        attempts,
        nextRetryAt,
      });
      this.#outbox.markFailed(record.logicalId, result.message, nextRetryAt);
    }
    return published;
  }

  #retryDelayMs(attempts: number): number {
    const growth = this.#baseRetryMs * 2 ** (attempts - 1);
    return Math.min(growth, this.#maxRetryMs);
  }

  /** Sleeps for the poll interval, or until {@link notify} fires. */
  #sleepUntilWork(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.#wake = null;
        cancel();
        resolve();
      };
      this.#wake = finish;
      const cancel = this.#clock.setTimeout(finish, this.#pollIntervalMs);
      if (this.#abort.signal.aborted) {
        settled = true;
        this.#wake = null;
        cancel();
        reject(new Error("stopped"));
        return;
      }
      this.#abort.signal.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          this.#wake = null;
          cancel();
          reject(new Error("stopped"));
        },
        { once: true },
      );
    });
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.drainOnce();
      } catch (error) {
        this.#logger.error("outbox drain failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.#woken) {
        this.#woken = false;
        continue;
      }
      try {
        await this.#sleepUntilWork();
      } catch {
        return;
      }
    }
  }
}
