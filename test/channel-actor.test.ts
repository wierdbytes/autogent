import { beforeEach, describe, expect, it } from "vitest";
import { ChannelActor, type ChannelActorDeps } from "../src/runtime/channel-actor.js";
import { OutputRouter } from "../src/runtime/output-router.js";
import { FakeClock } from "../src/runtime/clock.js";
import { nullLogger } from "../src/runtime/logger.js";
import { tagValue, tagsNamed } from "../src/nostr/types.js";
import type { NostrEvent } from "../src/nostr/types.js";
import {
  AGENT_PUBKEY,
  FakeEventBuilder,
  FakeSession,
  FakeTelemetry,
  USER_A_PUBKEY,
  USER_B_PUBKEY,
  USER_B_SECRET,
  chatEvent,
  fakeState,
  replyEvent,
} from "./helpers/fakes.js";

const CHANNEL = "11111111-2222-3333-4444-555555555555";

function setup(options: { session?: FakeSession; acquireSequence?: FakeSession[] } = {}) {
  const clock = new FakeClock();
  const state = fakeState();
  const telemetry = new FakeTelemetry();
  const outbox = state.outbox;
  const session = options.session ?? options.acquireSequence?.[0] ?? new FakeSession();
  let acquireCalls = 0;
  const usage: Array<{ turnId: string; stopReason: string }> = [];
  const observed: Array<{ sessionId: string; turnId: string }> = [];
  const contextCalls: Array<{ eventId: string; sessionHasHistory: boolean }> = [];
  let turnSeq = 0;

  const output = new OutputRouter({
    outbox,
    builder: new FakeEventBuilder(),
    config: { maxMessageBytes: 16_000, oversizePolicy: "split" },
    now: () => clock.now(),
    notify: () => {},
  });

  const deps: ChannelActorDeps = {
    relayId: "test-relay",
    channelId: CHANNEL,
    channelName: "general",
    channelType: "stream",
    state,
    telemetry,
    output,
    clock,
    logger: nullLogger,
    acquireSession: async () =>
      options.acquireSequence
        ? (options.acquireSequence[Math.min(acquireCalls++, options.acquireSequence.length - 1)] ?? session)
        : session,
    rotateSession: async () => session,
    fetchContext: async (event, _threadRootId, opts) => {
      contextCalls.push({ eventId: event.id, sessionHasHistory: opts.sessionHasHistory });
      return null;
    },
    observeUsage: (sessionId, turnId) => observed.push({ sessionId, turnId }),
    publishUsage: (turn, _sessionId, stopReason) => usage.push({ turnId: turn.turnId, stopReason }),
    newTurnId: () => `turn-${++turnSeq}`,
    idleTimeoutMs: 900_000,
    maxTurnDurationMs: 7_200_000,
  };

  return {
    actor: new ChannelActor(deps),
    clock,
    state,
    telemetry,
    session,
    output,
    usage,
    observed,
    contextCalls,
  };
}

/** The `e` tag carrying the given NIP-10 marker. */
function marker(event: NostrEvent, name: "root" | "reply"): string | undefined {
  return event.tags.find((tag) => tag[0] === "e" && tag[3] === name)?.[1];
}

describe("primary turn", () => {
  it("prompts Pi and publishes each completed message as its own chat event", async () => {
    const { actor, session, state } = setup();
    const trigger = chatEvent({ channelId: CHANNEL, content: "@agent hello" });

    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();

    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain(`Event ID: ${trigger.id}`);
    expect(session.prompts[0]).toContain(`hex: ${USER_A_PUBKEY}`);

    session.emitAssistantMessage("m1", "first answer");
    session.emitAssistantMessage("m2", "second answer");
    await actor.drain();

    const published = state.outbox.publishedChatEvents();
    expect(published.map((event) => event.content)).toEqual(["first answer", "second answer"]);
  });

  it("never emits chat output for thinking or tool-only messages", async () => {
    const { actor, session, state } = setup();
    actor.submit({ event: chatEvent({ channelId: CHANNEL, content: "go" }), promptTag: "@mention" });
    await actor.drain();

    session.emit({ type: "thinking_delta", messageId: "m1", delta: "pondering" });
    session.emit({ type: "text_delta", messageId: "m1", delta: "partial" });
    session.emit({ type: "tool_start", toolCallId: "t1", toolName: "bash", input: {} });
    session.emit({ type: "tool_end", toolCallId: "t1", isError: false, output: "done" });
    session.emitAssistantMessage("m1", "   ");
    await actor.drain();

    expect(state.outbox.publishedChatEvents()).toHaveLength(0);
  });
});

