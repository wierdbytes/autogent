/**
 * NIP-AM agent turn metrics contracts (kind 44200).
 *
 * Mirrors docs/nips/NIP-AM.md in the Buzz repository. The payload is NIP-44
 * encrypted agent -> owner and carries no transcript content.
 */

/** One set of token/cost counters. `null` means "provider did not report it". */
export interface UsageCounters {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Provider-reported total. MUST NOT be synthesised as input + output. */
  totalTokens: number | null;
  costUsd: number | null;
  /** Informational subset of `inputTokens`. */
  cacheReadTokens: number | null;
  /** Informational subset of `inputTokens`. */
  cacheWriteTokens: number | null;
}

export type UsageStopReason = "end_turn" | "max_tokens" | "cancelled" | "error" | "unknown";

/** The decrypted body of a kind 44200 event. */
export interface UsageMetricPayload {
  /** Harness identifier. This service reports `pi`. */
  harness: string;
  model: string | null;
  channelId: string | null;
  /** Required whenever `cumulative` is present. */
  sessionId: string | null;
  turnId: string | null;
  /** Per-session monotonic counter. Required whenever `cumulative` is present. */
  turnSeq: number | null;
  /** RFC 3339 UTC with milliseconds, at end of turn. */
  timestamp: string;
  turn: UsageCounters | null;
  cumulative: UsageCounters | null;
  /** False when the publisher lost its baseline and per-turn deltas are unsound. */
  deltaReliable: boolean;
  stopReason?: UsageStopReason;
}

export const EMPTY_USAGE_COUNTERS: UsageCounters = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  costUsd: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

/** True when every counter is null, i.e. the metric would carry no information. */
export function countersAreEmpty(counters: UsageCounters | null): boolean {
  if (!counters) return true;
  return (
    counters.inputTokens === null &&
    counters.outputTokens === null &&
    counters.totalTokens === null &&
    counters.costUsd === null &&
    counters.cacheReadTokens === null &&
    counters.cacheWriteTokens === null
  );
}

/** Subtracts baseline from current, returning null for any unknown component. */
export function diffCounters(current: UsageCounters, baseline: UsageCounters): UsageCounters {
  const sub = (a: number | null, b: number | null): number | null => {
    if (a === null) return null;
    if (b === null) return a;
    const delta = a - b;
    return delta >= 0 ? delta : null;
  };
  return {
    inputTokens: sub(current.inputTokens, baseline.inputTokens),
    outputTokens: sub(current.outputTokens, baseline.outputTokens),
    totalTokens: sub(current.totalTokens, baseline.totalTokens),
    costUsd: sub(current.costUsd, baseline.costUsd),
    cacheReadTokens: sub(current.cacheReadTokens, baseline.cacheReadTokens),
    cacheWriteTokens: sub(current.cacheWriteTokens, baseline.cacheWriteTokens),
  };
}

/**
 * True when `current` went backwards relative to `baseline` on any known
 * counter. Per NIP-AM the consumer must then treat the turn delta as unknown,
 * so we set `deltaReliable: false` instead of publishing a bogus delta.
 */
export function countersRegressed(current: UsageCounters, baseline: UsageCounters): boolean {
  const pairs: Array<[number | null, number | null]> = [
    [current.inputTokens, baseline.inputTokens],
    [current.outputTokens, baseline.outputTokens],
    [current.totalTokens, baseline.totalTokens],
    [current.costUsd, baseline.costUsd],
  ];
  return pairs.some(([a, b]) => a !== null && b !== null && a < b);
}
