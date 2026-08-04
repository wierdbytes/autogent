/**
 * Crash recovery planning (plan §9.4).
 *
 * Planning is a pure read over durable state and never touches the relay, Pi or
 * the clock beyond the `now` it is handed. Execution is split into
 * `applyRecovery` (state transitions, one transaction) and the caller's own
 * publishing loop, so the decisions can be asserted in unit tests exactly as the
 * process would take them after a real crash.
 */

import type {
  InboxRecord,
  OutboxRecord,
  OutputIntent,
  TurnRecord,
  TurnState,
} from "../runtime/ports.js";
import type { TurnInputRole } from "../runtime/turn-context.js";
import type { AgentState } from "./database.js";
import type { TurnInputRecord } from "./turn-repository.js";

/** Stop reason recorded on turns that a crash cut short. */
export const INTERRUPTED_STOP_REASON = "crash_recovery";

/** Publish attempts after which an event is dead-lettered instead of retried. */
export const DEFAULT_MAX_PUBLISH_ATTEMPTS = 8;

export interface RecoveryOptions {
  maxPublishAttempts?: number;
}

export interface InterruptedTurn {
  turnId: string;
  channelId: string;
  threadRootId: string;
  primaryTriggerEventId: string;
  primaryAuthorPubkey: string;
  previousState: TurnState;
  stopReason: string;
}

export interface RequeuedInput {
  record: InboxRecord;
  /** Turn the input belonged to before the crash, if it reached one. */
  previousTurnId: string | null;
  role: TurnInputRole | null;
  /**
   * True when the input already reached the Pi session and is replayed only
   * because the turn never produced any output for it.
   */
  wasDelivered: boolean;
}

export interface DeadLetter {
  logicalId: string;
  eventId: string;
  attempts: number;
  reason: string;
}

export interface RecoveryPlan {
  /** Signed events to hand back to the publisher verbatim, same event id. */
  resend: OutboxRecord[];
  /** Unacknowledged events still inside their backoff window. */
  deferred: OutboxRecord[];
  /** Intents that never reached the signer; no event id exists for them yet. */
  sign: OutputIntent[];
  /** Turns to move to `interrupted`. */
  interrupt: InterruptedTurn[];
  /** Inputs to hand back to the scheduler, in the order they must be replayed. */
  requeue: RequeuedInput[];
  /** Events whose publish retry budget is spent. */
  deadLetter: DeadLetter[];
}

export function planRecovery(
  state: AgentState,
  now: number,
  options: RecoveryOptions = {},
): RecoveryPlan {
  const maxAttempts = options.maxPublishAttempts ?? DEFAULT_MAX_PUBLISH_ATTEMPTS;
  const resend: OutboxRecord[] = [];
  const deferred: OutboxRecord[] = [];
  const deadLetter: DeadLetter[] = [];

  for (const record of state.outbox.unpublished()) {
    if (record.attempts >= maxAttempts) {
      deadLetter.push({
        logicalId: record.logicalId,
        eventId: record.eventId,
        attempts: record.attempts,
        reason: `publish retry budget exhausted after ${record.attempts} attempts`,
      });
    } else if (record.nextRetryAt !== null && record.nextRetryAt > now) {
      deferred.push(record);
    } else {
      resend.push(record);
    }
  }

  return {
    resend,
    deferred,
    sign: state.outbox.unsignedIntents(),
    interrupt: state.turns.unfinished().map(toInterrupted),
    requeue: planRequeue(state),
    deadLetter,
  };
}

/**
 * Applies the state transitions of a plan.
 *
 * One transaction, so a crash during recovery re-runs the same plan rather than
 * leaving half of it applied. Publishing `plan.resend` / `plan.sign` stays with
 * the caller: it needs the relay, and it must be safe to retry afterwards.
 */
export function applyRecovery(state: AgentState, plan: RecoveryPlan): void {
  state.transaction(() => {
    for (const turn of plan.interrupt) {
      state.turns.setState(turn.turnId, "interrupted", turn.stopReason);
    }
    for (const input of plan.requeue) {
      // The link to the dead turn is left in place on purpose: it is what keeps a
      // second recovery pass replaying these inputs in their original ordinal
      // order instead of falling back to arrival time. The scheduler overwrites it
      // when the recovery turn claims the input.
      state.inbox.setDisposition(input.record.eventId, "queued");
    }
    for (const entry of plan.deadLetter) {
      state.outbox.markDeadLetter(entry.logicalId, entry.reason);
    }
  });
}

