/**
 * Cross-layer interfaces.
 *
 * The runtime talks to the relay, the database, Pi, and the telemetry pipeline
 * exclusively through these ports. Tests substitute in-memory fakes, which is
 * what lets the whole scheduler and turn state machine be exercised without a
 * relay, a provider, or a disk (plan §12, phases 0-1).
 *
 * This file is an addition to the module layout in plan §11: the plan lists
 * implementation modules but no shared port surface, and the four verticals
 * need one to be developed and tested independently.
 */

import type { NostrEvent, NostrFilter, UnsignedNostrEvent } from "../nostr/types.js";
import type { ObserverEvent } from "../telemetry/observer-envelope.js";

/* -------------------------------------------------------------------------- */
/* Ambient services                                                           */
/* -------------------------------------------------------------------------- */

/** Injectable time, so tests can run schedulers without real delays. */
export interface Clock {
  now(): number;
  /** Resolves after `ms`. Rejects with an AbortError if `signal` fires. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/* -------------------------------------------------------------------------- */
/* Relay                                                                      */
/* -------------------------------------------------------------------------- */

export type RelayState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "subscribing"
  | "ready"
  | "backing_off"
  /** Stopped for good: revoked attestation, `restricted:`, a 403. No retry. */
  | "failed";

/** Outcome of a single publish attempt. */
export interface PublishResult {
  ok: boolean;
  /** Relay message from the `OK` frame, e.g. `rate-limited: retry in 5s`. */
  message: string;
  /** True when retrying cannot succeed (bad signature, revoked attestation). */
  terminal: boolean;
}

export interface Subscription {
  readonly id: string;
  close(): void;
}

export interface SubscribeOptions {
  /** Stable id; reused verbatim when resubscribing after a reconnect. */
  id: string;
  filters: NostrFilter[];
  onEvent(event: NostrEvent): void;
  /** Fired when the relay has replayed everything it has. */
  onEose?(): void;
  /** Fired when the relay closes the subscription with a reason. */
  onClosed?(reason: string): void;
}

/**
 * A supervised relay connection.
 *
 * Implementations own reconnect, NIP-42 re-authentication and resubscription;
 * callers register subscriptions once and stay registered across reconnects.
 */
export interface RelayPort {
  readonly state: RelayState;
  connect(): Promise<void>;
  /** Publishes a signed event and waits for the relay's `OK`. */
  publish(event: NostrEvent): Promise<PublishResult>;
  /**
   * Publishes without waiting for durability. Used only for ephemeral kinds
   * (presence, telemetry) where a lost frame is cheaper than head-of-line
   * blocking the outbox.
   */
  publishEphemeral(event: NostrEvent): void;
  subscribe(options: SubscribeOptions): Subscription;
  /** One-shot query: opens a REQ, collects until EOSE, closes. */
  query(filters: NostrFilter[], timeoutMs?: number): Promise<NostrEvent[]>;
  onStateChange(listener: (state: RelayState) => void): () => void;
  /**
   * Fires when the connection has failed unrecoverably.
   *
   * Distinct from `onStateChange`, because a terminal failure after a healthy
   * start has no other listener and must escalate to process shutdown rather
   * than be mistaken for an ordinary disconnect.
   */
  onTerminal(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

/** Builds signed agent events with exactly one verified NIP-OA `auth` tag. */
export interface EventBuilderPort {
  build(draft: Omit<UnsignedNostrEvent, "pubkey" | "created_at"> & { created_at?: number }): NostrEvent;
}

/* -------------------------------------------------------------------------- */
/* Durable state                                                              */
/* -------------------------------------------------------------------------- */

export type InboxDisposition =
  | "queued"
  | "prompted"
  | "steer_pending"
  | "steer_delivered"
  | "completed"
  | "rejected"
  | "dead_letter";

export interface InboxRecord {
  eventId: string;
  channelId: string;
  threadRootId: string;
  authorPubkey: string;
  createdAt: number;
  receivedAt: number;
  disposition: InboxDisposition;
  turnId: string | null;
  inputOrdinal: number | null;
  rawEvent: NostrEvent;
}

export interface InboxRepository {
  /** Returns false when the event id was already recorded (dedup gate). */
  insertIfAbsent(record: InboxRecord): boolean;
  get(eventId: string): InboxRecord | undefined;
  setDisposition(eventId: string, disposition: InboxDisposition, turnId?: string | null): void;
  assignToTurn(eventId: string, turnId: string, ordinal: number, disposition: InboxDisposition): void;
  /** Undelivered inputs of a channel, oldest first. Used by recovery. */
  pendingForChannel(channelId: string): InboxRecord[];
  /** Marks every input of a settled turn terminal. */
  completeTurnInputs(turnId: string): void;
}

export type TurnState =
  | "created"
  | "running"
  | "settling"
  | "settled"
  | "interrupted"
  | "failed"
  | "completed";

export interface TurnRecord {
  turnId: string;
  channelId: string;
  threadRootId: string;
  primaryTriggerEventId: string;
  primaryAuthorPubkey: string;
  state: TurnState;
  startedAt: number;
  settledAt: number | null;
  stopReason: string | null;
}

export interface TurnRepository {
  create(record: TurnRecord): void;
  get(turnId: string): TurnRecord | undefined;
  setState(turnId: string, state: TurnState, stopReason?: string | null): void;
  addInput(turnId: string, eventId: string, role: "primary" | "steer", ordinal: number): void;
  markInputDelivered(turnId: string, eventId: string, at: number): void;
  inputs(turnId: string): Array<{ eventId: string; role: "primary" | "steer"; ordinal: number; deliveredAt: number | null }>;
  /** Turns left mid-flight by a crash. */
  unfinished(): TurnRecord[];
}

export type OutputIntentState = "pending" | "signed" | "published" | "abandoned";

export interface OutputIntent {
  /** `${turnId}:${piMessageId}:${ordinal}` — stable across restarts. */
  logicalId: string;
  turnId: string;
  piMessageId: string;
  ordinal: number;
  content: string;
  channelId: string;
  replyEventId: string;
  rootEventId: string;
  participantPubkeys: string[];
  state: OutputIntentState;
}

export type OutboxState = "pending" | "published" | "failed" | "dead_letter";

export interface OutboxRecord {
  logicalId: string;
  eventId: string;
  kind: number;
  signedEvent: NostrEvent;
  state: OutboxState;
  attempts: number;
  nextRetryAt: number | null;
  lastError: string | null;
}

export interface OutboxRepository {
  /** Records an output intent. Idempotent on `logicalId`. */
  putIntent(intent: OutputIntent): boolean;
  intentsForTurn(turnId: string): OutputIntent[];
  setIntentState(logicalId: string, state: OutputIntentState): void;
  /** Stores the signed event *before* it hits the network (plan §9.3). */
  putSigned(record: OutboxRecord): void;
  markPublished(logicalId: string): void;
  markFailed(logicalId: string, error: string, nextRetryAt: number | null): void;
  markDeadLetter(logicalId: string, error: string): void;
  /** Unpublished signed events due for a send attempt, oldest first. */
  duePublishes(now: number): OutboxRecord[];
}

export interface ChannelRecord {
  relayId: string;
  channelId: string;
  status: "active" | "removed";
  name: string | null;
  channelType: "stream" | "private" | "dm";
  piSessionId: string | null;
  piSessionPath: string | null;
  lastSeenCreatedAt: number | null;
}

export interface ChannelRepository {
  upsert(record: ChannelRecord): void;
  get(relayId: string, channelId: string): ChannelRecord | undefined;
  active(relayId: string): ChannelRecord[];
  setStatus(relayId: string, channelId: string, status: "active" | "removed"): void;
  setPiSession(relayId: string, channelId: string, sessionId: string, sessionPath: string | null): void;
  setLastSeen(relayId: string, channelId: string, createdAt: number): void;
}

/** Observer sequence numbers and usage baselines, keyed by Pi session. */
export interface SessionStateRepository {
  nextObserverSeq(sessionId: string): number;
  getUsageBaseline(sessionId: string): { turnSeq: number; counters: unknown } | undefined;
  setUsageBaseline(sessionId: string, turnSeq: number, counters: unknown): void;
}

export interface StatePort {
  readonly inbox: InboxRepository;
  readonly turns: TurnRepository;
  readonly outbox: OutboxRepository;
  readonly channels: ChannelRepository;
  readonly sessions: SessionStateRepository;
  /** Runs `fn` inside a single write transaction. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/* -------------------------------------------------------------------------- */
/* Telemetry                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything except `seq` and `timestamp`, which the publisher assigns. */
export type ObserverFrameDraft = Omit<ObserverEvent, "seq" | "timestamp" | "agentIndex"> & {
  agentIndex?: number | null;
};

/** Routing identity of one turn's telemetry stream. */
export interface TelemetryTurnRoute {
  channelId: string | null;
  sessionId: string | null;
  turnId: string;
  startedAt?: string | null;
}

export interface TelemetryPort {
  /** Enqueues a frame. Never throws and never blocks the caller. */
  emit(frame: ObserverFrameDraft): void;
  /** Flushes coalesced frames. Used at turn boundaries and on shutdown. */
  flush(): Promise<void>;
  /**
   * Starts the turn-liveness heartbeat that keeps Desktop's working indicator
   * alive through long, quiet tool calls. Returns the stop function, which the
   * caller must invoke exactly once when the turn settles.
   */
  trackTurn(route: TelemetryTurnRoute): () => void;
}

/* -------------------------------------------------------------------------- */
/* Pi session                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The slice of `AgentSession` the runtime depends on.
 *
 * Narrowing the SDK to this interface keeps the scheduler testable with a fake
 * session and insulates us from unrelated churn in the Pi API.
 */
export interface AgentSessionHandle {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;
  readonly model: string | undefined;
  /** Context window of the active model, in tokens, when the SDK reports it. */
  readonly contextWindow: number | undefined;
  /**
   * True when the session already holds conversation memory: it was resumed
   * from an on-disk transcript, or it has been prompted at least once in this
   * process. Context fetching keys off this to avoid re-injecting messages the
   * session already carries (its own replies, previously delivered triggers).
   */
  readonly hasHistory: boolean;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: PiEvent) => void): () => void;
  setModel(model: string): Promise<void>;
  /** True once the registry disposed the session; stale caches must re-acquire. */
  readonly disposed: boolean;
  dispose(): void;
}

/**
 * Normalised Pi events.
 *
 * The SDK's union is wider than we need; the router translates it into this
 * closed set so downstream code (telemetry, output extraction, the actor) has a
 * single, stable shape to match on.
 */
export type PiEvent =
  | { type: "agent_start"; willCompact: boolean }
  | { type: "turn_start" }
  | { type: "text_delta"; messageId: string; delta: string }
  | { type: "thinking_delta"; messageId: string; delta: string }
  | { type: "message_end"; messageId: string; role: string; text: string; usage: PiUsage | null }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_update"; toolCallId: string; delta: string }
  | { type: "tool_end"; toolCallId: string; isError: boolean; output: string }
  | { type: "retry"; attempt: number; maxAttempts: number; errorMessage: string }
  | { type: "compaction"; phase: "start" | "end"; reason: string }
  | { type: "agent_end"; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "diagnostic"; source: string; detail: unknown };

export interface PiUsage {
  input: number | null;
  output: number | null;
  total: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  costUsd: number | null;
}

export interface SessionRegistryPort {
  /** Opens or creates the persistent Pi session for a channel. */
  acquire(channelId: string): Promise<AgentSessionHandle>;
  /**
   * Applies a config change to future sessions (core-record hot update).
   * Optional: test fakes and registries without live reconfig may omit it.
   */
  applyConfig?(update: {
    model?: string;
    thinkingLevel?: string;
    appendSystemPrompt?: string;
    tools?: string[];
    excludeTools?: string[];
    extensions?: string[];
  }): Promise<void>;
  /** Drops the in-memory session; the transcript on disk survives. */
  release(channelId: string): Promise<void>;
  /** Starts a fresh session for the channel, discarding prior context. */
  rotate(channelId: string): Promise<AgentSessionHandle>;
  disposeAll(): Promise<void>;
}
