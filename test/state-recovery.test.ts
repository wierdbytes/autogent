import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutputIntent } from "../src/runtime/ports.js";
import {
  applyRecovery,
  planRecovery,
  INTERRUPTED_STOP_REASON,
  type RecoveryPlan,
} from "../src/state/recovery.js";
import {
  inboxRecord,
  openTestStore,
  outboxRecord,
  outputIntent,
  turnRecord,
  type TestStore,
} from "./state-fixtures.js";

let store: TestStore;

beforeEach(() => {
  store = openTestStore(0);
});

afterEach(() => {
  store.close();
});

const REPLY_LOGICAL_ID = "turn-1:msg-1:0";

/** Every point of plan §13.7 at which the process can be stopped mid-turn. */
const STAGES = [
  "inbox_insert",
  "prompt_accepted",
  "steer_pending",
  "steer_delivered",
  "output_intent",
  "event_signed",
  "published",
] as const;

type Stage = (typeof STAGES)[number];

/** Replays the turn pipeline and stops right after `stage`, as a crash would. */
function crashAfter(stage: Stage): void {
  const { state } = store;
  const reached = (candidate: Stage) => STAGES.indexOf(candidate) <= STAGES.indexOf(stage);

  state.inbox.insertIfAbsent(inboxRecord({ eventId: "primary", receivedAt: store.advance(10) }));
  if (!reached("prompt_accepted")) return;

  state.turns.create(turnRecord({ turnId: "turn-1", startedAt: store.advance(10) }));
  state.turns.addInput("turn-1", "primary", "primary", 0);
  state.inbox.assignToTurn("primary", "turn-1", 0, "prompted");
  state.turns.markInputDelivered("turn-1", "primary", store.advance());
  if (!reached("steer_pending")) return;

  state.inbox.insertIfAbsent(inboxRecord({ eventId: "steer", receivedAt: store.advance(10) }));
  state.turns.addInput("turn-1", "steer", "steer", 1);
  state.inbox.assignToTurn("steer", "turn-1", 1, "steer_pending");
  if (!reached("steer_delivered")) return;

  state.inbox.setDisposition("steer", "steer_delivered");
  state.turns.markInputDelivered("turn-1", "steer", store.advance());
  if (!reached("output_intent")) return;

  store.advance(10);
  state.outbox.putIntent(outputIntent({ logicalId: REPLY_LOGICAL_ID, turnId: "turn-1" }));
  if (!reached("event_signed")) return;

  store.advance();
  state.outbox.putSigned(outboxRecord({ logicalId: REPLY_LOGICAL_ID, eventId: "reply-event" }));
  if (!reached("published")) return;

  state.outbox.markPublished(REPLY_LOGICAL_ID);
  state.turns.setState("turn-1", "completed", "agent_settled");
  state.inbox.completeTurnInputs("turn-1");
}

function isDurablyAnswered(plan: RecoveryPlan, intent: OutputIntent): boolean {
  if (intent.state === "published") return true;
  if (plan.sign.some((candidate) => candidate.logicalId === intent.logicalId)) return true;
  return [...plan.resend, ...plan.deferred].some((row) => row.logicalId === intent.logicalId);
}

/**
 * The load-bearing invariant: an accepted message is either scheduled to run
 * again or has an answer that recovery will still get onto the relay.
 */
function expectNoAcceptedInputLost(plan: RecoveryPlan): void {
  const requeued = new Set(plan.requeue.map((input) => input.record.eventId));
  for (const channelId of store.state.inbox.unsettledChannels()) {
    for (const record of store.state.inbox.unsettledForChannel(channelId)) {
      if (requeued.has(record.eventId)) continue;
      expect(record.turnId, `input ${record.eventId} is neither replayed nor owned by a turn`)
        .not.toBeNull();
      const intents = store.state.outbox.intentsForTurn(record.turnId ?? "");
      expect(intents.length, `input ${record.eventId} was dropped without an answer`)
        .toBeGreaterThan(0);
      for (const intent of intents) {
        expect(isDurablyAnswered(plan, intent), `answer ${intent.logicalId} would be lost`).toBe(true);
      }
    }
  }
}

function expectNoDuplicateEventIds(plan: RecoveryPlan): void {
  const eventIds = plan.resend.map((row) => row.eventId);
  expect(new Set(eventIds).size).toBe(eventIds.length);

  const alreadySigned = new Set(
    [...plan.resend, ...plan.deferred, ...plan.deadLetter].map((row) => row.logicalId),
  );
  for (const intent of plan.sign) {
    expect(alreadySigned.has(intent.logicalId)).toBe(false);
    expect(intent.state).toBe("pending");
  }
}

