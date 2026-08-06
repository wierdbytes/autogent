import { describe, expect, it } from "vitest";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { npubEncode } from "nostr-tools/nip19";
import type { LangfuseConfig, LangfusePrivacyPreset } from "../src/config.js";
import { FakeClock } from "../src/runtime/clock.js";
import type { Logger, PiEvent, TelemetryTurnRoute, TracingTurnInfo } from "../src/runtime/ports.js";
import { LangfusePublisher } from "../src/telemetry/langfuse-publisher.js";

const AUTHOR = "a".repeat(63) + "1";
const AUTHOR_NPUB = npubEncode(AUTHOR);

/** Attribute names, spelled out so a rename in the enum shows up as a failure. */
const A = {
  type: "langfuse.observation.type",
  level: "langfuse.observation.level",
  status: "langfuse.observation.status_message",
  input: "langfuse.observation.input",
  output: "langfuse.observation.output",
  model: "langfuse.observation.model.name",
  usage: "langfuse.observation.usage_details",
  cost: "langfuse.observation.cost_details",
  meta: "langfuse.observation.metadata",
  traceMeta: "langfuse.trace.metadata",
  traceName: "langfuse.trace.name",
  traceInput: "langfuse.trace.input",
  traceOutput: "langfuse.trace.output",
  tags: "langfuse.trace.tags",
  session: "session.id",
  user: "user.id",
  environment: "langfuse.environment",
} as const;

interface Harness {
  publisher: LangfusePublisher;
  clock: FakeClock;
  spans(): ReadableSpan[];
  warnings: Array<{ message: string; fields?: Record<string, unknown> }>;
  named(name: string): ReadableSpan;
}

function collectingLogger(sink: Harness["warnings"]): Logger {
  const logger: Logger = {
    error: () => {},
    warn: (message, fields) => sink.push({ message, ...(fields ? { fields } : {}) }),
    info: () => {},
    debug: () => {},
    child: () => logger,
  };
  return logger;
}

function harness(
  overrides: Partial<LangfuseConfig> = {},
  processorFactory?: () => SpanProcessor,
): Harness {
  const exporter = recordingExporter();
  const clock = new FakeClock();
  const warnings: Harness["warnings"] = [];
  const publisher = new LangfusePublisher({
    config: {
      enabled: true,
      host: "https://langfuse.test",
      privacy: "conversations",
      sampleRate: 1,
      ...overrides,
    },
    credentials: { publicKey: "pk-lf-test", secretKey: "sk-lf-test" },
    relayId: "default",
    defaultEnvironment: "local",
    clock,
    logger: collectingLogger(warnings),
    spanProcessorFactory: processorFactory ?? (() => new SimpleSpanProcessor(exporter)),
  });
  const spans = () => exporter.getFinishedSpans();
  return {
    publisher,
    clock,
    spans,
    warnings,
    named: (name) => {
      const span = spans().find((candidate) => candidate.name === name);
      if (!span) throw new Error(`no span named ${name}; got ${spans().map((s) => s.name).join(", ")}`);
      return span;
    },
  };
}

/**
 * `InMemorySpanExporter.shutdown()` resets its buffer, which would erase the
 * very spans the shutdown and reconfigure tests need to inspect. Everything
 * else is the stock exporter.
 */
function recordingExporter(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  exporter.shutdown = async () => {};
  return exporter;
}

function route(turnId = "turn-1"): TelemetryTurnRoute {
  return { channelId: "chan-1", sessionId: "sess-1", turnId };
}

function turnInfo(overrides: Partial<TracingTurnInfo> = {}): TracingTurnInfo {
  return {
    channelType: "stream",
    channelName: "#dev",
    authorPubkey: AUTHOR,
    triggeringEventIds: ["e".repeat(64)],
    prompt: "please summarise the repo",
    systemPrompt: "You are a helpful agent.",
    model: "anthropic/claude-sonnet-4",
    ...overrides,
  };
}

const USAGE = {
  input: 120,
  output: 45,
  total: 165,
  cacheRead: 10,
  cacheWrite: null,
  costUsd: 0.0042,
} as const;

function assistantMessage(text = "here is the summary"): PiEvent {
  return { type: "message_end", messageId: "msg-1", role: "assistant", text, usage: { ...USAGE } };
}

