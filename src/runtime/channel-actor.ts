/**
 * Per-channel actor (plan §5.3, §5.4).
 *
 * Every inbound Nostr event and every Pi lifecycle event for a channel goes
 * through one mailbox, processed strictly one at a time. That serialisation is
 * the whole point: the "did this message arrive before or after the turn
 * settled?" question becomes a matter of queue order rather than a timing guess,
 * which is what makes steering neither lose nor duplicate messages.
 *
 * `session.isStreaming` is consulted as a sanity check only — the actor's own
 * state is authoritative.
 */

import type { NostrEvent } from "../nostr/types.js";
import type {
  AgentSessionHandle,
  Clock,
  Logger,
  PiEvent,
  PiUsage,
  StatePort,
  TelemetryPort,
} from "./ports.js";
import type { OutputRouter } from "./output-router.js";
import type { ChannelType, ConversationContext, PromptChannelInfo } from "./prompt-formatter.js";
import { formatPrimaryPrompt, formatSteeringPrompt } from "./prompt-formatter.js";
import { canonicalThreadRoot, conversationKey, type ConversationKey } from "./conversation-key.js";
import { createTurnContext, withSteeringInput, type TurnContext } from "./turn-context.js";
import type { Semaphore } from "./scheduler.js";

export type ActorState = "idle" | "starting" | "running" | "settling" | "closed";

export interface AcceptedEvent {
  event: NostrEvent;
  /** Why the event was accepted, surfaced in the prompt header. */
  promptTag: string;
}

export interface ChannelActorDeps {
  relayId: string;
  channelId: string;
  channelName: string | null;
  channelType: ChannelType;
  state: StatePort;
  telemetry: TelemetryPort;
  output: OutputRouter;
  clock: Clock;
  logger: Logger;
  /** Opens (or reuses) the Pi session backing this channel. */
  acquireSession(): Promise<AgentSessionHandle>;
  /** Starts a fresh Pi session, discarding prior context. */
  rotateSession(): Promise<AgentSessionHandle>;
  /** Prior messages to include as context. */
  fetchContext(event: NostrEvent, threadRootId: string): Promise<ConversationContext | null>;
  /** Reports provider usage as Pi completes each model call. */
  observeUsage(sessionId: string, turnId: string, usage: PiUsage): void;
  /** Emits the NIP-AM metric for a finished turn. */
  publishUsage(turn: TurnContext, sessionId: string | null, stopReason: string): void;
  newTurnId(): string;
  idleTimeoutMs: number;
  maxTurnDurationMs: number;
  /**
   * Global ceiling on channels running a turn at once. Held for the whole turn,
   * so a busy community cannot open unbounded concurrent model calls.
   */
  concurrency?: Semaphore;
}

type Mailbox =
  | { kind: "inbound"; accepted: AcceptedEvent }
  | { kind: "pi"; event: PiEvent }
  | { kind: "cancel"; reason: string }
  | { kind: "rotate" }
  | { kind: "close" };

interface ActiveTurn {
  context: TurnContext;
  conversation: ConversationKey;
  lastActivityMs: number;
  cancelIdleWatch: () => void;
  releaseConcurrency: () => void;
}

export class ChannelActor {
  #state: ActorState = "idle";
  #mailbox: Mailbox[] = [];
  #pumping = false;
  #turn: ActiveTurn | null = null;
  #session: AgentSessionHandle | null = null;
  #unsubscribe: (() => void) | null = null;
  /** Events waiting for the current turn to finish, oldest first. */
  #queue: AcceptedEvent[] = [];
  /**
   * Number of `agent_settled` events still in flight from runs we already
   * closed out ourselves (an aborted turn still emits one). Without this the
   * straggler would settle whatever turn happens to be active by the time it is
   * processed — which, after the queue advances, is a different turn.
   */
  #staleSettles = 0;

  constructor(private readonly deps: ChannelActorDeps) {}

  get state(): ActorState {
    return this.#state;
  }

  get activeTurn(): TurnContext | null {
    return this.#turn?.context ?? null;
  }

  get queueDepth(): number {
    return this.#queue.length;
  }

  /** Accepts a gated, deduplicated inbound event. */
  submit(accepted: AcceptedEvent): void {
    this.#post({ kind: "inbound", accepted });
  }

