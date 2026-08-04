import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUZZ_EVENT_SECTION_PREFIX,
  PROMPT_AUTHOR_HEX_RE,
  PROMPT_EVENT_ID_RE,
  PROMPT_SECTION_HEADER_RE,
  assistantChunkFrame,
  boundValue,
  describeToolOutput,
  frameDraft,
  inspectPrompt,
  mapPiEvent,
  mergeToolStatus,
  promptFrame,
  readChunkIdentity,
  sessionResolvedFrame,
  splitByUtf8Bytes,
  splitFramePayload,
  steerFrame,
  thinkingChunkFrame,
  toolCallFrame,
  toolCallUpdateFrame,
  turnCompletedFrame,
  turnErrorFrame,
  turnLivenessFrame,
  turnStartedFrame,
  usageUpdateFrame,
  utf8ByteLength,
  type TelemetryFrameBody,
} from "../src/telemetry/buzz-desktop-compat.js";
import type { PiEvent } from "../src/runtime/ports.js";

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
  ) as T;

const golden = (name: string): TelemetryFrameBody => fixture<TelemetryFrameBody>(name);

const promptTextOf = (body: TelemetryFrameBody): string => {
  const payload = body.payload as {
    params: { prompt: Array<{ type: string; text: string }> };
  };
  const block = payload.params.prompt[0];
  if (!block) throw new Error("golden prompt frame has no text block");
  return block.text;
};

/**
 * Minimal replay of Desktop's transcript rules, so the assertions below check
 * what the viewer actually renders rather than what we hope it renders.
 * Mirrors `upsertMessage` (concatenate on shared messageId) and
 * `mergeToolStatus` from agentSessionTranscript.ts.
 */
function replayAssistantText(frames: readonly TelemetryFrameBody[]): Map<string, string> {
  const byMessageId = new Map<string, string>();
  for (const frame of frames) {
    const chunk = readChunkIdentity(frame.payload);
    if (!chunk || chunk.sessionUpdate !== "agent_message_chunk") continue;
    byMessageId.set(chunk.messageId, (byMessageId.get(chunk.messageId) ?? "") + chunk.text);
  }
  return byMessageId;
}

describe("golden observer frames", () => {
  it("matches the session_resolved fixture", () => {
    expect(sessionResolvedFrame(true)).toEqual(golden("frame-session-resolved.json"));
  });

  it("matches the session/prompt fixture", () => {
    const expected = golden("frame-session-prompt.json");
    expect(promptFrame(promptTextOf(expected))).toEqual(expected);
  });

  it("matches the _goose/unstable/session/steer fixture", () => {
    const expected = golden("frame-session-steer.json");
    expect(steerFrame(promptTextOf(expected))).toEqual(expected);
  });

  it("matches the agent_message_chunk fixture", () => {
    expect(
      assistantChunkFrame("msg_01HZ8QF3", "Re-running the observer publisher suite now."),
    ).toEqual(golden("frame-agent-message-chunk.json"));
  });

  it("matches the agent_thought_chunk fixture", () => {
    expect(
      thinkingChunkFrame(
        "msg_01HZ8QF3",
        "The seq assertion is the only one that touches persisted state.",
      ),
    ).toEqual(golden("frame-agent-thought-chunk.json"));
  });

  it("matches the tool_call fixture", () => {
    expect(
      toolCallFrame({
        toolCallId: "call_7f21",
        toolName: "bash",
        input: { command: "npx vitest run test/telemetry-observer.test.ts" },
      }),
    ).toEqual(golden("frame-tool-call.json"));
  });

  it("matches the tool_call_update fixture", () => {
    expect(
      toolCallUpdateFrame({
        toolCallId: "call_7f21",
        status: "completed",
        content: "Test Files  1 passed (1)\nTests  9 passed (9)",
      }),
    ).toEqual(golden("frame-tool-call-update.json"));
  });

  it("matches the usage_update fixture", () => {
    expect(usageUpdateFrame({ used: 48_213, size: 200_000, costUsd: 0.0412 })).toEqual(
      golden("frame-usage-update.json"),
    );
  });

  it("matches the turn lifecycle fixtures", () => {
    const started = golden("frame-turn-started.json");
    const ids = (started.payload as { triggeringEventIds: string[] }).triggeringEventIds;
    expect(turnStartedFrame(ids)).toEqual(started);
    expect(turnLivenessFrame()).toEqual(golden("frame-turn-liveness.json"));
    expect(turnCompletedFrame()).toEqual(golden("frame-turn-completed.json"));
    expect(
      turnErrorFrame({
        outcome: "failed",
        error: "provider returned 529 after 5 attempts",
        code: "overloaded_error",
      }),
    ).toEqual(golden("frame-turn-error.json"));
  });

  it("omits an absent turn_error code rather than sending null", () => {
    expect(turnErrorFrame({ outcome: "cancelled", error: "aborted by owner" }).payload).toEqual({
      outcome: "cancelled",
      error: "aborted by owner",
    });
  });
});

