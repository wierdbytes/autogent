/**
 * NIP-AO observer publisher (plan §6.7): kind 24200, `frame=telemetry`.
 *
 * Owns everything the compat mapper deliberately does not: the per-session
 * sequence, the millisecond timestamp Desktop sorts on, NIP-44 encryption to
 * the owner and nobody else, and the ephemeral publish. Telemetry must never
 * be able to fail a turn, so `emit` swallows and logs rather than throwing.
 */

import { KIND, type NostrTag } from "../nostr/types.js";
import type { Signer } from "../nostr/signer.js";
import { nullLogger } from "../runtime/logger.js";
import type {
  Clock,
  EventBuilderPort,
  Logger,
  ObserverFrameDraft,
  RelayPort,
  SessionStateRepository,
  TelemetryPort,
} from "../runtime/ports.js";
import {
  OBSERVER_MAX_PLAINTEXT_BYTES,
  TURN_LIVENESS_INTERVAL_MS,
  observerTimestamp,
  type ObserverEvent,
} from "./observer-envelope.js";
import {
  diagnosticFrame,
  frameDraft,
  turnLivenessFrame,
  utf8ByteLength,
  type FrameRoute,
} from "./buzz-desktop-compat.js";
import { TelemetryBuffer } from "./telemetry-buffer.js";

/**
 * Sequence bucket for frames emitted before a Pi session exists (bootstrap,
 * relay diagnostics). Keeping them out of a real session's series stops a
 * session's first frames from starting at an arbitrary offset.
 */
export const UNSCOPED_SESSION_KEY = "__unscoped__";

export interface ObserverPublisherOptions {
  signer: Signer;
  /** The only NIP-44 recipient. Frames are readable by owner and agent alone. */
  ownerPubkey: string;
  builder: EventBuilderPort;
  relay: Pick<RelayPort, "publishEphemeral">;
  sessions: SessionStateRepository;
  clock: Clock;
  logger?: Logger;
  /** Pool slot index; always 0 for this single-process service. */
  agentIndex?: number | null;
  coalesceWindowMs?: number;
  maxFramesPerSecond?: number;
  payloadBudgetBytes?: number;
  maxQueuedFrames?: number;
  livenessIntervalMs?: number;
}

export class ObserverPublisher implements TelemetryPort {
  readonly #signer: Signer;
  readonly #ownerPubkey: string;
  readonly #builder: EventBuilderPort;
  readonly #relay: Pick<RelayPort, "publishEphemeral">;
  readonly #sessions: SessionStateRepository;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #agentIndex: number | null;
  readonly #livenessIntervalMs: number;
  readonly #buffer: TelemetryBuffer;

  /** Guarantees a strictly increasing stamp so `(timestamp, seq)` is a total order. */
  #lastStampMs = Number.NEGATIVE_INFINITY;
  readonly #turnActivityMs = new Map<string, number>();
  readonly #livenessCancels = new Set<() => void>();

