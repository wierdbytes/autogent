import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent, NostrTag, UnsignedNostrEvent } from "../../src/nostr/types.js";
import { KIND } from "../../src/nostr/types.js";
import type {
  AgentSessionHandle,
  EventBuilderPort,
  ObserverFrameDraft,
  OutboxRecord,
  OutboxRepository,
  OutputIntent,
  OutputIntentState,
  PiEvent,
  StatePort,
  TelemetryPort,
  TelemetryTurnRoute,
} from "../../src/runtime/ports.js";

export const AGENT_SECRET = new Uint8Array(32).fill(11);
export const AGENT_PUBKEY = getPublicKey(AGENT_SECRET);
export const USER_A_SECRET = new Uint8Array(32).fill(22);
export const USER_A_PUBKEY = getPublicKey(USER_A_SECRET);
export const USER_B_SECRET = new Uint8Array(32).fill(33);
export const USER_B_PUBKEY = getPublicKey(USER_B_SECRET);

let clockSeconds = 1_700_000_000;

/** Signs a chat event as a user. Timestamps advance so ordering is stable. */
export function chatEvent(options: {
  secret?: Uint8Array;
  channelId: string;
  content: string;
  tags?: NostrTag[];
}): NostrEvent {
  const tags: NostrTag[] = [["h", options.channelId], ["p", AGENT_PUBKEY], ...(options.tags ?? [])];
  return finalizeEvent(
    {
      kind: KIND.CHAT,
      created_at: clockSeconds++,
      tags,
      content: options.content,
    },
    options.secret ?? USER_A_SECRET,
  ) as NostrEvent;
}

/** A reply that threads under `rootEventId`. */
export function replyEvent(options: {
  secret?: Uint8Array;
  channelId: string;
  content: string;
  rootEventId: string;
  parentEventId?: string;
}): NostrEvent {
  const tags: NostrTag[] = [["e", options.rootEventId, "", "root"]];
  if (options.parentEventId) tags.push(["e", options.parentEventId, "", "reply"]);
  return chatEvent({ ...options, tags });
}

export class FakeEventBuilder implements EventBuilderPort {
  build(draft: Omit<UnsignedNostrEvent, "pubkey" | "created_at"> & { created_at?: number }): NostrEvent {
    return finalizeEvent(
      {
        kind: draft.kind,
        created_at: draft.created_at ?? clockSeconds++,
        tags: draft.tags,
        content: draft.content,
      },
      AGENT_SECRET,
    ) as NostrEvent;
  }
}

/** In-memory outbox with the ordering guarantees the real repository provides. */
export class FakeOutbox implements OutboxRepository {
  readonly intents = new Map<string, OutputIntent>();
  readonly signed = new Map<string, OutboxRecord>();

