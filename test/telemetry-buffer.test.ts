import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/runtime/clock.js";
import type { ObserverFrameDraft } from "../src/runtime/ports.js";
import {
  DEFAULT_COALESCE_WINDOW_MS,
  TelemetryBuffer,
} from "../src/telemetry/telemetry-buffer.js";
import { OBSERVER_MAX_FRAMES_PER_SECOND } from "../src/telemetry/observer-envelope.js";
import {
  assistantChunkFrame,
  frameDraft,
  readChunkIdentity,
  thinkingChunkFrame,
  toolCallFrame,
  toolCallUpdateFrame,
  turnCompletedFrame,
  type FrameRoute,
} from "../src/telemetry/buzz-desktop-compat.js";

const ROUTE: FrameRoute = { channelId: "chan", sessionId: "sess", turnId: "turn-1" };

interface Harness {
  clock: FakeClock;
  buffer: TelemetryBuffer;
  emitted: ObserverFrameDraft[];
}

function harness(options: Partial<ConstructorParameters<typeof TelemetryBuffer>[0]> = {}): Harness {
  const clock = new FakeClock();
  const emitted: ObserverFrameDraft[] = [];
  const buffer = new TelemetryBuffer({
    clock,
    emitFrame: (draft) => emitted.push(draft),
    ...options,
  });
  return { clock, buffer, emitted };
}

const updateOf = (draft: ObserverFrameDraft): Record<string, unknown> =>
  (draft.payload as { params: { update: Record<string, unknown> } }).params.update;

describe("delta coalescing", () => {
  it("merges deltas of one message inside the window into a single frame", async () => {
    const { clock, buffer, emitted } = harness();
    for (const delta of ["Re-", "running ", "the suite"]) {
      buffer.push(frameDraft(assistantChunkFrame("msg_1", delta), ROUTE));
    }
    expect(emitted).toHaveLength(0);

    await clock.advance(DEFAULT_COALESCE_WINDOW_MS);
    expect(emitted).toHaveLength(1);
    expect(readChunkIdentity(emitted[0]?.payload)).toEqual({
      sessionUpdate: "agent_message_chunk",
      messageId: "msg_1",
      text: "Re-running the suite",
    });
  });

  it("rejects a window outside the range the plan pins", () => {
    const clock = new FakeClock();
    expect(
      () => new TelemetryBuffer({ clock, emitFrame: () => {}, coalesceWindowMs: 200 }),
    ).toThrow(RangeError);
    expect(() => new TelemetryBuffer({ clock, emitFrame: () => {}, coalesceWindowMs: 10 })).toThrow(
      RangeError,
    );
  });

  it("keeps separate messages and thinking in separate frames", async () => {
    const { clock, buffer, emitted } = harness();
    buffer.push(frameDraft(thinkingChunkFrame("msg_1", "weighing options"), ROUTE));
    buffer.push(frameDraft(assistantChunkFrame("msg_1", "here goes"), ROUTE));
    await clock.advance(DEFAULT_COALESCE_WINDOW_MS);

    expect(emitted.map((draft) => readChunkIdentity(draft.payload)?.sessionUpdate)).toEqual([
      "agent_thought_chunk",
      "agent_message_chunk",
    ]);
  });

  it("flushes open text before a tool call so the transcript keeps its order", () => {
    const { buffer, emitted } = harness();
    buffer.push(frameDraft(assistantChunkFrame("msg_1", "let me look"), ROUTE));
    buffer.push(
      frameDraft(toolCallFrame({ toolCallId: "call_1", toolName: "read", input: {} }), ROUTE),
    );

    expect(emitted).toHaveLength(2);
    expect(readChunkIdentity(emitted[0]?.payload)?.text).toBe("let me look");
    expect(updateOf(emitted[1] as ObserverFrameDraft).sessionUpdate).toBe("tool_call");
  });

  it("flushes pending text on a turn boundary", async () => {
    const { buffer, emitted } = harness();
    buffer.push(frameDraft(assistantChunkFrame("msg_1", "done"), ROUTE));
    await buffer.flush();

    expect(emitted).toHaveLength(1);
    expect(readChunkIdentity(emitted[0]?.payload)?.text).toBe("done");
  });

  it("coalesces per turn, not globally", async () => {
    const { clock, buffer, emitted } = harness();
    buffer.push(frameDraft(assistantChunkFrame("msg_1", "alpha"), ROUTE));
    buffer.push(
      frameDraft(assistantChunkFrame("msg_1", "beta"), { ...ROUTE, turnId: "turn-2" }),
    );
    await clock.advance(DEFAULT_COALESCE_WINDOW_MS);

    expect(emitted.map((draft) => draft.turnId)).toEqual(["turn-1", "turn-2"]);
  });
});

