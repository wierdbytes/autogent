/**
 * Coalescing, chunking and backpressure in front of the observer publisher
 * (plan §8.3).
 *
 * Pi emits token-level deltas; forwarding each one as its own relay event would
 * burn the NIP-AO 100 frames/sec allowance in a few hundred milliseconds and
 * bury Desktop in near-empty frames. This buffer merges deltas per
 * `(turn, message)` inside a short window, splits anything that outgrows the
 * NIP-44 plaintext budget, and paces the result — while guaranteeing that a
 * frame is never dropped without the owner being told.
 */

import type { Clock, ObserverFrameDraft } from "../runtime/ports.js";
import {
  OBSERVER_FRAME_BUDGET_BYTES,
  OBSERVER_MAX_FRAMES_PER_SECOND,
} from "./observer-envelope.js";
import {
  chunkFrameOf,
  diagnosticFrame,
  mergeToolStatus,
  readChunkIdentity,
  readToolFrameIdentity,
  splitFramePayload,
  withToolStatus,
  type ChunkIdentity,
  type ToolStatus,
} from "./buzz-desktop-compat.js";

/** Plan §8.3 pins the coalescing window to this range. */
export const MIN_COALESCE_WINDOW_MS = 25;
export const MAX_COALESCE_WINDOW_MS = 50;
export const DEFAULT_COALESCE_WINDOW_MS = 40;

/**
 * Queue ceiling before the buffer starts shedding.
 *
 * Sized so a full second of the relay allowance can sit in front of a stalled
 * transport without the process growing unbounded.
 */
export const DEFAULT_MAX_QUEUED_FRAMES = 5 * OBSERVER_MAX_FRAMES_PER_SECOND;

const RATE_WINDOW_MS = 1_000;

export interface TelemetryBufferOptions {
  clock: Clock;
  /** Called once per frame that survives coalescing, splitting and pacing. */
  emitFrame(draft: ObserverFrameDraft): void;
  coalesceWindowMs?: number;
  maxFramesPerSecond?: number;
  payloadBudgetBytes?: number;
  maxQueuedFrames?: number;
}

interface PendingChunk {
  route: ObserverFrameDraft;
  identity: ChunkIdentity;
  cancelTimer: () => void;
}

export class TelemetryBuffer {
  readonly #clock: Clock;
  readonly #emitFrame: (draft: ObserverFrameDraft) => void;
  readonly #coalesceWindowMs: number;
  readonly #maxFramesPerSecond: number;
  readonly #payloadBudgetBytes: number;
  readonly #maxQueuedFrames: number;

  readonly #pending = new Map<string, PendingChunk>();
  readonly #queue: ObserverFrameDraft[] = [];
  readonly #toolStatus = new Map<string, ToolStatus>();
  #drainWaiters: Array<() => void> = [];

  #windowStartMs = Number.NEGATIVE_INFINITY;
  #windowCount = 0;
  #cancelPumpTimer: (() => void) | null = null;

  #droppedFrames = 0;
  #lastDropRoute: ObserverFrameDraft | null = null;

  constructor(options: TelemetryBufferOptions) {
    const window = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    if (window < MIN_COALESCE_WINDOW_MS || window > MAX_COALESCE_WINDOW_MS) {
      throw new RangeError(
        `coalesceWindowMs must be within ${MIN_COALESCE_WINDOW_MS}-${MAX_COALESCE_WINDOW_MS} ms`,
      );
    }
    this.#clock = options.clock;
    this.#emitFrame = options.emitFrame;
    this.#coalesceWindowMs = window;
    this.#maxFramesPerSecond = options.maxFramesPerSecond ?? OBSERVER_MAX_FRAMES_PER_SECOND;
    this.#payloadBudgetBytes = options.payloadBudgetBytes ?? OBSERVER_FRAME_BUDGET_BYTES;
    this.#maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
  }

  /** Accepts a frame. Never throws; the caller is on the Pi event hot path. */
  push(draft: ObserverFrameDraft): void {
    const chunk = readChunkIdentity(draft.payload);
    if (chunk) {
      this.#pushChunk(draft, chunk);
      return;
    }
    // Anything non-coalescable ends the ordering window: flush the turn's open
    // text first so Desktop renders tool calls after the prose that led to them.
    this.#flushTurn(draft.turnId);
    this.#enqueue(this.#guardToolStatus(draft));
  }