  cancel(reason: string): void {
    this.#post({ kind: "cancel", reason });
  }

  rotate(): void {
    this.#post({ kind: "rotate" });
  }

  async close(): Promise<void> {
    this.#post({ kind: "close" });
    await this.drain();
  }

  /** Resolves when the mailbox is empty. Used by tests and by shutdown. */
  async drain(): Promise<void> {
    while (this.#pumping || this.#mailbox.length > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  #post(message: Mailbox): void {
    if (this.#state === "closed" && message.kind !== "close") return;
    this.#mailbox.push(message);
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#mailbox.length > 0) {
        const message = this.#mailbox.shift() as Mailbox;
        try {
          await this.#handle(message);
        } catch (error) {
          this.deps.logger.error("channel actor message failed", {
            kind: message.kind,
            error,
          });
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #handle(message: Mailbox): Promise<void> {
    switch (message.kind) {
      case "inbound":
        return this.#onInbound(message.accepted);
      case "pi":
        return this.#onPiEvent(message.event);
      case "cancel":
        return this.#onCancel(message.reason);
      case "rotate":
        return this.#onRotate();
      case "close":
        return this.#onClose();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Inbound routing                                                     */
  /* ------------------------------------------------------------------ */

  async #onInbound(accepted: AcceptedEvent): Promise<void> {
    const threadRootId = canonicalThreadRoot(accepted.event);
    const key = conversationKey(this.deps.relayId, this.deps.channelId, threadRootId);

    // A turn is only steerable while it is genuinely still in flight. Once
    // `agent_settled` has been processed the actor is idle and this becomes a
    // fresh turn, regardless of how close the two events were in time.
    const steerable =
      this.#turn !== null && (this.#state === "running" || this.#state === "settling");

    if (steerable && this.#turn?.conversation === key) {
      await this.#steer(accepted, threadRootId);
      return;
    }

    if (this.#state === "idle") {
      await this.#startTurn(accepted, threadRootId);
      return;
    }

    // A different thread, or a turn we cannot join: queue it durably and give it
    // its own turn later rather than letting it steer someone else's work.
    this.deps.state.inbox.setDisposition(accepted.event.id, "queued");
    this.#queue.push(accepted);
  }

  async #startTurn(accepted: AcceptedEvent, threadRootId: string): Promise<void> {
    this.#state = "starting";
    const { event } = accepted;
    const turnId = this.deps.newTurnId();
    const startedAtMs = this.deps.clock.now();

    const context = createTurnContext({
      turnId,
      channelId: this.deps.channelId,
      threadRootEventId: threadRootId,
      primaryTriggerEventId: event.id,
      primaryAuthorPubkey: event.pubkey,
      startedAtMs,
      primaryCreatedAt: event.created_at,
    });

    this.deps.state.transaction(() => {
      this.deps.state.turns.create({
        turnId,
        channelId: this.deps.channelId,
        threadRootId,
        primaryTriggerEventId: event.id,
        primaryAuthorPubkey: event.pubkey,
        state: "created",
        startedAt: startedAtMs,
        settledAt: null,
        stopReason: null,
      });
      this.deps.state.turns.addInput(turnId, event.id, "primary", 0);
      this.deps.state.inbox.assignToTurn(event.id, turnId, 0, "prompted");
    });

    // Taken before the session is opened so a queued channel does not hold a Pi
    // session idle while it waits for a slot.
    const releaseConcurrency = (await this.deps.concurrency?.acquire()) ?? (() => {});

    const session = await this.#ensureSession();
    const context_ = await this.deps.fetchContext(event, threadRootId).catch(() => null);
    const prompt = formatPrimaryPrompt({
      event,
      channel: this.#channelInfo(),
      context: context_,
      promptTag: accepted.promptTag,
    });

    this.#turn = {
      context,
      conversation: conversationKey(this.deps.relayId, this.deps.channelId, threadRootId),
      lastActivityMs: startedAtMs,
      cancelIdleWatch: this.#watchIdle(),
      releaseConcurrency,
    };
    this.#state = "running";

    this.deps.telemetry.emit({
      kind: "turn_started",
      channelId: this.deps.channelId,
      sessionId: session.sessionId,
      turnId,
      startedAt: new Date(startedAtMs).toISOString(),
      payload: { triggeringEventIds: [event.id], source: "nostr" },
    });
    this.deps.telemetry.emit({
      kind: "acp_write",
      channelId: this.deps.channelId,
      sessionId: session.sessionId,
      turnId,
      payload: {
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { prompt: [{ type: "text", text: prompt }] },
      },
    });

    this.deps.state.turns.setState(turnId, "running");
    this.deps.state.turns.markInputDelivered(turnId, event.id, this.deps.clock.now());

    // Deliberately not awaited: `prompt()` resolves only when the whole agent
    // run finishes, and blocking the mailbox on it would make same-thread
    // steering impossible. The turn is closed by `agent_settled` instead.
    void session.prompt(prompt).catch((error) => {
      this.deps.logger.error("prompt failed", { turnId, error });
      this.#post({ kind: "cancel", reason: "error" });
    });
  }

  /**
   * Delivers a same-thread follow-up into the running turn.
   *
   * The durable `steer_pending` marker is written *before* the handoff so a
   * rejection can be resolved without ambiguity: if Pi refuses because the turn
   * settled first, the event moves back to `queued` and starts its own turn. It
   * is never dropped and never delivered twice.
   */
  async #steer(accepted: AcceptedEvent, threadRootId: string): Promise<void> {
    const turn = this.#turn;
    const session = this.#session;
    if (!turn || !session) {
      this.deps.state.inbox.setDisposition(accepted.event.id, "queued");
      this.#queue.push(accepted);
      return;
    }

    const { event } = accepted;
    const ordinal = turn.context.inputs.length;

    this.deps.state.transaction(() => {
      this.deps.state.turns.addInput(turn.context.turnId, event.id, "steer", ordinal);
      this.deps.state.inbox.assignToTurn(event.id, turn.context.turnId, ordinal, "steer_pending");
    });

    const prompt = formatSteeringPrompt({
      event,
      channel: this.#channelInfo(),
      promptTag: accepted.promptTag,
    });

    try {
      await session.steer(prompt);
    } catch (error) {
      this.deps.logger.warn("steer rejected, requeuing as a new turn", {
        eventId: event.id,
        error,
      });
      this.deps.state.inbox.setDisposition(event.id, "queued", null);
      this.#queue.push(accepted);
      return;
    }

    turn.context = withSteeringInput(turn.context, {
      eventId: event.id,
      authorPubkey: event.pubkey,
      createdAt: event.created_at,
    });
    turn.lastActivityMs = this.deps.clock.now();

    this.deps.state.inbox.setDisposition(event.id, "steer_delivered");
    this.deps.state.turns.markInputDelivered(turn.context.turnId, event.id, this.deps.clock.now());

    this.deps.telemetry.emit({
      kind: "acp_write",
      channelId: this.deps.channelId,
      sessionId: session.sessionId,
      turnId: turn.context.turnId,
      payload: {
        jsonrpc: "2.0",
        method: "_goose/unstable/session/steer",
        params: { prompt: [{ type: "text", text: prompt }] },
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Pi events                                                           */
  /* ------------------------------------------------------------------ */

  async #onPiEvent(event: PiEvent): Promise<void> {
    const turn = this.#turn;
    if (turn) turn.lastActivityMs = this.deps.clock.now();

    switch (event.type) {
      case "message_end": {
        if (!turn || event.role !== "assistant") break;
        // Recorded synchronously: Pi persists its session after emitting this,
        // so the intent must be durable before we yield to anything async.
        this.deps.output.record(turn.context, event.messageId, event.text);
        if (event.usage && this.#session) {
          this.deps.observeUsage(this.#session.sessionId, turn.context.turnId, event.usage);
        }
        break;
      }

      // `agent_end` is not terminal: Pi may still retry, compact, or continue
      // from its own queue afterwards. Only `agent_settled` closes a turn.
      case "agent_end":
        if (turn && !event.willRetry) {
          this.#state = "settling";
          this.deps.state.turns.setState(turn.context.turnId, "settling");
        }
        break;

      case "agent_settled":
        if (this.#staleSettles > 0) {
          this.#staleSettles -= 1;
          break;
        }
        await this.#settle("end_turn");
        break;

      default:
        break;
    }
  }

  async #settle(stopReason: string): Promise<void> {
    const turn = this.#turn;
    if (!turn) {
      this.#state = this.#state === "closed" ? "closed" : "idle";
      return;
    }

    turn.cancelIdleWatch();
    turn.releaseConcurrency();

    this.deps.state.transaction(() => {
      this.deps.state.turns.setState(turn.context.turnId, "completed", stopReason);
      this.deps.state.inbox.completeTurnInputs(turn.context.turnId);
    });

    this.deps.publishUsage(turn.context, this.#session?.sessionId ?? null, stopReason);
    this.deps.output.finishTurn(turn.context.turnId);

    this.deps.telemetry.emit({
      kind: stopReason === "end_turn" ? "turn_completed" : "turn_error",
      channelId: this.deps.channelId,
      sessionId: this.#session?.sessionId ?? null,
      turnId: turn.context.turnId,
      payload: stopReason === "end_turn" ? {} : { outcome: stopReason, error: stopReason },
    });

    this.#turn = null;
    this.#state = "idle";
    await this.#dispatchQueued();
  }

  /** Promotes the oldest queued event into a fresh turn. */
  async #dispatchQueued(): Promise<void> {
    const next = this.#queue.shift();
    if (!next) return;
    await this.#startTurn(next, canonicalThreadRoot(next.event));
  }

  /* ------------------------------------------------------------------ */
  /* Controls                                                            */
  /* ------------------------------------------------------------------ */

  async #onCancel(reason: string): Promise<void> {
    if (!this.#turn || !this.#session) return;
    await this.#session.abort().catch((error) => {
      this.deps.logger.warn("abort failed", { error });
    });
    // The aborted run will still emit `agent_settled`; discount it so it cannot
    // terminate the turn we are about to start from the queue.
    this.#staleSettles += 1;
    await this.#settle(reason);
  }

  async #onRotate(): Promise<void> {
    await this.#onCancel("rotated");
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#session = await this.deps.rotateSession();
    this.#subscribeToSession(this.#session);
    this.deps.telemetry.emit({
      kind: "session_resolved",
      channelId: this.deps.channelId,
      sessionId: this.#session.sessionId,
      turnId: null,
      payload: { isNewSession: true },
    });
  }

  async #onClose(): Promise<void> {
    if (this.#turn) await this.#onCancel("shutdown");
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#state = "closed";
  }

  /* ------------------------------------------------------------------ */
  /* Session plumbing                                                    */
  /* ------------------------------------------------------------------ */

  async #ensureSession(): Promise<AgentSessionHandle> {
    if (this.#session) return this.#session;
    const session = await this.deps.acquireSession();
    this.#session = session;
    this.#subscribeToSession(session);
    this.deps.telemetry.emit({
      kind: "session_resolved",
      channelId: this.deps.channelId,
      sessionId: session.sessionId,
      turnId: null,
      payload: { isNewSession: true },
    });
    return session;
  }

  /**
   * Pi events are posted back into the mailbox rather than handled inline, so
   * they interleave with inbound Nostr events in a single, well-defined order.
   */
  #subscribeToSession(session: AgentSessionHandle): void {
    this.#unsubscribe = session.subscribe((event) => {
      this.#post({ kind: "pi", event });
    });
  }

  #channelInfo(): PromptChannelInfo {
    return {
      channelId: this.deps.channelId,
      name: this.deps.channelName,
      channelType: this.deps.channelType,
    };
  }

  /** Aborts a turn that has gone quiet, or that has simply run too long. */
  #watchIdle(): () => void {
    const started = this.deps.clock.now();
    const cancel = this.deps.clock.setInterval(() => {
      const turn = this.#turn;
      if (!turn) return;
      const now = this.deps.clock.now();
      if (now - turn.lastActivityMs >= this.deps.idleTimeoutMs) {
        this.cancel("idle_timeout");
      } else if (now - started >= this.deps.maxTurnDurationMs) {
        this.cancel("max_duration");
      }
    }, Math.max(1_000, Math.floor(this.deps.idleTimeoutMs / 4)));
    return cancel;
  }
}