describe("context fetching", () => {
  it("passes the session's pre-prompt history state into fetchContext", async () => {
    const { actor, session, contextCalls } = setup();
    const first = chatEvent({ channelId: CHANNEL, content: "first" });
    actor.submit({ event: first, promptTag: "@mention" });
    await actor.drain();

    // The fresh session had no history when the first turn fetched context.
    expect(contextCalls).toEqual([{ eventId: first.id, sessionHasHistory: false }]);

    session.emit({ type: "agent_settled" });
    await actor.drain();

    const second = chatEvent({ channelId: CHANNEL, content: "second" });
    actor.submit({ event: second, promptTag: "@mention" });
    await actor.drain();

    // After the first prompt the session carries the conversation itself.
    expect(contextCalls[1]).toEqual({ eventId: second.id, sessionHasHistory: true });
  });
});

describe("reply targeting", () => {
  it("anchors every output of a turn to the primary user event", async () => {
    const { actor, session, state } = setup();
    const trigger = chatEvent({ channelId: CHANNEL, content: "start" });

    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();

    session.emitAssistantMessage("m1", "one");
    session.emit({ type: "tool_start", toolCallId: "t1", toolName: "bash", input: {} });
    session.emit({ type: "tool_end", toolCallId: "t1", isError: false, output: "ok" });
    session.emitAssistantMessage("m2", "two");
    session.emitAssistantMessage("m3", "three");
    await actor.drain();

    const published = state.outbox.publishedChatEvents();
    expect(published).toHaveLength(3);
    for (const event of published) {
      expect(marker(event, "root")).toBe(trigger.id);
      expect(marker(event, "reply")).toBeUndefined();
      expect(tagValue(event, "h")).toBe(CHANNEL);
    }
  });

  it("never replies to one of its own outputs", async () => {
    const { actor, session, state } = setup();
    const trigger = chatEvent({ channelId: CHANNEL, content: "start" });
    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();

    session.emitAssistantMessage("m1", "one");
    await actor.drain();
    session.emitAssistantMessage("m2", "two");
    await actor.drain();

    const published = state.outbox.publishedChatEvents();
    const agentEventIds = new Set(published.map((event) => event.id));
    for (const event of published) {
      for (const tag of tagsNamed(event, "e")) {
        expect(agentEventIds.has(tag[1] as string)).toBe(false);
      }
    }
  });

  it("preserves the thread root when the trigger is a nested reply", async () => {
    const { actor, session, state } = setup();
    const root = chatEvent({ channelId: CHANNEL, content: "root message" });
    const trigger = replyEvent({
      channelId: CHANNEL,
      content: "nested question",
      rootEventId: root.id,
    });

    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();
    session.emitAssistantMessage("m1", "answer");
    await actor.drain();

    const [published] = state.outbox.publishedChatEvents();
    expect(marker(published as NostrEvent, "root")).toBe(root.id);
    expect(marker(published as NostrEvent, "reply")).toBe(trigger.id);
  });
});

