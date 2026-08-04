/**
 * In-memory `OutboxRepository` for the transport publisher.
 *
 * Distinct from `fakes.ts`'s `FakeOutbox`, which is shaped for the runtime
 * layer: that one keeps re-serving dead-lettered rows and derives ordering from
 * intents, neither of which lets the publisher's retry and give-up rules be
 * observed. This double models the durable contract instead — terminal rows
 * leave the queue and insertion order is the queue order.
 */

import type {
  OutboxRecord,
  OutboxRepository,
  OutputIntent,
  OutputIntentState,
} from "../../src/runtime/ports.js";

export class PublisherOutbox implements OutboxRepository {
  readonly intents = new Map<string, OutputIntent>();
  readonly records = new Map<string, OutboxRecord>();
  /** Insertion order, so `duePublishes` can answer "oldest first". */
  readonly order: string[] = [];

  putIntent(intent: OutputIntent): boolean {
    if (this.intents.has(intent.logicalId)) return false;
    this.intents.set(intent.logicalId, { ...intent });
    return true;
  }

  intentsForTurn(turnId: string): OutputIntent[] {
    return [...this.intents.values()].filter((intent) => intent.turnId === turnId);
  }

  setIntentState(logicalId: string, state: OutputIntentState): void {
    const intent = this.intents.get(logicalId);
    if (intent !== undefined) intent.state = state;
  }

  putSigned(record: OutboxRecord): void {
    if (!this.records.has(record.logicalId)) this.order.push(record.logicalId);
    this.records.set(record.logicalId, { ...record });
  }

  markPublished(logicalId: string): void {
    const record = this.records.get(logicalId);
    if (record === undefined) return;
    record.state = "published";
    record.nextRetryAt = null;
  }

  markFailed(logicalId: string, error: string, nextRetryAt: number | null): void {
    const record = this.records.get(logicalId);
    if (record === undefined) return;
    record.state = "failed";
    record.attempts += 1;
    record.lastError = error;
    record.nextRetryAt = nextRetryAt;
  }

  markDeadLetter(logicalId: string, error: string): void {
    const record = this.records.get(logicalId);
    if (record === undefined) return;
    record.state = "dead_letter";
    record.attempts += 1;
    record.lastError = error;
    record.nextRetryAt = null;
  }

  duePublishes(now: number): OutboxRecord[] {
    return this.order
      .map((logicalId) => this.records.get(logicalId))
      .filter((record): record is OutboxRecord => {
        if (record === undefined) return false;
        if (record.state !== "pending" && record.state !== "failed") return false;
        return record.nextRetryAt === null || record.nextRetryAt <= now;
      });
  }

  get(logicalId: string): OutboxRecord | undefined {
    return this.records.get(logicalId);
  }
}
