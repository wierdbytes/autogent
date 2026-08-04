/**
 * NIP-AM usage accounting (plan §6.8).
 *
 * Pi reports usage per model call; NIP-AM wants one metric per turn plus a
 * session-cumulative series the owner can diff. This module owns that
 * arithmetic and the durability of the cumulative baseline, and refuses to
 * invent any number the provider did not report.
 */

import type { Clock, PiUsage, SessionStateRepository } from "../runtime/ports.js";
import { observerTimestamp } from "./observer-envelope.js";
import {
  EMPTY_USAGE_COUNTERS,
  countersAreEmpty,
  countersRegressed,
  diffCounters,
  type UsageCounters,
  type UsageMetricPayload,
  type UsageStopReason,
} from "./usage-types.js";

/** Harness identifier this service reports. */
export const PI_HARNESS = "pi";

/**
 * Converts one Pi model-call sample into NIP-AM counters.
 *
 * Pi prices `input`, `cacheRead` and `cacheWrite` separately, so `input`
 * excludes cached tokens. NIP-AM defines `inputTokens` as the inclusive
 * input-side total with the cache components repeated as informational
 * subsets, so they are folded in here rather than reported alongside.
 */
export function normalisePiUsage(usage: PiUsage): UsageCounters {
  return {
    inputTokens: addCounter(addCounter(usage.input, usage.cacheRead), usage.cacheWrite),
    outputTokens: usage.output,
    // Never derived from input + output: a provider total may count categories
    // a simple sum misses, so an unreported total stays unknown.
    totalTokens: usage.total,
    costUsd: usage.costUsd,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

/** Adds two counter sets. Unknown contributes nothing but never zeroes a known value. */
export function addCounters(left: UsageCounters, right: UsageCounters): UsageCounters {
  return {
    inputTokens: addCounter(left.inputTokens, right.inputTokens),
    outputTokens: addCounter(left.outputTokens, right.outputTokens),
    totalTokens: addCounter(left.totalTokens, right.totalTokens),
    costUsd: addCounter(left.costUsd, right.costUsd),
    cacheReadTokens: addCounter(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: addCounter(left.cacheWriteTokens, right.cacheWriteTokens),
  };
}

function addCounter(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

/**
 * The NIP-AM delta rule: a cumulative counter that moves backwards means the
 * series is broken, and the consumer must see "unknown" rather than a fabricated
 * or negative turn figure.
 */
export function deriveTurnDelta(
  cumulative: UsageCounters,
  baseline: UsageCounters,
): { turn: UsageCounters | null; deltaReliable: boolean } {
  if (countersRegressed(cumulative, baseline)) return { turn: null, deltaReliable: false };
  return { turn: diffCounters(cumulative, baseline), deltaReliable: true };
}

/** Narrows the `unknown` counters the session repository round-trips. */
export function parseCounters(value: unknown): UsageCounters | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const read = (key: string): number | null | undefined => {
    const candidate = record[key];
    if (candidate === null) return null;
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
    return undefined;
  };
  const counters: Record<keyof UsageCounters, number | null> = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  };
  for (const key of Object.keys(counters) as Array<keyof UsageCounters>) {
    const parsed = read(key);
    if (parsed === undefined) return null;
    counters[key] = parsed;
  }
  return counters;
}

export interface UsageTrackerOptions {
  sessions: SessionStateRepository;
  clock: Clock;
  harness?: string;
}

export interface SettleTurnArgs {
  sessionId: string;
  turnId: string;
  channelId: string | null;
  model: string | null;
  stopReason?: UsageStopReason;
}

interface SessionUsageState {
  turnSeq: number;
  cumulative: UsageCounters;
  /** False when a durable baseline existed but could not be read back. */
  baselineKnown: boolean;
}

export class UsageTracker {
  readonly #sessions: SessionStateRepository;
  readonly #clock: Clock;
  readonly #harness: string;
  readonly #sessionState = new Map<string, SessionUsageState>();
  readonly #turnTotals = new Map<string, UsageCounters>();

  constructor(options: UsageTrackerOptions) {
    this.#sessions = options.sessions;
    this.#clock = options.clock;
    this.#harness = options.harness ?? PI_HARNESS;
  }

  /** Records one model call's usage against the turn that produced it. */
  observe(sessionId: string, turnId: string, usage: PiUsage): void {
    const key = turnKey(sessionId, turnId);
    const previous = this.#turnTotals.get(key) ?? EMPTY_USAGE_COUNTERS;
    this.#turnTotals.set(key, addCounters(previous, normalisePiUsage(usage)));
  }

  /** Discards a turn's samples without advancing the session series. */
  discard(sessionId: string, turnId: string): void {
    this.#turnTotals.delete(turnKey(sessionId, turnId));
  }

  /**
   * Produces the turn's metric and advances the durable cumulative baseline.
   *
   * Returns null when the turn observed no usage at all: NIP-AM forbids
   * publishing an all-unknown metric, which would carry no information while
   * still leaking the turn's existence to the relay operator.
   */
  settle(args: SettleTurnArgs): UsageMetricPayload | null {
    const key = turnKey(args.sessionId, args.turnId);
    const turnTotal = this.#turnTotals.get(key);
    this.#turnTotals.delete(key);
    if (!turnTotal || countersAreEmpty(turnTotal)) return null;

    const state = this.#state(args.sessionId);
    const baseline = state.cumulative;
    const cumulative = addCounters(baseline, turnTotal);
    const { turn, deltaReliable } = deriveTurnDelta(cumulative, baseline);

    state.turnSeq += 1;
    state.cumulative = cumulative;
    this.#sessions.setUsageBaseline(args.sessionId, state.turnSeq, cumulative);

    return {
      harness: this.#harness,
      model: args.model,
      channelId: args.channelId,
      // `cumulative` is always present here, and NIP-AM makes both of these
      // mandatory in that case — they are the series key consumers order on.
      sessionId: args.sessionId,
      turnId: args.turnId,
      turnSeq: state.turnSeq,
      timestamp: observerTimestamp(this.#clock.now()),
      turn,
      cumulative,
      deltaReliable: deltaReliable && state.baselineKnown,
      ...(args.stopReason === undefined ? {} : { stopReason: args.stopReason }),
    };
  }

  /**
   * Restores the session's series from durable state.
   *
   * A record whose counters no longer parse means a previous process published
   * a baseline we cannot reproduce; the series continues from zero but every
   * metric of this session is marked unreliable so the owner does not treat the
   * first delta as real usage.
   */
  #state(sessionId: string): SessionUsageState {
    const existing = this.#sessionState.get(sessionId);
    if (existing) return existing;
    const stored = this.#sessions.getUsageBaseline(sessionId);
    const counters = stored ? parseCounters(stored.counters) : null;
    const state: SessionUsageState = {
      turnSeq: stored?.turnSeq ?? 0,
      cumulative: counters ?? EMPTY_USAGE_COUNTERS,
      baselineKnown: stored === undefined || counters !== null,
    };
    this.#sessionState.set(sessionId, state);
    return state;
  }
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}|${turnId}`;
}