  putIntent(intent: OutputIntent): boolean {
    if (this.intents.has(intent.logicalId)) return false;
    this.intents.set(intent.logicalId, { ...intent });
    return true;
  }
  intentsForTurn(turnId: string): OutputIntent[] {
    return [...this.intents.values()]
      .filter((intent) => intent.turnId === turnId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }
  setIntentState(logicalId: string, state: OutputIntentState): void {
    const intent = this.intents.get(logicalId);
    if (intent) intent.state = state;
  }
  putSigned(record: OutboxRecord): void {
    if (this.signed.has(record.logicalId)) return;
    this.signed.set(record.logicalId, { ...record });
  }
  markPublished(logicalId: string): void {
    const record = this.signed.get(logicalId);
    if (record) record.state = "published";
  }
  markFailed(logicalId: string, error: string, nextRetryAt: number | null): void {
    const record = this.signed.get(logicalId);
    if (!record) return;
    record.state = "failed";
    record.attempts += 1;
    record.lastError = error;
    record.nextRetryAt = nextRetryAt;
  }
  markDeadLetter(logicalId: string, error: string): void {
    const record = this.signed.get(logicalId);
    if (!record) return;
    record.state = "dead_letter";
    record.lastError = error;
  }
  duePublishes(now: number): OutboxRecord[] {
    return [...this.signed.values()]
      .filter((record) => record.state !== "published" && (record.nextRetryAt ?? 0) <= now)
      .sort((a, b) => {
        const left = this.intents.get(a.logicalId);
        const right = this.intents.get(b.logicalId);
        if (!left || !right) return 0;
        return left.turnId.localeCompare(right.turnId) || left.ordinal - right.ordinal;
      });
  }
  /** Every chat event handed to the relay, in publish order. */
  publishedChatEvents(): NostrEvent[] {
    return this.duePublishes(Number.MAX_SAFE_INTEGER)
      .filter((record) => record.kind === KIND.CHAT)
      .map((record) => record.signedEvent);
  }
}

export type FakeState = Omit<StatePort, "outbox"> & {
  outbox: FakeOutbox;
  dispositions: Map<string, string>;
};

/** Minimal `StatePort` that records dispositions so tests can assert on them. */
export function fakeState(): FakeState {
  const dispositions = new Map<string, string>();
  const turnInputs = new Map<string, Array<{ eventId: string; role: string; ordinal: number }>>();

  const state = {
    dispositions,
    inbox: {
      insertIfAbsent: () => true,
      get: () => undefined,
      setDisposition: (eventId: string, disposition: string) => {
        dispositions.set(eventId, disposition);
      },
      assignToTurn: (eventId: string, _turnId: string, _ordinal: number, disposition: string) => {
        dispositions.set(eventId, disposition);
      },
      pendingForChannel: () => [],
      completeTurnInputs: (turnId: string) => {
        for (const input of turnInputs.get(turnId) ?? []) {
          dispositions.set(input.eventId, "completed");
        }
      },
    },
    turns: {
      create: () => {},
      get: () => undefined,
      setState: () => {},
      addInput: (turnId: string, eventId: string, role: string, ordinal: number) => {
        const list = turnInputs.get(turnId) ?? [];
        list.push({ eventId, role, ordinal });
        turnInputs.set(turnId, list);
      },
      markInputDelivered: () => {},
      inputs: (turnId: string) =>
        (turnInputs.get(turnId) ?? []).map((input) => ({ ...input, deliveredAt: null })),
      unfinished: () => [],
    },
    outbox: new FakeOutbox(),
    channels: {
      upsert: () => {},
      get: () => undefined,
      active: () => [],
      setStatus: () => {},
      setPiSession: () => {},
      setLastSeen: () => {},
    },
    sessions: {
      nextObserverSeq: (() => {
        let seq = 0;
        return () => ++seq;
      })(),
      getUsageBaseline: () => undefined,
      setUsageBaseline: () => {},
    },
    transaction: <T>(fn: () => T): T => fn(),
    close: () => {},
  } as unknown as FakeState;

  return state;
}

export class FakeTelemetry implements TelemetryPort {
  readonly frames: ObserverFrameDraft[] = [];
  readonly trackedTurns: Array<{ turnId: string; stopped: number }> = [];
  emit(frame: ObserverFrameDraft): void {
    this.frames.push(frame);
  }
  async flush(): Promise<void> {}
  trackTurn(route: TelemetryTurnRoute): () => void {
    const entry = { turnId: route.turnId, stopped: 0 };
    this.trackedTurns.push(entry);
    return () => {
      entry.stopped += 1;
    };
  }
  ofKind(kind: string): ObserverFrameDraft[] {
    return this.frames.filter((frame) => frame.kind === kind);
  }
}

/**
 * Scriptable stand-in for a Pi `AgentSession`.
 *
 * `prompt()` never resolves on its own — mirroring the real SDK, where the
 * promise settles only when the whole run ends — so tests that await it by
 * mistake will hang loudly rather than pass by accident.
 */
export class FakeSession implements AgentSessionHandle {
  readonly sessionId: string;
  readonly sessionFile = undefined;
  model: string | undefined = "test/model";
  contextWindow: number | undefined = 200_000;
  isStreaming = false;
  isIdle = true;
  /** Mirrors the real adapter: flips on the first prompt, settable for tests. */
  hasHistory = false;
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  aborted = 0;
  steerRejects = false;
  disposed = false;
  #listeners = new Set<(event: PiEvent) => void>();

  constructor(sessionId = "session-1") {
    this.sessionId = sessionId;
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.hasHistory = true;
    this.isStreaming = true;
    this.isIdle = false;
    await new Promise<void>(() => {});
  }
  async steer(text: string): Promise<void> {
    if (this.steerRejects) throw new Error("session is not streaming");
    this.steers.push(text);
  }
  async abort(): Promise<void> {
    this.aborted += 1;
    this.isStreaming = false;
    this.isIdle = true;
  }
  async waitForIdle(): Promise<void> {}
  subscribe(listener: (event: PiEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async setModel(model: string): Promise<void> {
    this.model = model;
  }
  dispose(): void {
    this.disposed = true;
    this.#listeners.clear();
  }

  /** Pushes a Pi event to every subscriber, as the SDK would. */
  emit(event: PiEvent): void {
    if (event.type === "agent_settled") {
      this.isStreaming = false;
      this.isIdle = true;
    }
    for (const listener of this.#listeners) listener(event);
  }

  /** Convenience: a complete visible assistant message. */
  emitAssistantMessage(messageId: string, text: string): void {
    this.emit({ type: "message_end", messageId, role: "assistant", text, usage: null });
  }
}
