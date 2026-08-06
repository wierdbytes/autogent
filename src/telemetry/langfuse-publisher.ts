/**
 * Langfuse trace exporter (tracing plan §3, §6, §7).
 *
 * One trace per turn: a root `agent` observation carrying the Nostr identity of
 * the turn, a `generation` per assistant message with usage and cost, a `tool`
 * span per tool call, and zero-length events for retries, compactions and
 * steering input.
 *
 * Two deliberate structural choices:
 *
 * - The `TracerProvider` is private. autogent is not an OTel application; a
 *   globally registered provider would leak into the pi SDK and into any
 *   library that happens to call `trace.getTracer()`. Every span is therefore
 *   created with an explicit parent context rooted at `ROOT_CONTEXT` and with
 *   explicit `startTime`/`endTime` taken from the injected clock — no ambient
 *   context, no wall-clock reads hidden inside the SDK.
 * - Langfuse semantics are expressed as raw OTel attributes, in exactly the
 *   encoding `@langfuse/tracing`'s `createObservationAttributes` produces
 *   (JSON for structured values, one flattened attribute per metadata key), so
 *   `LangfuseSpanProcessor` ingests our spans as if they came from the SDK's
 *   own `startObservation()`.
 *
 * Nothing here may ever fail a turn: every public method is wrapped, errors are
 * counted and rate-limit-logged, and the live observation count is capped.
 */

