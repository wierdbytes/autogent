/**
 * Shared builders for the durable state tests.
 *
 * Not a suite itself: vitest only collects `*.test.ts`.
 */

import type { NostrEvent } from "../src/nostr/types.js";
import type {
  InboxRecord,
  OutboxRecord,
  OutputIntent,
  TurnRecord,
} from "../src/runtime/ports.js";
import { openInMemoryDatabase, type AgentState } from "../src/state/database.js";

export interface TestStore {
  readonly state: AgentState;
  now(): number;
  /** Moves the injected clock forward and returns the new value. */
  advance(ms?: number): number;
  close(): void;
}

export function openTestStore(startAt = 1_000): TestStore {
  let clock = startAt;
  const state = openInMemoryDatabase({ now: () => clock });
  return {
    state,
    now: () => clock,
    advance(ms = 1) {
      clock += ms;
      return clock;
    },
    close: () => state.close(),
  };
}

export function chatEvent(id: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: 1_700_000_000,
    kind: 9,
    tags: [["h", "channel-1"]],
    content: `content of ${id}`,
    sig: "b".repeat(128),
    ...overrides,
  };
}

export function inboxRecord(overrides: Partial<InboxRecord> & { eventId: string }): InboxRecord {
  return {
    channelId: "channel-1",
    threadRootId: overrides.eventId,
    authorPubkey: "a".repeat(64),
    createdAt: 1_700_000_000,
    receivedAt: 1_000,
    disposition: "queued",
    turnId: null,
    inputOrdinal: null,
    rawEvent: chatEvent(overrides.eventId),
    ...overrides,
  };
}

export function turnRecord(overrides: Partial<TurnRecord> & { turnId: string }): TurnRecord {
  return {
    channelId: "channel-1",
    threadRootId: "event-1",
    primaryTriggerEventId: "event-1",
    primaryAuthorPubkey: "a".repeat(64),
    state: "running",
    startedAt: 1_000,
    settledAt: null,
    stopReason: null,
    ...overrides,
  };
}

export function outputIntent(overrides: Partial<OutputIntent> & { logicalId: string }): OutputIntent {
  return {
    turnId: "turn-1",
    piMessageId: "msg-1",
    ordinal: 0,
    content: "answer",
    channelId: "channel-1",
    replyEventId: "event-1",
    rootEventId: "event-1",
    participantPubkeys: ["a".repeat(64)],
    state: "pending",
    ...overrides,
  };
}

export function outboxRecord(
  overrides: Partial<OutboxRecord> & { logicalId: string; eventId: string },
): OutboxRecord {
  return {
    kind: 9,
    signedEvent: chatEvent(overrides.eventId),
    state: "pending",
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    ...overrides,
  };
}