  constructor(options: ObserverPublisherOptions) {
    this.#signer = options.signer;
    this.#ownerPubkey = options.ownerPubkey;
    this.#builder = options.builder;
    this.#relay = options.relay;
    this.#sessions = options.sessions;
    this.#clock = options.clock;
    this.#logger = options.logger ?? nullLogger;
    this.#agentIndex = options.agentIndex ?? 0;
    this.#livenessIntervalMs = options.livenessIntervalMs ?? TURN_LIVENESS_INTERVAL_MS;
    this.#buffer = new TelemetryBuffer({
      clock: options.clock,
      emitFrame: (draft) => this.#publish(draft),
      coalesceWindowMs: options.coalesceWindowMs,
      maxFramesPerSecond: options.maxFramesPerSecond,
      payloadBudgetBytes: options.payloadBudgetBytes,
      maxQueuedFrames: options.maxQueuedFrames,
    });
  }

  emit(frame: ObserverFrameDraft): void {
    try {
      this.#buffer.push(frame);
    } catch (error) {
      this.#logger.error("observer frame rejected", { error: String(error), kind: frame.kind });
    }
  }

  async flush(): Promise<void> {
    await this.#buffer.flush();
  }

  /**
   * Heartbeats a turn so Desktop does not prune it.
   *
   * Desktop drops a turn after ~25s without frames, which would clear the
   * working indicator while a long tool call is still running. The heartbeat is
   * suppressed whenever the turn produced real frames in the interval, so a
   * chatty turn costs nothing.
   */
  trackTurn(route: FrameRoute & { turnId: string }): () => void {
    const key = route.turnId;
    this.#turnActivityMs.set(key, this.#clock.now());
    const cancelInterval = this.#clock.setInterval(() => {
      const last = this.#turnActivityMs.get(key) ?? Number.NEGATIVE_INFINITY;
      if (this.#clock.now() - last < this.#livenessIntervalMs) return;
      this.emit(frameDraft(turnLivenessFrame(), route));
    }, this.#livenessIntervalMs);
    const stop = () => {
      cancelInterval();
      this.#livenessCancels.delete(stop);
      this.#turnActivityMs.delete(key);
      this.#buffer.forgetTurn(route.turnId);
    };
    this.#livenessCancels.add(stop);
    return stop;
  }

  close(): void {
    for (const stop of [...this.#livenessCancels]) stop();
    this.#buffer.stop();
    this.#turnActivityMs.clear();
  }

  #publish(draft: ObserverFrameDraft): void {
    const atMs = this.#nextStampMs();
    if (draft.turnId !== null) this.#turnActivityMs.set(draft.turnId, atMs);
    try {
      const envelope = this.#seal(draft, atMs);
      const content = this.#signer.encrypt(this.#ownerPubkey, JSON.stringify(envelope));
      const tags: NostrTag[] = [
        ["p", this.#ownerPubkey],
        ["agent", this.#signer.publicKey],
        ["frame", "telemetry"],
      ];
      if (envelope.channelId) tags.push(["h", envelope.channelId]);
      const event = this.#builder.build({
        kind: KIND.OBSERVER,
        tags,
        content,
        created_at: Math.floor(atMs / 1000),
      });
      this.#relay.publishEphemeral(event);
    } catch (error) {
      // Telemetry is best-effort by design: a signing or transport failure must
      // not propagate into the turn that produced the frame.
      this.#logger.error("observer frame publish failed", {
        error: String(error),
        kind: draft.kind,
      });
    }
  }

  /**
   * Builds the decrypted envelope, enforcing the plaintext ceiling.
   *
   * The buffer already split on the working budget, but `seq`, `timestamp` and
   * routing are added here, so this is the only place that can see the true
   * plaintext size. An over-budget frame is replaced by a visible diagnostic
   * rather than being dropped or rejected by the relay.
   */
  #seal(draft: ObserverFrameDraft, atMs: number): ObserverEvent {
    const sessionKey = draft.sessionId ?? UNSCOPED_SESSION_KEY;
    const envelope: ObserverEvent = {
      seq: this.#sessions.nextObserverSeq(sessionKey),
      timestamp: observerTimestamp(atMs),
      kind: draft.kind,
      agentIndex: draft.agentIndex ?? this.#agentIndex,
      channelId: draft.channelId,
      sessionId: draft.sessionId,
      turnId: draft.turnId,
      ...(draft.startedAt === undefined ? {} : { startedAt: draft.startedAt }),
      payload: draft.payload,
    };
    const size = utf8ByteLength(JSON.stringify(envelope));
    if (size <= OBSERVER_MAX_PLAINTEXT_BYTES) return envelope;
    this.#logger.warn("observer frame exceeded the plaintext ceiling", { kind: draft.kind, size });
    return {
      ...envelope,
      kind: "acp_read",
      payload: diagnosticFrame({
        type: "observer_payload_elided",
        title: "Telemetry payload elided",
        text:
          `A ${draft.kind} frame of ${size} bytes exceeded the ` +
          `${OBSERVER_MAX_PLAINTEXT_BYTES} byte NIP-44 plaintext limit.`,
      }).payload,
    };
  }

  /**
   * Desktop dedups on `(seq, timestamp)` across an agent's whole frame stream
   * while `seq` restarts per session. Forcing distinct millisecond stamps makes
   * that pair unique regardless of how many sessions are streaming at once.
   */
  #nextStampMs(): number {
    const next = Math.max(this.#clock.now(), this.#lastStampMs + 1);
    this.#lastStampMs = next;
    return next;
  }
}