  /**
   * Releases coalesced frames and waits for the queue to drain.
   *
   * Called on turn boundaries and shutdown, where a slightly bursty second is
   * cheaper than a transcript that stops mid-sentence.
   */
  async flush(): Promise<void> {
    for (const key of [...this.#pending.keys()]) this.#releaseChunk(key);
    this.#pump();
    if (this.#queue.length === 0) return;
    await new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  /** Cancels pending timers. Coalesced frames are released first. */
  stop(): void {
    for (const key of [...this.#pending.keys()]) this.#releaseChunk(key);
    this.#pump();
    this.#cancelPumpTimer?.();
    this.#cancelPumpTimer = null;
  }

  /** Forgets a turn's tool bookkeeping once it can no longer receive frames. */
  forgetTurn(turnId: string | null): void {
    this.#flushTurn(turnId);
    const prefix = `${turnId ?? ""}|`;
    for (const key of [...this.#toolStatus.keys()]) {
      if (key.startsWith(prefix)) this.#toolStatus.delete(key);
    }
  }

  #pushChunk(draft: ObserverFrameDraft, identity: ChunkIdentity): void {
    const key = chunkKey(draft, identity);
    // A different message in the same turn means the previous one is finished;
    // release it now so the two never interleave in the feed.
    for (const [openKey, open] of this.#pending) {
      if (open.route.turnId === draft.turnId && openKey !== key) this.#releaseChunk(openKey);
    }
    const existing = this.#pending.get(key);
    if (existing) {
      existing.identity = { ...existing.identity, text: existing.identity.text + identity.text };
      return;
    }
    const cancelTimer = this.#clock.setTimeout(
      () => this.#releaseChunk(key),
      this.#coalesceWindowMs,
    );
    this.#pending.set(key, { route: draft, identity, cancelTimer });
  }

  #releaseChunk(key: string): void {
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    pending.cancelTimer();
    this.#enqueue({ ...pending.route, payload: chunkFrameOf(pending.identity).payload });
  }

  #flushTurn(turnId: string | null): void {
    for (const [key, pending] of [...this.#pending]) {
      if (pending.route.turnId === turnId) this.#releaseChunk(key);
    }
  }

  /**
   * Keeps a terminal tool status terminal.
   *
   * Pi can emit a buffered progress update after a tool has already ended;
   * letting that reach the wire would contradict the transcript Desktop has
   * already committed to, so the status is rewritten rather than the frame
   * dropped — the progress text is still worth showing.
   */
  #guardToolStatus(draft: ObserverFrameDraft): ObserverFrameDraft {
    const identity = readToolFrameIdentity(draft.payload);
    if (!identity) return draft;
    const key = `${draft.turnId ?? ""}|${identity.toolCallId}`;
    const previous = this.#toolStatus.get(key);
    const merged = previous ? mergeToolStatus(previous, identity.status) : identity.status;
    this.#toolStatus.set(key, merged);
    if (merged === identity.status) return draft;
    return { ...draft, payload: withToolStatus(draft.payload, merged) };
  }

  #enqueue(draft: ObserverFrameDraft): void {
    for (const payload of splitFramePayload(draft.payload, this.#payloadBudgetBytes)) {
      if (this.#queue.length >= this.#maxQueuedFrames) {
        this.#droppedFrames += 1;
        this.#lastDropRoute = draft;
        continue;
      }
      this.#queue.push({ ...draft, payload });
    }
    this.#pump();
  }

  #pump(): void {
    const now = this.#clock.now();
    if (now - this.#windowStartMs >= RATE_WINDOW_MS) {
      this.#windowStartMs = now;
      this.#windowCount = 0;
    }
    while (this.#queue.length > 0 && this.#windowCount < this.#maxFramesPerSecond) {
      const draft = this.#queue.shift() as ObserverFrameDraft;
      this.#windowCount += 1;
      this.#emitFrame(draft);
    }

    if (this.#queue.length === 0 && this.#droppedFrames > 0) {
      this.#reportOverflow();
      return;
    }
    if (this.#queue.length > 0) {
      this.#schedulePump(this.#windowStartMs + RATE_WINDOW_MS - now);
      return;
    }
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #schedulePump(delayMs: number): void {
    if (this.#cancelPumpTimer) return;
    this.#cancelPumpTimer = this.#clock.setTimeout(() => {
      this.#cancelPumpTimer = null;
      this.#pump();
    }, Math.max(1, delayMs));
  }

  /**
   * Surfaces shed frames instead of losing them silently.
   *
   * Emitted only once the queue has drained, so the diagnostic itself can never
   * be the frame that overflows.
   */
  #reportOverflow(): void {
    const dropped = this.#droppedFrames;
    const route = this.#lastDropRoute;
    this.#droppedFrames = 0;
    this.#lastDropRoute = null;
    if (route) {
      const plural = dropped === 1 ? "" : "s";
      this.#queue.push({
        ...route,
        ...diagnosticFrame({
          type: "observer_overflow",
          title: "Telemetry overflow",
          text:
            `${dropped} telemetry frame${plural} were shed because the local ` +
            `queue exceeded ${this.#maxQueuedFrames} frames.`,
        }),
      });
    }
    this.#pump();
  }
}

function chunkKey(draft: ObserverFrameDraft, identity: ChunkIdentity): string {
  return `${draft.turnId ?? ""}|${identity.sessionUpdate}|${identity.messageId}`;
}