describe("Pi event mapping", () => {
  it("maps streaming events to their ACP-shaped frames", () => {
    expect(mapPiEvent({ type: "text_delta", messageId: "m1", delta: "hi" })).toEqual([
      assistantChunkFrame("m1", "hi"),
    ]);
    expect(mapPiEvent({ type: "thinking_delta", messageId: "m1", delta: "hmm" })).toEqual([
      thinkingChunkFrame("m1", "hmm"),
    ]);
    expect(
      mapPiEvent({
        type: "tool_start",
        toolCallId: "call_1",
        toolName: "read",
        input: { path: "a.ts" },
      }),
    ).toEqual([toolCallFrame({ toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } })]);
    expect(
      mapPiEvent({ type: "tool_end", toolCallId: "call_1", isError: false, output: "ok" }),
    ).toEqual([toolCallUpdateFrame({ toolCallId: "call_1", status: "completed", content: "ok" })]);
    expect(
      mapPiEvent({ type: "tool_end", toolCallId: "call_1", isError: true, output: "boom" }),
    ).toEqual([toolCallUpdateFrame({ toolCallId: "call_1", status: "failed", content: "boom" })]);
  });

  it("leaves turn lifecycle to the runtime, which owns turn identity", () => {
    const lifecycle: PiEvent[] = [
      { type: "agent_start", willCompact: false },
      { type: "turn_start" },
      { type: "message_end", messageId: "m1", role: "assistant", text: "hi", usage: null },
      { type: "agent_end", willRetry: false },
      { type: "agent_settled" },
    ];
    for (const event of lifecycle) expect(mapPiEvent(event)).toEqual([]);
  });

  it("falls back to a bounded raw_json_rpc frame for unrepresentable events", () => {
    const frames = mapPiEvent({
      type: "retry",
      attempt: 2,
      maxAttempts: 5,
      errorMessage: "x".repeat(10_000),
    });
    expect(frames).toHaveLength(1);
    const [frame] = frames;
    expect(frame?.kind).toBe("raw_json_rpc");
    // Desktop titles the raw-rail card from `payload.method ?? payload.type`.
    const payload = frame?.payload as { type: string; errorMessage: string };
    expect(payload.type).toBe("retry");
    expect(utf8ByteLength(payload.errorMessage)).toBeLessThan(10_000);
  });
});

describe("Desktop correlation rules", () => {
  it("concatenates multi-chunk assistant text under one messageId", () => {
    const original = "The first suite passes, the second reports one failure in seq handling.";
    const parts = splitByUtf8Bytes(original, 16);
    expect(parts.length).toBeGreaterThan(1);
    const frames = parts.map((part) => assistantChunkFrame("msg_stream", part));
    const rendered = replayAssistantText(frames);
    expect(rendered.size).toBe(1);
    expect(rendered.get("msg_stream")).toBe(original);
  });

  it("keeps distinct messages in distinct bubbles", () => {
    const rendered = replayAssistantText([
      assistantChunkFrame("msg_a", "first"),
      assistantChunkFrame("msg_b", "second"),
    ]);
    expect([...rendered.entries()]).toEqual([
      ["msg_a", "first"],
      ["msg_b", "second"],
    ]);
  });

  it("never regresses a terminal tool status", () => {
    expect(mergeToolStatus("completed", "executing")).toBe("completed");
    expect(mergeToolStatus("failed", "executing")).toBe("failed");
    expect(mergeToolStatus("executing", "completed")).toBe("completed");
    expect(mergeToolStatus("completed", "failed")).toBe("failed");
  });
});

describe("payload size handling", () => {
  it("splits assistant chunks losslessly because Desktop concatenates them", () => {
    const text = "λ".repeat(4_000);
    const parts = splitFramePayload(assistantChunkFrame("msg_big", text).payload, 2_048);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(utf8ByteLength(JSON.stringify(part))).toBeLessThanOrEqual(2_048);
    }
    const joined = parts
      .map((part) => readChunkIdentity(part)?.text ?? "")
      .join("");
    expect(joined).toBe(text);
  });

  it("splits an oversized tool result into ordered, labelled chunks", () => {
    const result = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const parts = splitFramePayload(
      toolCallUpdateFrame({ toolCallId: "call_9", status: "completed", content: result }).payload,
      1_024,
    );
    expect(parts.length).toBeGreaterThan(1);
    const contents = parts.map((part) => {
      const update = (part as { params: { update: Record<string, unknown> } }).params.update;
      return update;
    });
    contents.forEach((update, index) => {
      expect(update.chunkIndex).toBe(index + 1);
      expect(update.chunkCount).toBe(parts.length);
      expect(update.toolCallId).toBe("call_9");
    });
    const rejoined = contents
      .map((update) => String(update.content).replace(/^\[result chunk \d+\/\d+]\n/, ""))
      .join("");
    expect(rejoined).toBe(result);
  });

  it("elides a frame it cannot split instead of dropping it", () => {
    const parts = splitFramePayload(turnStartedFrame(["a".repeat(5_000)]).payload, 512);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "observer_payload_elided" });
  });

  it("refuses a split budget narrower than one code point", () => {
    expect(() => splitByUtf8Bytes("abc", 2)).toThrow(RangeError);
  });

  it("truncates long strings when bounding a diagnostic payload", () => {
    const bounded = boundValue({ detail: "x".repeat(100) }, 16) as { detail: string };
    expect(bounded.detail.startsWith("x".repeat(16))).toBe(true);
    expect(bounded.detail).toContain("100 bytes truncated");
  });
});