describe("same-thread steering", () => {
  it("delivers a follow-up in the same thread via steer, not a new turn", async () => {
    const { actor, session, state } = setup();
    const trigger = chatEvent({ channelId: CHANNEL, content: "start" });
    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();

    const followUp = replyEvent({
      secret: USER_B_SECRET,
      channelId: CHANNEL,
      content: "also consider this",
      rootEventId: trigger.id,
    });
    actor.submit({ event: followUp, promptTag: "@mention" });
    await actor.drain();

    expect(session.prompts).toHaveLength(1);
    expect(session.steers).toHaveLength(1);
    expect(session.steers[0]).toContain(followUp.id);
    expect(state.dispositions.get(followUp.id)).toBe("steer_delivered");
  });

  it("adds the steering author to p tags without moving the reply anchor", async () => {
    const { actor, session, state } = setup();
    const trigger = chatEvent({ channelId: CHANNEL, content: "start" });
    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();

    actor.submit({
      event: replyEvent({
        secret: USER_B_SECRET,
        channelId: CHANNEL,
        content: "more",
        rootEventId: trigger.id,
      }),
      promptTag: "@mention",
    });
    await actor.drain();

    session.emitAssistantMessage("m1", "answer after steer");
    await actor.drain();

    const [published] = state.outbox.publishedChatEvents();
    const event = published as NostrEvent;
    const recipients = tagsNamed(event, "p").map((tag) => tag[1]);
    expect(recipients).toContain(USER_A_PUBKEY);
    expect(recipients).toContain(USER_B_PUBKEY);
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(marker(event, "root")).toBe(trigger.id);
  });

  it("queues a different thread instead of steering the running turn", async () => {
    const { actor, session, state } = setup();
    const first = chatEvent({ channelId: CHANNEL, content: "thread one" });
    actor.submit({ event: first, promptTag: "@mention" });
    await actor.drain();

    const other = chatEvent({ channelId: CHANNEL, content: "unrelated thread" });
    actor.submit({ event: other, promptTag: "@mention" });
    await actor.drain();

    expect(session.steers).toHaveLength(0);
    expect(actor.queueDepth).toBe(1);
    expect(state.dispositions.get(other.id)).toBe("queued");

    session.emit({ type: "agent_settled" });
    await actor.drain();

    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain(other.id);
  });

  it("starts a new turn for a same-thread message that arrives after settling", async () => {
    const { actor, session } = setup();
    const trigger = chatEvent({ channelId: CHANNEL, content: "start" });
    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();

    session.emit({ type: "agent_settled" });
    await actor.drain();
    expect(actor.state).toBe("idle");

    actor.submit({
      event: replyEvent({ channelId: CHANNEL, content: "later", rootEventId: trigger.id }),
      promptTag: "@mention",
    });
    await actor.drain();

    expect(session.steers).toHaveLength(0);
    expect(session.prompts).toHaveLength(2);
  });

  it("requeues rather than loses a steer rejected by a terminal race", async () => {
    const session = new FakeSession();
    const { actor, state } = setup({ session });
    const trigger = chatEvent({ channelId: CHANNEL, content: "start" });
    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();

    session.steerRejects = true;
    const followUp = replyEvent({
      channelId: CHANNEL,
      content: "raced",
      rootEventId: trigger.id,
    });
    actor.submit({ event: followUp, promptTag: "@mention" });
    await actor.drain();

    expect(state.dispositions.get(followUp.id)).toBe("queued");
    expect(actor.queueDepth).toBe(1);

    session.steerRejects = false;
    session.emit({ type: "agent_settled" });
    await actor.drain();

    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain(followUp.id);
  });
});