describe("crash mid-turn", () => {
  beforeEach(() => {
    const { state } = store;
    state.inbox.insertIfAbsent(inboxRecord({ eventId: "primary", receivedAt: 10 }));
    state.turns.create(turnRecord({ turnId: "turn-1", startedAt: 20 }));
    state.turns.addInput("turn-1", "primary", "primary", 0);
    state.inbox.assignToTurn("primary", "turn-1", 0, "prompted");
    state.turns.markInputDelivered("turn-1", "primary", 21);

    // Two same-thread follow-ups written down but never handed to Pi. The later
    // one is received first to prove the replay order comes from the ordinal.
    state.inbox.insertIfAbsent(inboxRecord({ eventId: "steer-b", receivedAt: 30 }));
    state.turns.addInput("turn-1", "steer-b", "steer", 2);
    state.inbox.assignToTurn("steer-b", "turn-1", 2, "steer_pending");
    state.inbox.insertIfAbsent(inboxRecord({ eventId: "steer-a", receivedAt: 40 }));
    state.turns.addInput("turn-1", "steer-a", "steer", 1);
    state.inbox.assignToTurn("steer-a", "turn-1", 1, "steer_pending");

    store.advance(100);
    state.outbox.putIntent(outputIntent({ logicalId: REPLY_LOGICAL_ID, turnId: "turn-1" }));
    store.advance();
    state.outbox.putSigned(outboxRecord({ logicalId: REPLY_LOGICAL_ID, eventId: "reply-event" }));
  });

  it("resends the event that was already signed", () => {
    const plan = planRecovery(store.state, store.now());

    expect(plan.resend.map((row) => row.eventId)).toEqual(["reply-event"]);
    expect(plan.resend[0]?.signedEvent.id).toBe("reply-event");
    expect(plan.sign).toHaveLength(0);
  });

  it("marks the running turn interrupted", () => {
    const plan = planRecovery(store.state, store.now());

    expect(plan.interrupt).toEqual([
      {
        turnId: "turn-1",
        channelId: "channel-1",
        threadRootId: "event-1",
        primaryTriggerEventId: "event-1",
        primaryAuthorPubkey: "a".repeat(64),
        previousState: "running",
        stopReason: INTERRUPTED_STOP_REASON,
      },
    ]);
  });

  it("requeues the undelivered inputs in ordinal order", () => {
    const plan = planRecovery(store.state, store.now());

    expect(plan.requeue.map((input) => input.record.eventId)).toEqual(["steer-a", "steer-b"]);
    expect(plan.requeue.map((input) => input.previousTurnId)).toEqual(["turn-1", "turn-1"]);
    expect(plan.requeue.every((input) => input.wasDelivered)).toBe(false);
    expect(plan.requeue.map((input) => input.role)).toEqual(["steer", "steer"]);
  });

  it("executes as one idempotent step", () => {
    const plan = planRecovery(store.state, store.now());
    applyRecovery(store.state, plan);

    expect(store.state.turns.get("turn-1")?.state).toBe("interrupted");
    expect(store.state.turns.get("turn-1")?.stopReason).toBe(INTERRUPTED_STOP_REASON);
    const steer = store.state.inbox.get("steer-a");
    expect(steer?.disposition).toBe("queued");
    expect(steer?.turnId).toBe("turn-1");

    const second = planRecovery(store.state, store.now());
    expect(second.interrupt).toHaveLength(0);
    expect(second.requeue.map((input) => input.record.eventId)).toEqual(["steer-a", "steer-b"]);
    expect(second.resend.map((row) => row.eventId)).toEqual(["reply-event"]);
  });

  it("stops proposing the resend once the relay acknowledges it", () => {
    store.state.outbox.markPublished(REPLY_LOGICAL_ID);

    expect(planRecovery(store.state, store.now()).resend).toHaveLength(0);
  });
});

describe("crash injection matrix", () => {
  const expected: Record<
    Stage,
    { requeue: string[]; interrupt: string[]; sign: string[]; resend: string[] }
  > = {
    inbox_insert: { requeue: ["primary"], interrupt: [], sign: [], resend: [] },
    prompt_accepted: { requeue: ["primary"], interrupt: ["turn-1"], sign: [], resend: [] },
    steer_pending: { requeue: ["primary", "steer"], interrupt: ["turn-1"], sign: [], resend: [] },
    steer_delivered: { requeue: ["primary", "steer"], interrupt: ["turn-1"], sign: [], resend: [] },
    output_intent: { requeue: [], interrupt: ["turn-1"], sign: [REPLY_LOGICAL_ID], resend: [] },
    event_signed: { requeue: [], interrupt: ["turn-1"], sign: [], resend: ["reply-event"] },
    published: { requeue: [], interrupt: [], sign: [], resend: [] },
  };

  it.each(STAGES)("recovers from a crash after %s", (stage) => {
    crashAfter(stage);
    const plan = planRecovery(store.state, store.now());

    expectNoAcceptedInputLost(plan);
    expectNoDuplicateEventIds(plan);
    expect(plan.requeue.map((input) => input.record.eventId)).toEqual(expected[stage].requeue);
    expect(plan.interrupt.map((turn) => turn.turnId)).toEqual(expected[stage].interrupt);
    expect(plan.sign.map((intent) => intent.logicalId)).toEqual(expected[stage].sign);
    expect(plan.resend.map((row) => row.eventId)).toEqual(expected[stage].resend);
  });

  it.each(STAGES)("keeps the invariants after applying the plan for %s", (stage) => {
    crashAfter(stage);
    applyRecovery(store.state, planRecovery(store.state, store.now()));

    const plan = planRecovery(store.state, store.now());
    expectNoAcceptedInputLost(plan);
    expectNoDuplicateEventIds(plan);
    expect(plan.interrupt).toHaveLength(0);
  });
});