import { createHash } from "node:crypto";
import { ROOT_CONTEXT, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import { AlwaysOnSampler, BasicTracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseOtelSpanAttributes as LF } from "@langfuse/tracing";
import { npubEncode } from "nostr-tools/nip19";

import type { LangfuseConfig } from "../config.js";
import { nullLogger } from "../runtime/logger.js";
import type {
  Clock,
  Logger,
  PiEvent,
  PiUsage,
  TelemetryTurnRoute,
  TracingPort,
  TracingTurnInfo,
} from "../runtime/ports.js";
import type { LangfuseCredentials } from "../runtime/provider-auth.js";
import {
  MAX_TOOL_PAYLOAD_BYTES,
  capturePolicy,
  shapeContent,
  type CapturePolicy,
} from "./langfuse-capture.js";

/**
 * The scope name Langfuse's default `shouldExportSpan` filter recognises
 * (`LANGFUSE_TRACER_NAME` in `@langfuse/core`). Hard-coded rather than imported
 * because `@langfuse/core` is a transitive dependency and must not become a
 * direct import; the processor silently drops spans from any other scope.
 */
const LANGFUSE_TRACER_NAME = "langfuse-sdk";

/** Langfuse observation types we emit (`langfuse.observation.type`). */
type ObservationType = "agent" | "generation" | "tool" | "event";

/**
 * Hard ceiling on live observation nodes (open root spans plus open tool
 * spans), plan §7. A wedged turn or a runaway tool loop must cost memory, not
 * the process.
 */
const MAX_LIVE_OBSERVATIONS = 5_000;

/** Minimum gap between export-failure warnings, so a broken host cannot spam. */
const WARN_INTERVAL_MS = 30_000;

/** Retained system-prompt fingerprints, keyed by pi session. */
const MAX_SYSTEM_PROMPT_KEYS = 256;

export interface LangfusePublisherOptions {
  config: LangfuseConfig;
  credentials: LangfuseCredentials;
  relayId: string;
  /** Environment label when `config.environment` is unset: "remote" | "local". */
  defaultEnvironment: string;
  clock: Clock;
  logger?: Logger;
  /** Test seam: replaces the real `LangfuseSpanProcessor`. */
  spanProcessorFactory?: () => SpanProcessor;
}

interface ToolSpanState {
  span: Span;
  toolName: string;
}

interface TurnTrace {
  root: Span;
  /** Parent context for every child observation of this turn. */
  parent: Context;
  model: string | undefined;
  /**
   * End of the last completed step (turn start, last `message_end`, last
   * `tool_end`). A generation has no start event of its own, so this boundary
   * is what gives it a duration instead of a zero-width blip.
   */
  lastBoundaryMs: number;
  tools: Map<string, ToolSpanState>;
  /** Accumulated `thinking_delta` text, keyed by message id. */
  thinking: Map<string, string>;
}

export class LangfusePublisher implements TracingPort {
  #config: LangfuseConfig;
  #credentials: LangfuseCredentials;
  #policy: CapturePolicy;
  readonly #relayId: string;
  readonly #defaultEnvironment: string;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #spanProcessorFactory: () => SpanProcessor;

  #processor: SpanProcessor;
  #provider: BasicTracerProvider;
  #tracer: ReturnType<BasicTracerProvider["getTracer"]>;

  readonly #turns = new Map<string, TurnTrace>();
  /** sha256 of the last full system prompt sent, per pi session. */
  readonly #systemPrompts = new Map<string, string>();
  #liveNodes = 0;
  #capWarned = false;
  #failures = 0;
  #lastWarnMs = Number.NEGATIVE_INFINITY;
  #stopped = false;

  constructor(options: LangfusePublisherOptions) {
    this.#config = options.config;
    this.#credentials = options.credentials;
    this.#policy = capturePolicy(options.config.privacy);
    this.#relayId = options.relayId;
    this.#defaultEnvironment = options.defaultEnvironment;
    this.#clock = options.clock;
    this.#logger = options.logger ?? nullLogger;
    this.#spanProcessorFactory = options.spanProcessorFactory ?? (() => this.#createLangfuseProcessor());

    this.#processor = this.#spanProcessorFactory();
    this.#provider = this.#createProvider(this.#processor);
    this.#tracer = this.#provider.getTracer(LANGFUSE_TRACER_NAME);
  }

  /* ------------------------------------------------------------------ */
  /* Port surface                                                        */
  /* ------------------------------------------------------------------ */

  turnStarted(route: TelemetryTurnRoute, info: TracingTurnInfo): void {
    this.#guard("turnStarted", () => {
      if (this.#stopped || this.#turns.has(route.turnId)) return;
      // Sampling is decided once, here: an unsampled turn is never registered,
      // so every later event for it falls through the `#turns` lookup and is
      // ignored without any further work (plan §7).
      if (!this.#sampled(route.turnId)) return;
      if (!this.#reserveNode()) return;

      const startedAtMs = this.#clock.now();
      const environment = this.#environment();
      const npub = toNpub(info.authorPubkey);

      const metadata: Record<string, unknown> = {
        relay_id: this.#relayId,
        channel_id: route.channelId,
        channel_type: info.channelType,
        channel_name: info.channelName,
        author_npub: npub,
        triggering_event_ids: info.triggeringEventIds,
        pi_session_id: route.sessionId,
        turn_id: route.turnId,
        model: info.model,
      };
      this.#applySystemPrompt(metadata, route.sessionId, info.systemPrompt);

      const attributes: Attributes = {
        [LF.OBSERVATION_TYPE]: "agent" satisfies ObservationType,
        [LF.ENVIRONMENT]: environment,
        [LF.TRACE_NAME]: "turn",
        // The channel is the conversation: it outlives session rotation, so it
        // is the only grouping key that keeps a thread together in Langfuse.
        [LF.TRACE_SESSION_ID]: `${this.#relayId}:${route.channelId ?? "unknown"}`,
        [LF.TRACE_TAGS]: [info.channelType, this.#relayId],
        ...(npub === null ? {} : { [LF.TRACE_USER_ID]: npub }),
        // Both prefixes: trace-level metadata is what Langfuse filters and
        // groups on, observation-level keeps the root span self-describing.
        ...metadataAttributes(LF.TRACE_METADATA, metadata),
        ...metadataAttributes(LF.OBSERVATION_METADATA, metadata),
      };

      if (this.#policy.conversation) {
        const prompt = shapeContent(info.prompt);
        attributes[LF.OBSERVATION_INPUT] = prompt;
        attributes[LF.TRACE_INPUT] = prompt;
      }

      // ROOT_CONTEXT, never `context.active()`: this trace's parentage comes
      // from our own bookkeeping, not from whatever context pi happens to run
      // the turn in.
      const root = this.#startSpan("agent", startedAtMs, attributes, ROOT_CONTEXT);
      this.#turns.set(route.turnId, {
        root,
        parent: trace.setSpan(ROOT_CONTEXT, root),
        model: info.model,
        lastBoundaryMs: startedAtMs,
        tools: new Map(),
        thinking: new Map(),
      });
    });
  }

  event(turnId: string, event: PiEvent): void {
    this.#guard("event", () => {
      const turn = this.#turns.get(turnId);
      if (!turn) return;
      switch (event.type) {
        case "thinking_delta":
          // Buffered even when the preset forbids sending it: the branch that
          // decides is `#endGeneration`, so there is exactly one gate.
          if (this.#policy.thinking) {
            turn.thinking.set(event.messageId, (turn.thinking.get(event.messageId) ?? "") + event.delta);
          }
          return;
        case "message_end":
          if (event.role !== "assistant") return;
          this.#endGeneration(turn, event);
          return;
        case "tool_start":
          this.#startTool(turn, event);
          return;
        case "tool_end":
          this.#endTool(turn, event);
          return;
        case "retry":
          this.#emitEvent(turn, "retry", {
            attempt: event.attempt,
            max_attempts: event.maxAttempts,
            error_message: shapeContent(event.errorMessage),
          });
          return;
        case "compaction":
          this.#emitEvent(turn, `compaction:${event.phase}`, {
            phase: event.phase,
            reason: event.reason,
          });
          return;
        default:
          // Streaming deltas and lifecycle markers add no trace signal: the
          // full text arrives with `message_end`, timings with the spans.
          return;
      }
    });
  }

  steering(turnId: string, text: string, authorPubkey: string): void {
    this.#guard("steering", () => {
      const turn = this.#turns.get(turnId);
      if (!turn) return;
      this.#emitEvent(
        turn,
        "steering",
        { author_npub: toNpub(authorPubkey) },
        this.#policy.conversation ? shapeContent(text) : undefined,
      );
    });
  }

  turnFinished(turnId: string, outcome: { stopReason: string; finalText: string | null }): void {
    this.#guard("turnFinished", () => {
      const turn = this.#turns.get(turnId);
      if (!turn) return;
      this.#closeTurn(turn, outcome);
      this.#turns.delete(turnId);
    });
    this.#reportFailures();
  }

  async flush(): Promise<void> {
    try {
      await this.#processor.forceFlush();
    } catch (error) {
      this.#onFailure("flush", error);
    }
  }

  async shutdown(budgetMs: number): Promise<void> {
    try {
      this.#stopped = true;
      // Anything still running dies with the process; close it as interrupted
      // so the trace shows where it stopped instead of hanging open forever.
      for (const [turnId, turn] of [...this.#turns]) {
        this.#closeTurn(turn, { stopReason: "shutdown", finalText: null });
        this.#turns.delete(turnId);
      }
      const done = this.#provider.shutdown().catch((error: unknown) => {
        this.#onFailure("shutdown", error);
      });
      // The k8s grace budget outranks the tail of a trace batch (plan §7): on
      // timeout we simply return and let the process exit. The timer is
      // cancelled either way, so a fast export never leaves the event loop
      // held open by the budget.
      let cancelBudget = () => {};
      const budget = new Promise<void>((resolve) => {
        cancelBudget = this.#clock.setTimeout(resolve, Math.max(0, budgetMs));
      });
      try {
        await Promise.race([done, budget]);
      } finally {
        cancelBudget();
      }
    } catch (error) {
      this.#onFailure("shutdown", error);
    }
  }

  /**
   * Applies a live config change (tracing plan §5.3).
   *
   * Privacy and sample rate are pure policy and swap in place. A new host or a
   * new key pair means the current processor is talking to the wrong project,
   * so the whole pipeline is rebuilt; open turns are closed first, because
   * their spans belong to the outgoing processor.
   *
   * Turning tracing *off* is not handled here: the caller swaps the port for a
   * no-op one instead.
   */
  reconfigure(next: { config: LangfuseConfig; credentials: LangfuseCredentials }): void {
    this.#guard("reconfigure", () => {
      const pipelineChanged =
        next.config.host !== this.#config.host ||
        next.credentials.publicKey !== this.#credentials.publicKey ||
        next.credentials.secretKey !== this.#credentials.secretKey ||
        (next.config.environment ?? this.#defaultEnvironment) !== this.#environment();

      this.#config = next.config;
      this.#credentials = next.credentials;
      this.#policy = capturePolicy(next.config.privacy);
      if (!pipelineChanged) return;

      for (const [turnId, turn] of [...this.#turns]) {
        this.#closeTurn(turn, { stopReason: "reconfigure", finalText: null });
        this.#turns.delete(turnId);
      }
      const previous = this.#processor;
      this.#processor = this.#spanProcessorFactory();
      this.#provider = this.#createProvider(this.#processor);
      this.#tracer = this.#provider.getTracer(LANGFUSE_TRACER_NAME);
      // Fire-and-forget: draining the old batch must not block a config push.
      void Promise.resolve(previous.shutdown()).catch((error: unknown) => {
        this.#onFailure("reconfigure-shutdown", error);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Observations                                                        */
  /* ------------------------------------------------------------------ */

  #endGeneration(turn: TurnTrace, event: Extract<PiEvent, { type: "message_end" }>): void {
    const endMs = this.#clock.now();
    const metadata: Record<string, unknown> = { message_id: event.messageId };
    const thinking = turn.thinking.get(event.messageId);
    turn.thinking.delete(event.messageId);
    if (this.#policy.thinking && thinking) metadata["thinking"] = shapeContent(thinking);

    const attributes: Attributes = {
      [LF.OBSERVATION_TYPE]: "generation" satisfies ObservationType,
      [LF.ENVIRONMENT]: this.#environment(),
      ...(turn.model === undefined ? {} : { [LF.OBSERVATION_MODEL]: turn.model }),
      ...usageAttributes(event.usage),
      ...metadataAttributes(LF.OBSERVATION_METADATA, metadata),
    };
    if (this.#policy.conversation && event.text) {
      attributes[LF.OBSERVATION_OUTPUT] = shapeContent(event.text);
    }

    // The generation spans from the previous step boundary to now: that is the
    // window the model actually occupied.
    const span = this.#tracer.startSpan(
      "generation",
      { startTime: turn.lastBoundaryMs, attributes },
      turn.parent,
    );
    span.end(endMs);
    turn.lastBoundaryMs = endMs;
  }

  #startTool(turn: TurnTrace, event: Extract<PiEvent, { type: "tool_start" }>): void {
    if (turn.tools.has(event.toolCallId)) return;
    if (!this.#reserveNode()) return;

    const attributes: Attributes = {
      [LF.OBSERVATION_TYPE]: "tool" satisfies ObservationType,
      [LF.ENVIRONMENT]: this.#environment(),
      ...metadataAttributes(LF.OBSERVATION_METADATA, {
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
      }),
    };
    if (this.#policy.toolPayloads) {
      attributes[LF.OBSERVATION_INPUT] = shapeContent(safeJson(event.input), MAX_TOOL_PAYLOAD_BYTES);
    }
    const span = this.#startSpan(`tool:${event.toolName}`, this.#clock.now(), attributes, turn.parent);
    turn.tools.set(event.toolCallId, { span, toolName: event.toolName });
  }

  #endTool(turn: TurnTrace, event: Extract<PiEvent, { type: "tool_end" }>): void {
    const tool = turn.tools.get(event.toolCallId);
    if (!tool) return;
    turn.tools.delete(event.toolCallId);

    const endMs = this.#clock.now();
    const attributes: Attributes = {};
    if (this.#policy.toolPayloads && event.output) {
      attributes[LF.OBSERVATION_OUTPUT] = shapeContent(event.output, MAX_TOOL_PAYLOAD_BYTES);
    }
    // The failure flag is shape, not content: it ships at every preset.
    if (event.isError) {
      attributes[LF.OBSERVATION_LEVEL] = "ERROR";
      attributes[LF.OBSERVATION_STATUS_MESSAGE] = `tool ${tool.toolName} failed`;
    }
    tool.span.setAttributes(attributes);
    tool.span.end(endMs);
    turn.lastBoundaryMs = endMs;
    this.#releaseNode();
  }

  /** Zero-length observation: `startTime === endTime`, as Langfuse events are. */
  #emitEvent(
    turn: TurnTrace,
    name: string,
    metadata: Record<string, unknown>,
    input?: string,
  ): void {
    const at = this.#clock.now();
    const attributes: Attributes = {
      [LF.OBSERVATION_TYPE]: "event" satisfies ObservationType,
      [LF.ENVIRONMENT]: this.#environment(),
      ...metadataAttributes(LF.OBSERVATION_METADATA, metadata),
      ...(input === undefined ? {} : { [LF.OBSERVATION_INPUT]: input }),
    };
    const span = this.#tracer.startSpan(name, { startTime: at, attributes }, turn.parent);
    span.end(at);
  }

  #closeTurn(turn: TurnTrace, outcome: { stopReason: string; finalText: string | null }): void {
    const endMs = this.#clock.now();
    for (const [, tool] of turn.tools) {
      // Aborted, idle-timed-out or shut down mid-call: mark the observation
      // incomplete rather than letting it look like a successful tool run.
      tool.span.setAttributes({
        [LF.OBSERVATION_LEVEL]: "ERROR",
        [LF.OBSERVATION_STATUS_MESSAGE]: outcome.stopReason,
        ...metadataAttributes(LF.OBSERVATION_METADATA, { completed: false }),
      });
      tool.span.end(endMs);
      this.#releaseNode();
    }
    turn.tools.clear();

    const attributes: Attributes = {
      ...metadataAttributes(LF.TRACE_METADATA, { stop_reason: outcome.stopReason }),
      ...metadataAttributes(LF.OBSERVATION_METADATA, { stop_reason: outcome.stopReason }),
    };
    if (outcome.stopReason !== "end_turn") {
      attributes[LF.OBSERVATION_LEVEL] = "ERROR";
      attributes[LF.OBSERVATION_STATUS_MESSAGE] = outcome.stopReason;
    }
    if (this.#policy.conversation && outcome.finalText !== null) {
      const output = shapeContent(outcome.finalText);
      attributes[LF.OBSERVATION_OUTPUT] = output;
      attributes[LF.TRACE_OUTPUT] = output;
    }
    turn.root.setAttributes(attributes);
    turn.root.end(endMs);
    this.#releaseNode();
  }

  /* ------------------------------------------------------------------ */
  /* Policy helpers                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Adds the system prompt at preset `full`, but only once per pi session: it
   * is multi-kilobyte and identical across the session's turns, so repeats
   * carry a hash reference to the last full copy instead (plan §6).
   */
  #applySystemPrompt(
    metadata: Record<string, unknown>,
    sessionId: string | null,
    systemPrompt: string | undefined,
  ): void {
    if (!this.#policy.systemPrompt || !systemPrompt) return;
    const digest = sha256Hex(systemPrompt);
    metadata["system_prompt_ref"] = `sha256:${digest}`;
    const key = sessionId ?? "__unscoped__";
    if (this.#systemPrompts.get(key) === digest) return;
    metadata["system_prompt"] = shapeContent(systemPrompt);
    if (this.#systemPrompts.size >= MAX_SYSTEM_PROMPT_KEYS) {
      const oldest = this.#systemPrompts.keys().next();
      if (!oldest.done) this.#systemPrompts.delete(oldest.value);
    }
    this.#systemPrompts.set(key, digest);
  }

  /**
   * Deterministic per-turn sampling: the first 8 bytes of sha256(turnId) as a
   * fraction of 2^64. Keying off the turn id (never a random draw) keeps a
   * retried or replayed turn on the same side of the decision.
   */
  #sampled(turnId: string): boolean {
    const rate = this.#config.sampleRate;
    if (!Number.isFinite(rate) || rate <= 0) return false;
    if (rate >= 1) return true;
    const digest = createHash("sha256").update(turnId, "utf8").digest();
    return Number(digest.readBigUInt64BE(0)) / 2 ** 64 < rate;
  }

  #environment(): string {
    return this.#config.environment ?? this.#defaultEnvironment;
  }

  /* ------------------------------------------------------------------ */
  /* Plumbing                                                            */
  /* ------------------------------------------------------------------ */

  #createLangfuseProcessor(): SpanProcessor {
    return new LangfuseSpanProcessor({
      publicKey: this.#credentials.publicKey,
      secretKey: this.#credentials.secretKey,
      baseUrl: this.#config.host,
      environment: this.#environment(),
    });
  }

  #createProvider(processor: SpanProcessor): BasicTracerProvider {
    return new BasicTracerProvider({
      spanProcessors: [processor],
      // Sampling is ours (`#sampled`); pinning the sampler keeps a stray
      // OTEL_TRACES_SAMPLER in the environment from silently dropping spans we
      // already decided to keep.
      sampler: new AlwaysOnSampler(),
    });
  }

  /**
   * Starts a span against a reserved node, giving the reservation back if the
   * processor blows up on `onStart` — a failing exporter must not slowly leak
   * the whole backpressure budget.
   */
  #startSpan(name: string, startTime: number, attributes: Attributes, parent: Context): Span {
    try {
      return this.#tracer.startSpan(name, { startTime, attributes }, parent);
    } catch (error) {
      this.#releaseNode();
      throw error;
    }
  }

  #reserveNode(): boolean {
    if (this.#liveNodes >= MAX_LIVE_OBSERVATIONS) {
      if (!this.#capWarned) {
        this.#capWarned = true;
        this.#logger.warn("langfuse tracing at live-observation cap; dropping new observations", {
          cap: MAX_LIVE_OBSERVATIONS,
        });
      }
      return false;
    }
    this.#liveNodes += 1;
    return true;
  }

  #releaseNode(): void {
    if (this.#liveNodes > 0) this.#liveNodes -= 1;
    if (this.#liveNodes < MAX_LIVE_OBSERVATIONS) this.#capWarned = false;
  }

  #guard(scope: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.#onFailure(scope, error);
    }
  }

  #onFailure(scope: string, error: unknown): void {
    this.#failures += 1;
    const now = this.#clock.now();
    if (now - this.#lastWarnMs < WARN_INTERVAL_MS) return;
    this.#lastWarnMs = now;
    this.#logger.warn("langfuse tracing failed", { scope, error: String(error) });
  }

  /** Drop accounting, reported at settle so a silent failure cannot hide. */
  #reportFailures(): void {
    if (this.#failures === 0) return;
    const failures = this.#failures;
    this.#failures = 0;
    this.#logger.warn("langfuse tracing errors since last turn", { failures });
  }
}