function toInterrupted(turn: TurnRecord): InterruptedTurn {
  return {
    turnId: turn.turnId,
    channelId: turn.channelId,
    threadRootId: turn.threadRootId,
    primaryTriggerEventId: turn.primaryTriggerEventId,
    primaryAuthorPubkey: turn.primaryAuthorPubkey,
    previousState: turn.state,
    stopReason: INTERRUPTED_STOP_REASON,
  };
}

interface ReplayCandidate {
  input: RequeuedInput;
  groupId: string;
  groupAt: number;
  ordinal: number;
}

function planRequeue(state: AgentState): RequeuedInput[] {
  const turns = new TurnLookup(state);
  const requeue: RequeuedInput[] = [];
  for (const channelId of state.inbox.unsettledChannels()) {
    const candidates: ReplayCandidate[] = [];
    for (const record of state.inbox.unsettledForChannel(channelId)) {
      const candidate = considerReplay(record, turns);
      if (candidate !== undefined) candidates.push(candidate);
    }
    candidates.sort(compareReplay);
    for (const candidate of candidates) requeue.push(candidate.input);
  }
  return requeue;
}

/**
 * Decides whether an unsettled input has to run again.
 *
 * Inputs that never reached Pi always replay. Inputs that did are replayed only
 * when their turn produced no output after they were delivered: the model may
 * see them twice, which the plan accepts, but a user message that was never
 * answered must not be dropped, and a message that *was* answered must not be
 * answered a second time.
 */
function considerReplay(record: InboxRecord, turns: TurnLookup): ReplayCandidate | undefined {
  const turnId = record.turnId;
  const turn = turnId === null ? undefined : turns.turn(turnId);
  const input = turnId === null ? undefined : turns.input(turnId, record.eventId);
  const deliveredAt = input?.deliveredAt ?? null;
  if (turnId !== null && deliveredAt !== null && answeredAfter(turns, turnId, deliveredAt)) {
    return undefined;
  }

  return {
    input: {
      record,
      previousTurnId: turnId,
      role: input?.role ?? null,
      wasDelivered: deliveredAt !== null,
    },
    // Inputs of one turn replay together, ordered by the ordinal they were
    // accepted with, so the recovery turn keeps the original primary as its
    // reply target and steers land after it. Unassigned backlog rows form their
    // own single-entry group positioned by arrival.
    groupId: turnId ?? record.eventId,
    groupAt: turn?.startedAt ?? record.receivedAt,
    ordinal: input?.ordinal ?? record.inputOrdinal ?? 0,
  };
}

function answeredAfter(turns: TurnLookup, turnId: string, deliveredAt: number): boolean {
  const answeredAt = turns.latestIntentAt(turnId);
  return answeredAt !== null && answeredAt > deliveredAt;
}

function compareReplay(a: ReplayCandidate, b: ReplayCandidate): number {
  return (
    a.groupAt - b.groupAt ||
    compareText(a.groupId, b.groupId) ||
    a.ordinal - b.ordinal ||
    a.input.record.receivedAt - b.input.record.receivedAt ||
    compareText(a.input.record.eventId, b.input.record.eventId)
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Per-turn reads memoised for the duration of one planning pass. */
class TurnLookup {
  readonly #state: AgentState;
  readonly #turns = new Map<string, TurnRecord | undefined>();
  readonly #inputs = new Map<string, Map<string, TurnInputRecord>>();
  readonly #answeredAt = new Map<string, number | null>();

  constructor(state: AgentState) {
    this.#state = state;
  }

  turn(turnId: string): TurnRecord | undefined {
    if (!this.#turns.has(turnId)) this.#turns.set(turnId, this.#state.turns.get(turnId));
    return this.#turns.get(turnId);
  }

  input(turnId: string, eventId: string): TurnInputRecord | undefined {
    let byEvent = this.#inputs.get(turnId);
    if (byEvent === undefined) {
      byEvent = new Map(this.#state.turns.inputs(turnId).map((input) => [input.eventId, input]));
      this.#inputs.set(turnId, byEvent);
    }
    return byEvent.get(eventId);
  }

  latestIntentAt(turnId: string): number | null {
    let answered = this.#answeredAt.get(turnId);
    if (answered === undefined) {
      answered = this.#state.outbox.latestIntentAt(turnId);
      this.#answeredAt.set(turnId, answered);
    }
    return answered;
  }
}