describe("turn lifecycle", () => {
  it("keeps the turn open across agent_end with a pending retry", async () => {
    const { actor, session, usage } = setup();
    actor.submit({ event: chatEvent({ channelId: CHANNEL, content: "go" }), promptTag: "@mention" });
    await actor.drain();

    session.emit({ type: "agent_end", willRetry: true });
    await actor.drain();
    expect(actor.activeTurn).not.toBeNull();
    expect(usage).toHaveLength(0);

    session.emit({ type: "agent_end", willRetry: false });
    await actor.drain();
    expect(actor.activeTurn).not.toBeNull();
    expect(actor.state).toBe("settling");

    session.emit({ type: "agent_settled" });
    await actor.drain();
    expect(actor.activeTurn).toBeNull();
    expect(usage).toEqual([{ turnId: "turn-1", stopReason: "end_turn" }]);
  });

  it("still accepts a steer while settling but before the terminal event", async () => {
    const { actor, session } = setup();
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();

    session.emit({ type: "agent_end", willRetry: false });
    await actor.drain();

    actor.submit({
      event: replyEvent({ channelId: CHANNEL, content: "one more", rootEventId: trigger.id }),
      promptTag: "@mention",
    });
    await actor.drain();

    expect(session.steers).toHaveLength(1);
  });

  it("re-acquires a session when the cached one was disposed by a config push", async () => {
    const first = new FakeSession("session-old");
    const second = new FakeSession("session-new");
    const { actor } = setup({ acquireSequence: [first, second] });

    actor.submit({ event: chatEvent({ channelId: CHANNEL, content: "one" }), promptTag: "@mention" });
    await actor.drain();
    expect(first.prompts).toHaveLength(1);

    first.emit({ type: "agent_end", willRetry: false });
    first.emit({ type: "agent_settled" });
    await actor.drain();
    expect(actor.activeTurn).toBeNull();

    // A hot config update disposes the cached session out from under the actor.
    first.dispose();

    actor.submit({ event: chatEvent({ channelId: CHANNEL, content: "two" }), promptTag: "@mention" });
    await actor.drain();

    expect(second.prompts).toHaveLength(1);
    expect(first.prompts).toHaveLength(1);
  });

  it("does not let a cancelled run's trailing settle kill the next turn", async () => {
    const { actor, session } = setup();
    const first = chatEvent({ channelId: CHANNEL, content: "one" });
    actor.submit({ event: first, promptTag: "@mention" });
    await actor.drain();

    const queued = chatEvent({ channelId: CHANNEL, content: "two" });
    actor.submit({ event: queued, promptTag: "@mention" });
    await actor.drain();

    actor.cancel("user_cancel");
    await actor.drain();
    expect(session.prompts).toHaveLength(2);
    expect(actor.activeTurn?.primaryTriggerEventId).toBe(queued.id);

    // The aborted first run now reports settling. The second turn must survive.
    session.emit({ type: "agent_settled" });
    await actor.drain();
    expect(actor.activeTurn?.primaryTriggerEventId).toBe(queued.id);
  });
});

