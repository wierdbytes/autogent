import { describe, expect, it } from "vitest";
import { PiEventRouter, extractUsage, extractVisibleText } from "../src/runtime/pi-event-router.js";

/** Shapes taken from the Pi SDK's `AgentSessionEvent` union (v0.83). */
function assistantMessage(blocks: unknown[], usage?: unknown) {
  return { id: "msg-1", role: "assistant", content: blocks, ...(usage ? { usage } : {}) };
}

describe("visible text extraction", () => {
  it("keeps only text blocks, in order", () => {
    const text = extractVisibleText(
      assistantMessage([
        { type: "text", text: "Hello " },
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "world" },
      ]),
    );
    expect(text).toBe("Hello world");
  });

  it("returns nothing for a tool-only message", () => {
    const text = extractVisibleText(
      assistantMessage([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }]),
    );
    expect(text).toBe("");
  });

  it("never surfaces thinking content", () => {
    const text = extractVisibleText(
      assistantMessage([{ type: "thinking", thinking: "do not publish this" }]),
    );
    expect(text).toBe("");
    expect(text).not.toContain("do not publish");
  });

  it("tolerates a plain string content field", () => {
    expect(extractVisibleText({ role: "assistant", content: "direct" })).toBe("direct");
  });
});

describe("usage extraction", () => {
  it("reads provider counters without synthesising a total", () => {
    const usage = extractUsage(
      assistantMessage([], {
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 1,
        totalTokens: 126,
        cost: { total: 0.5 },
      }),
    );
    expect(usage).toEqual({
      input: 100,
      output: 20,
      total: 126,
      cacheRead: 5,
      cacheWrite: 1,
      costUsd: 0.5,
    });
  });

  it("returns null when the provider reported nothing", () => {
    expect(extractUsage(assistantMessage([]))).toBeNull();
  });

  it("nulls individual counters the provider omitted", () => {
    const usage = extractUsage(assistantMessage([], { input: 10 }));
    expect(usage).toEqual({
      input: 10,
      output: null,
      total: null,
      cacheRead: null,
      cacheWrite: null,
      costUsd: null,
    });
  });
});

describe("event translation", () => {
  it("gives every delta of one message the same id", () => {
    const router = new PiEventRouter();
    router.translate({ type: "message_start", message: { id: "msg-7", role: "assistant" } });
    const first = router.translate({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "a" },
      message: {},
    });
    const second = router.translate({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "b" },
      message: {},
    });
    expect(first[0]).toEqual({ type: "text_delta", messageId: "msg-7", delta: "a" });
    expect(second[0]).toEqual({ type: "text_delta", messageId: "msg-7", delta: "b" });
  });

  it("distinguishes thinking deltas from text deltas", () => {
    const router = new PiEventRouter();
    const [event] = router.translate({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
      message: {},
    });
    expect(event?.type).toBe("thinking_delta");
  });

  it("drops partial tool-call argument streams", () => {
    const router = new PiEventRouter();
    expect(
      router.translate({
        type: "message_update",
        assistantMessageEvent: { type: "tool_call", id: "t1", name: "bash", arguments: {} },
        message: {},
      }),
    ).toEqual([]);
  });

  it("normalises the tool execution lifecycle", () => {
    const router = new PiEventRouter();
    expect(
      router.translate({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "t1",
        input: { command: "ls" },
      })[0],
    ).toEqual({ type: "tool_start", toolCallId: "t1", toolName: "bash", input: { command: "ls" } });

    expect(
      router.translate({
        type: "tool_execution_end",
        toolCallId: "t1",
        isError: false,
        result: { content: [{ type: "text", text: "file.txt" }] },
      })[0],
    ).toEqual({ type: "tool_end", toolCallId: "t1", isError: false, output: "file.txt" });
  });

  it("separates agent_end from agent_settled", () => {
    const router = new PiEventRouter();
    expect(router.translate({ type: "agent_end", willRetry: true })[0]).toEqual({
      type: "agent_end",
      willRetry: true,
    });
    expect(router.translate({ type: "agent_settled" })[0]).toEqual({ type: "agent_settled" });
  });

  it("surfaces unknown SDK events as bounded diagnostics rather than dropping them", () => {
    const router = new PiEventRouter();
    const [event] = router.translate({ type: "queue_update", steering: [], followUp: [] });
    expect(event?.type).toBe("diagnostic");
    expect((event as { source: string }).source).toBe("queue_update");
  });

  it("emits message_end with the assistant role and complete text", () => {
    const router = new PiEventRouter();
    const [event] = router.translate({
      type: "message_end",
      message: assistantMessage([
        { type: "text", text: "final " },
        { type: "text", text: "answer" },
      ]),
    });
    expect(event).toMatchObject({
      type: "message_end",
      messageId: "msg-1",
      role: "assistant",
      text: "final answer",
    });
  });

  it("marks non-assistant messages so they cannot become chat output", () => {
    const router = new PiEventRouter();
    const [event] = router.translate({
      type: "message_end",
      message: { id: "u1", role: "user", content: [{ type: "text", text: "user text" }] },
    });
    expect((event as { role: string }).role).toBe("user");
  });
});