describe("tool status guard", () => {
  it("rewrites a late progress update rather than regressing a terminal status", () => {
    const { buffer, emitted } = harness();
    buffer.push(
      frameDraft(toolCallFrame({ toolCallId: "call_1", toolName: "bash", input: {} }), ROUTE),
    );
    buffer.push(
      frameDraft(
        toolCallUpdateFrame({ toolCallId: "call_1", status: "completed", content: "ok" }),
        ROUTE,
      ),
    );
    buffer.push(
      frameDraft(
        toolCallUpdateFrame({ toolCallId: "call_1", status: "executing", content: "late line" }),
        ROUTE,
      ),
    );

    expect(emitted.map((draft) => updateOf(draft).status)).toEqual([
      "executing",
      "completed",
      "completed",
    ]);
    expect(updateOf(emitted[2] as ObserverFrameDraft).content).toBe("late line");
  });

  it("lets a failure follow a successful sibling call", () => {
    const { buffer, emitted } = harness();
    buffer.push(
      frameDraft(
        toolCallUpdateFrame({ toolCallId: "call_1", status: "completed", content: "ok" }),
        ROUTE,
      ),
    );
    buffer.push(
      frameDraft(
        toolCallUpdateFrame({ toolCallId: "call_2", status: "failed", content: "boom" }),
        ROUTE,
      ),
    );

    expect(emitted.map((draft) => updateOf(draft).status)).toEqual(["completed", "failed"]);
  });

  it("forgets a turn's tool history once the turn is over", () => {
    const { buffer, emitted } = harness();
    buffer.push(
      frameDraft(
        toolCallUpdateFrame({ toolCallId: "call_1", status: "completed", content: "ok" }),
        ROUTE,
      ),
    );
    buffer.forgetTurn("turn-1");
    buffer.push(
      frameDraft(toolCallFrame({ toolCallId: "call_1", toolName: "bash", input: {} }), ROUTE),
    );

    expect(updateOf(emitted[1] as ObserverFrameDraft).status).toBe("executing");
  });
});

describe("size and pacing", () => {
  it("splits an oversized tool result into ordered chunks and loses none", () => {
    const { buffer, emitted } = harness({ payloadBudgetBytes: 1_024 });
    const output = Array.from({ length: 500 }, (_, index) => `row ${index}`).join("\n");
    buffer.push(
      frameDraft(
        toolCallUpdateFrame({ toolCallId: "call_1", status: "completed", content: output }),
        ROUTE,
      ),
    );

    expect(emitted.length).toBeGreaterThan(1);
    const rejoined = emitted
      .map((draft, index) => {
        const update = updateOf(draft);
        expect(update.chunkIndex).toBe(index + 1);
        expect(update.chunkCount).toBe(emitted.length);
        expect(Buffer.byteLength(JSON.stringify(draft.payload), "utf8")).toBeLessThanOrEqual(1_024);
        return String(update.content).replace(/^\[result chunk \d+\/\d+]\n/, "");
      })
      .join("");
    expect(rejoined).toBe(output);
  });

  it("never emits more than the relay allowance in one second", async () => {
    const { clock, buffer, emitted } = harness({ maxFramesPerSecond: 10 });
    for (let index = 0; index < 25; index += 1) {
      buffer.push(frameDraft(turnCompletedFrame(), { ...ROUTE, turnId: `turn-${index}` }));
    }
    expect(emitted).toHaveLength(10);

    await clock.advance(1_000);
    expect(emitted).toHaveLength(20);

    await clock.advance(1_000);
    expect(emitted).toHaveLength(25);
  });

  it("stays inside the default NIP-AO ceiling", () => {
    const { buffer, emitted } = harness();
    for (let index = 0; index < OBSERVER_MAX_FRAMES_PER_SECOND + 40; index += 1) {
      buffer.push(frameDraft(turnCompletedFrame(), { ...ROUTE, turnId: `turn-${index}` }));
    }
    expect(emitted).toHaveLength(OBSERVER_MAX_FRAMES_PER_SECOND);
  });

  it("resolves flush only after the paced queue has drained", async () => {
    const { clock, buffer, emitted } = harness({ maxFramesPerSecond: 5 });
    for (let index = 0; index < 12; index += 1) {
      buffer.push(frameDraft(turnCompletedFrame(), { ...ROUTE, turnId: `turn-${index}` }));
    }
    let settled = false;
    const flushed = buffer.flush().then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    await clock.advance(3_000);
    await flushed;
    expect(settled).toBe(true);
    expect(emitted).toHaveLength(12);
  });

  it("reports shed frames as a visible diagnostic instead of dropping silently", async () => {
    const { clock, buffer, emitted } = harness({ maxFramesPerSecond: 5, maxQueuedFrames: 8 });
    for (let index = 0; index < 40; index += 1) {
      buffer.push(frameDraft(turnCompletedFrame(), { ...ROUTE, turnId: `turn-${index}` }));
    }
    await clock.advance(5_000);

    const diagnostics = emitted.filter(
      (draft) => (draft.payload as { type?: string }).type === "observer_overflow",
    );
    expect(diagnostics).toHaveLength(1);
    const payload = diagnostics[0]?.payload as { title: string; text: string };
    expect(payload.title).toBe("Telemetry overflow");
    // 40 pushed, 5 emitted immediately, 8 queued: the remaining 27 are shed.
    expect(payload.text).toContain("27 telemetry frames were shed");
  });

  it("releases pending text when stopped", () => {
    const { buffer, emitted } = harness();
    buffer.push(frameDraft(assistantChunkFrame("msg_1", "partial"), ROUTE));
    buffer.stop();

    expect(emitted).toHaveLength(1);
    expect(readChunkIdentity(emitted[0]?.payload)?.text).toBe("partial");
  });
});