describe("telemetry shape", () => {
  it("emits an ACP-shaped prompt frame and a steer frame Desktop can parse", async () => {
    const { actor, session, telemetry } = setup();
    const trigger = chatEvent({ channelId: CHANNEL, content: "hi" });
    actor.submit({ event: trigger, promptTag: "@mention" });
    await actor.drain();

    actor.submit({
      event: replyEvent({ channelId: CHANNEL, content: "and this", rootEventId: trigger.id }),
      promptTag: "@mention",
    });
    await actor.drain();

    const writes = telemetry.ofKind("acp_write");
    const methods = writes.map((frame) => (frame.payload as { method: string }).method);
    expect(methods).toEqual(["session/prompt", "_goose/unstable/session/steer"]);

    const started = telemetry.ofKind("turn_started")[0];
    expect((started?.payload as { triggeringEventIds: string[] }).triggeringEventIds).toEqual([
      trigger.id,
    ]);

    session.emit({ type: "agent_settled" });
    await actor.drain();
    expect(telemetry.ofKind("turn_completed")).toHaveLength(1);
  });

  it("streams thinking, tool activity and assistant text as Desktop session updates", async () => {
    const { actor, session, telemetry } = setup();
    actor.submit({ event: chatEvent({ channelId: CHANNEL, content: "go" }), promptTag: "@mention" });
    await actor.drain();

    session.emit({ type: "thinking_delta", messageId: "m1", delta: "pondering" });
    session.emit({ type: "text_delta", messageId: "m1", delta: "partial" });
    session.emit({ type: "tool_start", toolCallId: "t1", toolName: "bash", input: { cmd: "ls" } });
    session.emit({ type: "tool_end", toolCallId: "t1", isError: false, output: "done" });
    await actor.drain();

    const updates = telemetry
      .ofKind("acp_read")
      .map((frame) => frame.payload as { method?: string; params?: { update?: Record<string, unknown> } })
      .filter((payload) => payload.method === "session/update")
      .map((payload) => payload.params?.update ?? {});

    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      "agent_thought_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
    ]);
    expect(updates[0]).toMatchObject({ messageId: "m1", content: "pondering" });
    expect(updates[1]).toMatchObject({ messageId: "m1", content: "partial" });
    expect(updates[2]).toMatchObject({
      toolCallId: "t1",
      toolName: "bash",
      status: "executing",
      args: { cmd: "ls" },
    });
    expect(updates[3]).toMatchObject({ toolCallId: "t1", status: "completed", content: "done" });

    // Every streamed frame carries the turn's routing identity.
    for (const frame of telemetry.ofKind("acp_read")) {
      expect(frame.channelId).toBe(CHANNEL);
      expect(frame.turnId).toBe(actor.activeTurn?.turnId);
      expect(frame.sessionId).toBe(session.sessionId);
    }
  });

  it("emits a usage_update frame when the provider reports usage and the window is known", async () => {
    const { actor, session, telemetry } = setup();
    session.contextWindow = 100_000;
    actor.submit({ event: chatEvent({ channelId: CHANNEL, content: "go" }), promptTag: "@mention" });
    await actor.drain();

    session.emit({
      type: "message_end",
      messageId: "m1",
      role: "assistant",
      text: "answer",
      usage: { input: 900, output: 100, total: 1_000, cacheRead: null, cacheWrite: null, costUsd: 0.01 },
    });
    await actor.drain();

    const usageUpdates = telemetry
      .ofKind("acp_read")
      .map((frame) => frame.payload as { params?: { update?: Record<string, unknown> } })
      .map((payload) => payload.params?.update)
      .filter((update) => update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toEqual([
      {
        sessionUpdate: "usage_update",
        used: 1_000,
        size: 100_000,
        cost: { amount: 0.01, currency: "USD" },
      },
    ]);
  });

  it("omits the usage_update frame when the context window is unknown", async () => {
    const { actor, session, telemetry } = setup();
    session.contextWindow = undefined;
    actor.submit({ event: chatEvent({ channelId: CHANNEL, content: "go" }), promptTag: "@mention" });
    await actor.drain();

    session.emit({
      type: "message_end",
      messageId: "m1",
      role: "assistant",
      text: "answer",
      usage: { input: 900, output: 100, total: 1_000, cacheRead: null, cacheWrite: null, costUsd: null },
    });
    await actor.drain();

    const usageUpdates = telemetry
      .ofKind("acp_read")
      .map((frame) => frame.payload as { params?: { update?: Record<string, unknown> } })
      .filter((payload) => payload.params?.update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toHaveLength(0);
  });

  it("tracks turn liveness for exactly the lifetime of the turn", async () => {
    const { actor, session, telemetry } = setup();
    actor.submit({ event: chatEvent({ channelId: CHANNEL, content: "go" }), promptTag: "@mention" });
    await actor.drain();

    const turnId = actor.activeTurn?.turnId;
    expect(telemetry.trackedTurns).toEqual([{ turnId, stopped: 0 }]);

    session.emit({ type: "agent_settled" });
    await actor.drain();
    expect(telemetry.trackedTurns).toEqual([{ turnId, stopped: 1 }]);
  });
});

describe("agent identity", () => {
  let beforeAll: string;
  beforeEach(() => {
    beforeAll = AGENT_PUBKEY;
  });

  it("uses a distinct agent key from the participants", () => {
    expect(beforeAll).not.toBe(USER_A_PUBKEY);
    expect(beforeAll).not.toBe(USER_B_PUBKEY);
  });
});