/* -------------------------------------------------------------------------- */
/* Attribute encoding                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `_serialize` in `@langfuse/tracing`: strings pass through untouched,
 * everything else becomes JSON, null and undefined drop the attribute.
 */
function serializeAttribute(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "<failed to serialize>";
  }
}

/**
 * Mirrors `_flattenAndSerializeMetadata`: one attribute per key, prefixed with
 * `langfuse.{trace,observation}.metadata`. Langfuse reassembles the object on
 * ingest; a single JSON blob would not be filterable.
 */
function metadataAttributes(prefix: string, metadata: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(metadata)) {
    const serialized = serializeAttribute(value);
    if (serialized) attributes[`${prefix}.${key}`] = serialized;
  }
  return attributes;
}

/** `PiUsage` → Langfuse `usageDetails`/`costDetails`; unknown counters are omitted. */
function usageAttributes(usage: PiUsage | null): Attributes {
  if (usage === null) return {};
  const attributes: Attributes = {};
  const details: Record<string, number> = {};
  if (usage.input !== null) details["input"] = usage.input;
  if (usage.output !== null) details["output"] = usage.output;
  if (usage.cacheRead !== null) details["cache_read"] = usage.cacheRead;
  if (usage.cacheWrite !== null) details["cache_write"] = usage.cacheWrite;
  if (Object.keys(details).length > 0) {
    attributes[LF.OBSERVATION_USAGE_DETAILS] = JSON.stringify(details);
  }
  if (usage.costUsd !== null) {
    attributes[LF.OBSERVATION_COST_DETAILS] = JSON.stringify({ total: usage.costUsd });
  }
  return attributes;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "<failed to serialize>";
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A malformed pubkey must not cost a trace; it just loses its `user.id`. */
function toNpub(pubkey: string): string | null {
  try {
    return npubEncode(pubkey);
  } catch {
    return null;
  }
}