describe("inputs that arrived after the last output", () => {
  it("replays a delivered steer the model never answered", () => {
    const { state } = store;
    state.inbox.insertIfAbsent(inboxRecord({ eventId: "primary", receivedAt: 10 }));
    state.turns.create(turnRecord({ turnId: "turn-1", startedAt: 20 }));
    state.turns.addInput("turn-1", "primary", "primary", 0);
    state.inbox.assignToTurn("primary", "turn-1", 0, "prompted");
    state.turns.markInputDelivered("turn-1", "primary", store.advance(20));

    store.advance(10);
    state.outbox.putIntent(outputIntent({ logicalId: REPLY_LOGICAL_ID, turnId: "turn-1" }));
    state.outbox.putSigned(outboxRecord({ logicalId: REPLY_LOGICAL_ID, eventId: "reply-event" }));

    state.inbox.insertIfAbsent(inboxRecord({ eventId: "steer", receivedAt: store.advance(10) }));
    state.turns.addInput("turn-1", "steer", "steer", 1);
    state.inbox.assignToTurn("steer", "turn-1", 1, "steer_delivered");
    state.turns.markInputDelivered("turn-1", "steer", store.advance());

    const plan = planRecovery(store.state, store.now());

    expect(plan.requeue.map((input) => input.record.eventId)).toEqual(["steer"]);
    expect(plan.requeue[0]?.wasDelivered).toBe(true);
    expect(plan.resend.map((row) => row.eventId)).toEqual(["reply-event"]);
  });
});

describe("replay ordering across turns", () => {
  it("keeps each turn together and puts the backlog last", () => {
    const { state } = store;
    state.turns.create(turnRecord({ turnId: "turn-early", startedAt: 100 }));
    state.turns.create(turnRecord({ turnId: "turn-late", startedAt: 300 }));

    state.inbox.insertIfAbsent(inboxRecord({ eventId: "late-steer", receivedAt: 310 }));
    state.turns.addInput("turn-late", "late-steer", "steer", 1);
    state.inbox.assignToTurn("late-steer", "turn-late", 1, "steer_pending");

    state.inbox.insertIfAbsent(inboxRecord({ eventId: "backlog", receivedAt: 400 }));

    state.inbox.insertIfAbsent(inboxRecord({ eventId: "early-primary", receivedAt: 110 }));
    state.turns.addInput("turn-early", "early-primary", "primary", 0);
    state.inbox.assignToTurn("early-primary", "turn-early", 0, "steer_pending");

    state.inbox.insertIfAbsent(inboxRecord({ eventId: "other-channel", channelId: "channel-2", receivedAt: 5 }));

    const plan = planRecovery(store.state, store.now());

    expect(plan.requeue.map((input) => input.record.eventId)).toEqual([
      "early-primary",
      "late-steer",
      "backlog",
      "other-channel",
    ]);
  });
});

describe("publish retry budget", () => {
  beforeEach(() => {
    store.state.turns.create(turnRecord({ turnId: "turn-1", startedAt: 20 }));
    store.state.outbox.putIntent(outputIntent({ logicalId: REPLY_LOGICAL_ID, turnId: "turn-1" }));
    store.state.outbox.putSigned(
      outboxRecord({ logicalId: REPLY_LOGICAL_ID, eventId: "reply-event" }),
    );
  });

  it("defers events that are still backing off", () => {
    store.state.outbox.markFailed(REPLY_LOGICAL_ID, "rate-limited", 5_000);
    const plan = planRecovery(store.state, 4_000);

    expect(plan.resend).toHaveLength(0);
    expect(plan.deferred.map((row) => row.eventId)).toEqual(["reply-event"]);
    expect(plan.deadLetter).toHaveLength(0);
  });

  it("dead-letters an event that exhausted its budget", () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      store.state.outbox.markFailed(REPLY_LOGICAL_ID, "relay rejected", null);
    }
    const plan = planRecovery(store.state, 10_000, { maxPublishAttempts: 3 });

    expect(plan.resend).toHaveLength(0);
    expect(plan.deadLetter).toEqual([
      {
        logicalId: REPLY_LOGICAL_ID,
        eventId: "reply-event",
        attempts: 3,
        reason: "publish retry budget exhausted after 3 attempts",
      },
    ]);

    applyRecovery(store.state, plan);
    expect(planRecovery(store.state, 10_000, { maxPublishAttempts: 3 }).deadLetter).toHaveLength(0);
    expect(store.state.outbox.intentsForTurn("turn-1")[0]?.state).toBe("abandoned");
  });
});