/** Runs a complete turn: tool call, assistant message, settle. */
async function playTurn(h: Harness, preset?: LangfusePrivacyPreset): Promise<void> {
  void preset;
  h.publisher.turnStarted(route(), turnInfo());
  await h.clock.advance(100);
  h.publisher.event("turn-1", {
    type: "tool_start",
    toolCallId: "call-1",
    toolName: "read",
    input: { path: "README.md" },
  });
  await h.clock.advance(50);
  h.publisher.event("turn-1", { type: "tool_end", toolCallId: "call-1", isError: false, output: "file body" });
  await h.clock.advance(200);
  h.publisher.event("turn-1", { type: "thinking_delta", messageId: "msg-1", delta: "let me think" });
  h.publisher.event("turn-1", assistantMessage());
  await h.clock.advance(10);
  h.publisher.turnFinished("turn-1", { stopReason: "end_turn", finalText: "here is the summary" });
}

describe("LangfusePublisher trace shape", () => {
  it("builds the root/tool/generation tree with Nostr identity on the root", async () => {
    const h = harness();
    await playTurn(h);

    const names = h.spans().map((span) => span.name).sort();
    expect(names).toEqual(["agent", "generation", "tool:read"]);

    const root = h.named("agent");
    const tool = h.named("tool:read");
    const generation = h.named("generation");

    // One trace, both children parented to the root observation.
    expect(root.parentSpanContext).toBeUndefined();
    expect(tool.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(generation.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(tool.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(generation.spanContext().traceId).toBe(root.spanContext().traceId);

    expect(root.attributes[A.type]).toBe("agent");
    expect(root.attributes[A.traceName]).toBe("turn");
    expect(root.attributes[A.session]).toBe("default:chan-1");
    expect(root.attributes[A.user]).toBe(AUTHOR_NPUB);
    expect(root.attributes[A.tags]).toEqual(["stream", "default"]);
    expect(root.attributes[A.environment]).toBe("local");

    // Nostr metadata: one flattened attribute per key, as @langfuse/tracing
    // encodes it, under both the trace and the observation prefix.
    expect(root.attributes[`${A.traceMeta}.relay_id`]).toBe("default");
    expect(root.attributes[`${A.traceMeta}.channel_id`]).toBe("chan-1");
    expect(root.attributes[`${A.traceMeta}.channel_type`]).toBe("stream");
    expect(root.attributes[`${A.traceMeta}.channel_name`]).toBe("#dev");
    expect(root.attributes[`${A.traceMeta}.author_npub`]).toBe(AUTHOR_NPUB);
    expect(root.attributes[`${A.traceMeta}.triggering_event_ids`]).toBe(JSON.stringify(["e".repeat(64)]));
    expect(root.attributes[`${A.traceMeta}.pi_session_id`]).toBe("sess-1");
    expect(root.attributes[`${A.traceMeta}.turn_id`]).toBe("turn-1");
    expect(root.attributes[`${A.traceMeta}.model`]).toBe("anthropic/claude-sonnet-4");
    expect(root.attributes[`${A.meta}.channel_id`]).toBe("chan-1");
    expect(root.attributes[`${A.traceMeta}.stop_reason`]).toBe("end_turn");
    expect(root.attributes[A.level]).toBeUndefined();

    expect(generation.attributes[A.type]).toBe("generation");
    expect(generation.attributes[A.model]).toBe("anthropic/claude-sonnet-4");
    expect(generation.attributes[A.usage]).toBe(
      JSON.stringify({ input: 120, output: 45, cache_read: 10 }),
    );
    expect(generation.attributes[A.cost]).toBe(JSON.stringify({ total: 0.0042 }));

    expect(tool.attributes[A.type]).toBe("tool");
    expect(tool.attributes[`${A.meta}.tool_name`]).toBe("read");
  });

  it("gives the generation the window between the previous boundary and the message", async () => {
    const h = harness();
    await playTurn(h);
    const tool = h.named("tool:read");
    const generation = h.named("generation");
    const ms = (span: ReadableSpan, which: "startTime" | "endTime"): number =>
      span[which][0] * 1_000 + span[which][1] / 1_000_000;

    // The generation starts where the tool call ended, not at the turn start.
    expect(ms(generation, "startTime")).toBe(ms(tool, "endTime"));
    expect(ms(generation, "endTime") - ms(generation, "startTime")).toBe(200);
  });

  it("records retry, compaction and steering as zero-length events", async () => {
    const h = harness();
    h.publisher.turnStarted(route(), turnInfo());
    await h.clock.advance(10);
    h.publisher.event("turn-1", { type: "retry", attempt: 2, maxAttempts: 5, errorMessage: "overloaded" });
    h.publisher.event("turn-1", { type: "compaction", phase: "start", reason: "context_full" });
    h.publisher.steering("turn-1", "also check the tests", AUTHOR);
    h.publisher.turnFinished("turn-1", { stopReason: "end_turn", finalText: null });

    const retry = h.named("retry");
    expect(retry.attributes[A.type]).toBe("event");
    expect(retry.attributes[`${A.meta}.attempt`]).toBe("2");
    expect(retry.attributes[`${A.meta}.max_attempts`]).toBe("5");
    expect(retry.attributes[`${A.meta}.error_message`]).toBe("overloaded");
    expect(retry.startTime).toEqual(retry.endTime);

    const compaction = h.named("compaction:start");
    expect(compaction.attributes[`${A.meta}.reason`]).toBe("context_full");

    const steering = h.named("steering");
    expect(steering.attributes[`${A.meta}.author_npub`]).toBe(AUTHOR_NPUB);
    expect(steering.attributes[A.input]).toBe("also check the tests");
  });

  it("ignores events for unknown turns", async () => {
    const h = harness();
    h.publisher.event("never-started", assistantMessage());
    h.publisher.steering("never-started", "hi", AUTHOR);
    h.publisher.turnFinished("never-started", { stopReason: "end_turn", finalText: null });
    expect(h.spans()).toHaveLength(0);
  });
});

describe("LangfusePublisher privacy presets", () => {
  it("metadata-only keeps counters and tool names but no content", async () => {
    const h = harness({ privacy: "metadata-only" });
    await playTurn(h);

    const root = h.named("agent");
    const generation = h.named("generation");
    const tool = h.named("tool:read");

    for (const span of [root, generation, tool]) {
      expect(span.attributes[A.input]).toBeUndefined();
      expect(span.attributes[A.output]).toBeUndefined();
    }
    expect(root.attributes[A.traceInput]).toBeUndefined();
    expect(root.attributes[A.traceOutput]).toBeUndefined();
    expect(root.attributes[`${A.meta}.system_prompt`]).toBeUndefined();
    expect(generation.attributes[`${A.meta}.thinking`]).toBeUndefined();
    // Shape still ships.
    expect(generation.attributes[A.usage]).toBeDefined();
    expect(generation.attributes[A.cost]).toBeDefined();
    expect(tool.attributes[`${A.meta}.tool_name`]).toBe("read");
  });

  it("conversations captures prompt and reply only", async () => {
    const h = harness({ privacy: "conversations" });
    await playTurn(h);

    const root = h.named("agent");
    expect(root.attributes[A.input]).toBe("please summarise the repo");
    expect(root.attributes[A.traceInput]).toBe("please summarise the repo");
    expect(root.attributes[A.output]).toBe("here is the summary");
    expect(root.attributes[A.traceOutput]).toBe("here is the summary");
    expect(root.attributes[`${A.meta}.system_prompt`]).toBeUndefined();

    expect(h.named("generation").attributes[A.output]).toBe("here is the summary");
    expect(h.named("generation").attributes[`${A.meta}.thinking`]).toBeUndefined();
    expect(h.named("tool:read").attributes[A.input]).toBeUndefined();
    expect(h.named("tool:read").attributes[A.output]).toBeUndefined();
  });

  it("full captures tool payloads, thinking and the system prompt once per session", async () => {
    const h = harness({ privacy: "full" });
    await playTurn(h);

    const root = h.named("agent");
    expect(root.attributes[`${A.meta}.system_prompt`]).toBe("You are a helpful agent.");
    expect(root.attributes[`${A.meta}.system_prompt_ref`]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h.named("tool:read").attributes[A.input]).toBe(JSON.stringify({ path: "README.md" }));
    expect(h.named("tool:read").attributes[A.output]).toBe("file body");
    expect(h.named("generation").attributes[`${A.meta}.thinking`]).toBe("let me think");

    // Second turn of the same pi session: the multi-kilobyte prompt is replaced
    // by a reference to the copy already in Langfuse.
    h.publisher.turnStarted(route("turn-2"), turnInfo());
    h.publisher.turnFinished("turn-2", { stopReason: "end_turn", finalText: null });
    const second = h.spans().filter((span) => span.name === "agent")[1];
    expect(second?.attributes[`${A.meta}.system_prompt`]).toBeUndefined();
    expect(second?.attributes[`${A.meta}.system_prompt_ref`]).toBe(
      root.attributes[`${A.meta}.system_prompt_ref`],
    );
  });

  it("redacts secrets out of prompt and reply text", async () => {
    const h = harness({ privacy: "conversations" });
    const nsec = `nsec1${"q".repeat(58)}`;
    h.publisher.turnStarted(route(), turnInfo({ prompt: `use ${nsec} to sign` }));
    h.publisher.event("turn-1", assistantMessage(`signed with ${nsec}`));
    h.publisher.turnFinished("turn-1", { stopReason: "end_turn", finalText: `signed with ${nsec}` });

    const root = h.named("agent");
    expect(root.attributes[A.input]).toBe("use [REDACTED] to sign");
    expect(root.attributes[A.traceOutput]).toBe("signed with [REDACTED]");
    expect(h.named("generation").attributes[A.output]).toBe("signed with [REDACTED]");
  });
});

describe("LangfusePublisher failure paths", () => {
  it("marks failed tool calls at ERROR", async () => {
    const h = harness();
    h.publisher.turnStarted(route(), turnInfo());
    h.publisher.event("turn-1", {
      type: "tool_start",
      toolCallId: "call-1",
      toolName: "bash",
      input: {},
    });
    await h.clock.advance(5);
    h.publisher.event("turn-1", {
      type: "tool_end",
      toolCallId: "call-1",
      isError: true,
      output: "exit 1",
    });
    h.publisher.turnFinished("turn-1", { stopReason: "end_turn", finalText: null });

    const tool = h.named("tool:bash");
    expect(tool.attributes[A.level]).toBe("ERROR");
    expect(tool.attributes[A.status]).toBe("tool bash failed");
    expect(h.named("agent").attributes[A.level]).toBeUndefined();
  });

  it("closes an open tool span as incomplete when the turn is cancelled", async () => {
    const h = harness();
    h.publisher.turnStarted(route(), turnInfo());
    h.publisher.event("turn-1", {
      type: "tool_start",
      toolCallId: "call-1",
      toolName: "bash",
      input: {},
    });
    await h.clock.advance(1_000);
    h.publisher.turnFinished("turn-1", { stopReason: "idle_timeout", finalText: null });

    const tool = h.named("tool:bash");
    expect(tool.attributes[`${A.meta}.completed`]).toBe("false");
    expect(tool.attributes[A.status]).toBe("idle_timeout");

    const root = h.named("agent");
    expect(root.attributes[A.level]).toBe("ERROR");
    expect(root.attributes[A.status]).toBe("idle_timeout");
    expect(root.attributes[`${A.meta}.stop_reason`]).toBe("idle_timeout");
  });

  it("closes open turns as interrupted on shutdown", async () => {
    const h = harness();
    h.publisher.turnStarted(route(), turnInfo());
    h.publisher.event("turn-1", {
      type: "tool_start",
      toolCallId: "call-1",
      toolName: "bash",
      input: {},
    });
    await h.publisher.shutdown(5_000);

    expect(h.named("agent").attributes[A.status]).toBe("shutdown");
    expect(h.named("tool:bash").attributes[`${A.meta}.completed`]).toBe("false");
    // Post-shutdown work is ignored, not exported.
    h.publisher.turnStarted(route("turn-2"), turnInfo());
    expect(h.spans().filter((span) => span.name === "agent")).toHaveLength(1);
  });

  it("drops new observations past the live-node cap, with one warning", () => {
    const h = harness();
    // 5000 open roots exhaust the cap (plan §7); the next turn is dropped.
    for (let index = 0; index < 5_000; index++) {
      h.publisher.turnStarted(route(`turn-${index}`), turnInfo());
    }
    h.publisher.turnStarted(route("overflow"), turnInfo());
    h.publisher.turnFinished("overflow", { stopReason: "end_turn", finalText: null });

    expect(h.spans()).toHaveLength(0);
    expect(h.warnings.filter((entry) => entry.message.includes("live-observation cap"))).toHaveLength(1);

    // Closing a turn gives its node back, and tracing resumes.
    h.publisher.turnFinished("turn-0", { stopReason: "end_turn", finalText: null });
    h.publisher.turnStarted(route("after-drain"), turnInfo());
    h.publisher.turnFinished("after-drain", { stopReason: "end_turn", finalText: null });
    expect(h.spans()).toHaveLength(2);
  });

  it("survives a processor that throws from every hook", async () => {
    const broken: SpanProcessor = {
      onStart: () => {
        throw new Error("onStart boom");
      },
      onEnd: () => {
        throw new Error("onEnd boom");
      },
      forceFlush: () => {
        throw new Error("flush boom");
      },
      shutdown: () => {
        throw new Error("shutdown boom");
      },
    };
    const h = harness({}, () => broken);

    expect(() => h.publisher.turnStarted(route(), turnInfo())).not.toThrow();
    expect(() => h.publisher.event("turn-1", assistantMessage())).not.toThrow();
    expect(() => h.publisher.steering("turn-1", "text", AUTHOR)).not.toThrow();
    expect(() =>
      h.publisher.turnFinished("turn-1", { stopReason: "end_turn", finalText: null }),
    ).not.toThrow();
    await expect(h.publisher.flush()).resolves.toBeUndefined();
    await expect(h.publisher.shutdown(10)).resolves.toBeUndefined();
    expect(h.warnings.some((entry) => entry.message.startsWith("langfuse tracing"))).toBe(true);
  });
});

describe("LangfusePublisher sampling", () => {
  it("exports nothing and stays silent at sampleRate 0", async () => {
    const h = harness({ sampleRate: 0 });
    await playTurn(h);
    expect(h.spans()).toHaveLength(0);
    expect(h.warnings).toHaveLength(0);
  });

  it("exports everything at sampleRate 1", async () => {
    const h = harness({ sampleRate: 1 });
    await playTurn(h);
    expect(h.spans()).toHaveLength(3);
  });

  it("decides deterministically from the turn id", async () => {
    const ids = Array.from({ length: 40 }, (_, index) => `turn-${index}`);
    const decisions = (): string[] => {
      const h = harness({ sampleRate: 0.5 });
      for (const id of ids) {
        h.publisher.turnStarted(route(id), turnInfo());
        h.publisher.turnFinished(id, { stopReason: "end_turn", finalText: null });
      }
      return h
        .spans()
        .map((span) => String(span.attributes[`${A.traceMeta}.turn_id`]))
        .sort();
    };
    const first = decisions();
    const second = decisions();

    expect(first).toEqual(second);
    // A half rate must actually split the set, not degenerate to all or none.
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(ids.length);
  });
});

describe("LangfusePublisher reconfigure", () => {
  it("swaps privacy in place without rebuilding the pipeline", async () => {
    const h = harness({ privacy: "metadata-only" });
    h.publisher.reconfigure({
      config: {
        enabled: true,
        host: "https://langfuse.test",
        privacy: "conversations",
        sampleRate: 1,
      },
      credentials: { publicKey: "pk-lf-test", secretKey: "sk-lf-test" },
    });
    await playTurn(h);
    expect(h.named("agent").attributes[A.input]).toBe("please summarise the repo");
  });

  it("rebuilds the pipeline when the host changes, closing open turns", async () => {
    const built: SpanProcessor[] = [];
    const exporter = recordingExporter();
    const h = harness({}, () => {
      const processor = new SimpleSpanProcessor(exporter);
      built.push(processor);
      return processor;
    });
    h.publisher.turnStarted(route(), turnInfo());
    h.publisher.reconfigure({
      config: {
        enabled: true,
        host: "https://other.langfuse.test",
        privacy: "conversations",
        sampleRate: 1,
      },
      credentials: { publicKey: "pk-lf-test", secretKey: "sk-lf-test" },
    });

    expect(built).toHaveLength(2);
    expect(exporter.getFinishedSpans().map((span) => span.attributes[A.status])).toEqual(["reconfigure"]);
  });
});