describe("tool output screening", () => {
  it("passes ordinary text through untouched", () => {
    expect(describeToolOutput("plain\noutput")).toEqual({ text: "plain\noutput", binary: false });
  });

  it("replaces non-UTF8 output with metadata and a digest", () => {
    const summary = describeToolOutput(`header\u0000${String.fromCharCode(0xd800)}`);
    expect(summary.binary).toBe(true);
    expect(summary.text).toContain("[binary tool output elided]");
    expect(summary.text).toMatch(/sha256: [0-9a-f]{64}/);
    expect(summary.text).not.toContain("\u0000");
  });

  it("produces a stable digest for the same binary output", () => {
    const blob = String.fromCharCode(0xdc00, 0x41, 0x00);
    expect(describeToolOutput(blob).text).toBe(describeToolOutput(blob).text);
  });
});

describe("prompt text contract", () => {
  const expectations = fixture<{
    primary: {
      sections: Array<{ title: string; body: string }>;
      buzzEventTitle: string;
      userText: string;
      authorPubkey: string;
      eventId: string;
    };
    steer: { buzzEventTitle: string; userText: string; authorPubkey: string; eventId: string };
  }>("prompt-expectations.json");

  it("survives the session/prompt mapping unchanged", () => {
    const text = promptTextOf(golden("frame-session-prompt.json"));
    const frame = promptFrame(text);
    const roundTripped = promptTextOf(frame);
    expect(roundTripped).toBe(text);
    expect(inspectPrompt(roundTripped)).toEqual(expectations.primary);
  });

  it("survives the steer mapping with its user and event metadata", () => {
    const text = promptTextOf(golden("frame-session-steer.json"));
    const inspected = inspectPrompt(promptTextOf(steerFrame(text)));
    expect(inspected.buzzEventTitle).toBe(expectations.steer.buzzEventTitle);
    expect(inspected.userText).toBe(expectations.steer.userText);
    expect(inspected.authorPubkey).toBe(expectations.steer.authorPubkey);
    expect(inspected.eventId).toBe(expectations.steer.eventId);
  });

  it("exposes the exact expressions Desktop scrapes with", () => {
    expect(PROMPT_SECTION_HEADER_RE.source).toBe("^\\[([^\\]]+)]\\s*$");
    expect(PROMPT_AUTHOR_HEX_RE.source).toBe("^From:.*\\bhex:\\s*([0-9a-fA-F]{64})");
    expect(PROMPT_EVENT_ID_RE.source).toBe("^Event ID:\\s*([0-9a-fA-F]{64})\\b");
    expect(PROMPT_AUTHOR_HEX_RE.flags).toContain("m");
    expect(PROMPT_EVENT_ID_RE.flags).toContain("m");
    expect(BUZZ_EVENT_SECTION_PREFIX).toBe("buzz event");
  });

  it("renders no user bubble when the buzz event section is missing", () => {
    // Desktop folds an unheaded preamble into a synthetic "Prompt" section and
    // then finds no `buzz event` title, so the user message disappears
    // entirely. This is why the section is mandatory, not decorative.
    expect(inspectPrompt("just a sentence")).toEqual({
      sections: [{ title: "Prompt", body: "just a sentence" }],
      buzzEventTitle: null,
      userText: "",
      authorPubkey: null,
      eventId: null,
    });
  });
});

describe("frame routing", () => {
  it("stamps routing onto a frame body without inventing startedAt", () => {
    const route = { channelId: "c1", sessionId: "s1", turnId: "t1" };
    expect(frameDraft(turnCompletedFrame(), route)).toEqual({
      kind: "turn_completed",
      channelId: "c1",
      sessionId: "s1",
      turnId: "t1",
      payload: {},
    });
    expect(
      frameDraft(turnCompletedFrame(), { ...route, startedAt: "2026-08-03T12:00:00.000Z" }),
    ).toHaveProperty("startedAt", "2026-08-03T12:00:00.000Z");
  });
});
