import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/runtime/clock.js";
import { createSigner, type Signer } from "../src/nostr/signer.js";
import { KIND, tagValue, type NostrEvent } from "../src/nostr/types.js";
import type { EventBuilderPort, PiUsage, SessionStateRepository } from "../src/runtime/ports.js";
import {
  EMPTY_USAGE_COUNTERS,
  type UsageCounters,
  type UsageMetricPayload,
} from "../src/telemetry/usage-types.js";
import {
  PI_HARNESS,
  UsageTracker,
  addCounters,
  deriveTurnDelta,
  normalisePiUsage,
  parseCounters,
} from "../src/telemetry/usage-tracker.js";
import { UsagePublisher } from "../src/telemetry/usage-publisher.js";

class FakeSessionState implements SessionStateRepository {
  readonly seq = new Map<string, number>();
  baselines = new Map<string, { turnSeq: number; counters: unknown }>();

  nextObserverSeq(sessionId: string): number {
    const next = (this.seq.get(sessionId) ?? 0) + 1;
    this.seq.set(sessionId, next);
    return next;
  }
  getUsageBaseline(sessionId: string): { turnSeq: number; counters: unknown } | undefined {
    return this.baselines.get(sessionId);
  }
  setUsageBaseline(sessionId: string, turnSeq: number, counters: unknown): void {
    this.baselines.set(sessionId, { turnSeq, counters });
  }
}

const usage = (values: Partial<PiUsage>): PiUsage => ({
  input: null,
  output: null,
  total: null,
  cacheRead: null,
  cacheWrite: null,
  costUsd: null,
  ...values,
});

const counters = (values: Partial<UsageCounters>): UsageCounters => ({
  ...EMPTY_USAGE_COUNTERS,
  ...values,
});

const settleArgs = {
  sessionId: "sess-1",
  turnId: "turn-1",
  channelId: "chan-1",
  model: "claude-sonnet-4-5",
} as const;

function trackerHarness(sessions = new FakeSessionState()) {
  const clock = new FakeClock();
  return { clock, sessions, tracker: new UsageTracker({ sessions, clock }) };
}

describe("counter normalisation", () => {
  it("folds cache reads and writes into the inclusive input total", () => {
    expect(normalisePiUsage(usage({ input: 100, cacheRead: 40, cacheWrite: 10 }))).toEqual(
      counters({
        inputTokens: 150,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
      }),
    );
  });

  it("never synthesises totalTokens from input and output", () => {
    expect(normalisePiUsage(usage({ input: 100, output: 20 })).totalTokens).toBeNull();
    expect(normalisePiUsage(usage({ input: 100, output: 20, total: 130 })).totalTokens).toBe(130);
  });

  it("keeps an unknown counter unknown when nothing reports it", () => {
    expect(addCounters(EMPTY_USAGE_COUNTERS, EMPTY_USAGE_COUNTERS).inputTokens).toBeNull();
    expect(addCounters(counters({ inputTokens: 5 }), EMPTY_USAGE_COUNTERS).inputTokens).toBe(5);
    expect(addCounters(EMPTY_USAGE_COUNTERS, counters({ inputTokens: 5 })).inputTokens).toBe(5);
  });
});

describe("delta derivation", () => {
  it("subtracts the baseline from the cumulative snapshot", () => {
    const result = deriveTurnDelta(
      counters({ inputTokens: 500, outputTokens: 120, totalTokens: 640, costUsd: 0.5 }),
      counters({ inputTokens: 300, outputTokens: 100, totalTokens: 410, costUsd: 0.3 }),
    );
    expect(result.deltaReliable).toBe(true);
    expect(result.turn).toEqual(
      counters({ inputTokens: 200, outputTokens: 20, totalTokens: 230, costUsd: 0.2 }),
    );
  });

  it("nulls the turn and drops reliability when a counter goes backwards", () => {
    const result = deriveTurnDelta(
      counters({ inputTokens: 100, outputTokens: 10 }),
      counters({ inputTokens: 300, outputTokens: 10 }),
    );
    expect(result).toEqual({ turn: null, deltaReliable: false });
  });
});

describe("baseline parsing", () => {
  it("accepts a round-tripped counter set", () => {
    const stored = JSON.parse(JSON.stringify(counters({ inputTokens: 7, costUsd: 0.25 })));
    expect(parseCounters(stored)).toEqual(counters({ inputTokens: 7, costUsd: 0.25 }));
  });

  it("rejects anything it cannot trust as a baseline", () => {
    expect(parseCounters(null)).toBeNull();
    expect(parseCounters({ inputTokens: -1 })).toBeNull();
    expect(parseCounters({ ...counters({}), inputTokens: "many" })).toBeNull();
    expect(parseCounters({ inputTokens: 1 })).toBeNull();
  });
});

describe("usage tracker", () => {
  it("sums the turn's model calls and starts the session series", () => {
    const { tracker } = trackerHarness();
    tracker.observe("sess-1", "turn-1", usage({ input: 100, output: 20, total: 120, costUsd: 0.1 }));
    tracker.observe("sess-1", "turn-1", usage({ input: 50, output: 10, total: 60, costUsd: 0.05 }));

    const metric = tracker.settle({ ...settleArgs, stopReason: "end_turn" });
    expect(metric).not.toBeNull();
    expect(metric?.harness).toBe(PI_HARNESS);
    expect(metric?.turnSeq).toBe(1);
    expect(metric?.deltaReliable).toBe(true);
    expect(metric?.stopReason).toBe("end_turn");
    expect(metric?.turn).toMatchObject({ inputTokens: 150, outputTokens: 30, totalTokens: 180 });
    expect(metric?.turn?.costUsd).toBeCloseTo(0.15, 10);
    expect(metric?.cumulative).toEqual(metric?.turn);
  });

  it("derives the second turn's delta from the cumulative series", () => {
    const { tracker } = trackerHarness();
    tracker.observe("sess-1", "turn-1", usage({ input: 100, output: 20, total: 120 }));
    tracker.settle(settleArgs);
    tracker.observe("sess-1", "turn-2", usage({ input: 300, output: 40, total: 340 }));

    const metric = tracker.settle({ ...settleArgs, turnId: "turn-2" });
    expect(metric?.turnSeq).toBe(2);
    expect(metric?.turn).toEqual(counters({ inputTokens: 300, outputTokens: 40, totalTokens: 340 }));
    expect(metric?.cumulative).toEqual(
      counters({ inputTokens: 400, outputTokens: 60, totalTokens: 460 }),
    );
  });

  it("persists the cumulative baseline and resumes it after a restart", () => {
    const sessions = new FakeSessionState();
    const first = trackerHarness(sessions);
    first.tracker.observe("sess-1", "turn-1", usage({ input: 100, output: 20, total: 120 }));
    first.tracker.settle(settleArgs);

    const second = trackerHarness(sessions);
    second.tracker.observe("sess-1", "turn-2", usage({ input: 10, output: 5, total: 15 }));
    const metric = second.tracker.settle({ ...settleArgs, turnId: "turn-2" });

    expect(metric?.turnSeq).toBe(2);
    expect(metric?.deltaReliable).toBe(true);
    expect(metric?.cumulative).toEqual(
      counters({ inputTokens: 110, outputTokens: 25, totalTokens: 135 }),
    );
  });

  it("marks the metric unreliable when the durable baseline cannot be read back", () => {
    const sessions = new FakeSessionState();
    sessions.baselines.set("sess-1", { turnSeq: 4, counters: { corrupted: true } });
    const { tracker } = trackerHarness(sessions);
    tracker.observe("sess-1", "turn-5", usage({ input: 10, output: 2, total: 12 }));

    const metric = tracker.settle({ ...settleArgs, turnId: "turn-5" });
    expect(metric?.deltaReliable).toBe(false);
    expect(metric?.turnSeq).toBe(5);
  });

  it("publishes nothing when the turn observed no usage", () => {
    const { tracker } = trackerHarness();
    expect(tracker.settle(settleArgs)).toBeNull();

    tracker.observe("sess-1", "turn-1", usage({}));
    expect(tracker.settle(settleArgs)).toBeNull();
  });

  it("does not advance the series for a discarded turn", () => {
    const { tracker, sessions } = trackerHarness();
    tracker.observe("sess-1", "turn-1", usage({ input: 100, total: 100 }));
    tracker.discard("sess-1", "turn-1");

    expect(tracker.settle(settleArgs)).toBeNull();
    expect(sessions.baselines.size).toBe(0);
  });

  it("always carries the session key that makes cumulative orderable", () => {
    const { tracker } = trackerHarness();
    tracker.observe("sess-1", "turn-1", usage({ input: 1, total: 1 }));

    const metric = tracker.settle(settleArgs) as UsageMetricPayload;
    expect(metric.cumulative).not.toBeNull();
    expect(metric.sessionId).toBe("sess-1");
    expect(metric.turnSeq).toBe(1);
    expect(metric.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

function publisherHarness() {
  const clock = new FakeClock();
  const agent = createSigner(randomBytes(32));
  const owner = createSigner(randomBytes(32));
  const outbox: NostrEvent[] = [];
  const builder: EventBuilderPort = {
    build: (draft) =>
      agent.sign({
        pubkey: agent.publicKey,
        created_at: draft.created_at ?? Math.floor(clock.now() / 1000),
        kind: draft.kind,
        tags: draft.tags,
        content: draft.content,
      }),
  };
  const publisher = new UsagePublisher({
    signer: agent,
    ownerPubkey: owner.publicKey,
    builder,
    publish: (event) => {
      outbox.push(event);
    },
  });
  return { agent, owner, outbox, publisher, decrypt: decryptWith(owner, agent) };
}

const decryptWith =
  (owner: Signer, agent: Signer) =>
  (event: NostrEvent): UsageMetricPayload =>
    JSON.parse(owner.decrypt(agent.publicKey, event.content)) as UsageMetricPayload;

const metricFixture = (overrides: Partial<UsageMetricPayload> = {}): UsageMetricPayload => ({
  harness: PI_HARNESS,
  model: "claude-sonnet-4-5",
  channelId: "chan-1",
  sessionId: "sess-1",
  turnId: "turn-1",
  turnSeq: 1,
  timestamp: "2026-08-03T12:00:00.123Z",
  turn: counters({ inputTokens: 150, outputTokens: 30, totalTokens: 180 }),
  cumulative: counters({ inputTokens: 150, outputTokens: 30, totalTokens: 180 }),
  deltaReliable: true,
  ...overrides,
});

describe("kind 44200 publisher", () => {
  it("tags only the owner and the agent, never the channel", async () => {
    const h = publisherHarness();
    await h.publisher.publish(metricFixture());

    const event = h.outbox[0] as NostrEvent;
    expect(event.kind).toBe(KIND.USAGE_METRIC);
    expect(tagValue(event, "p")).toBe(h.owner.publicKey);
    expect(tagValue(event, "agent")).toBe(h.agent.publicKey);
    // The channel a turn served stays inside the ciphertext (NIP-AM).
    expect(tagValue(event, "h")).toBeUndefined();
    expect(event.tags).toHaveLength(2);
  });

  it("round-trips the payload for the owner alone", async () => {
    const h = publisherHarness();
    const payload = metricFixture();
    await h.publisher.publish(payload);

    const event = h.outbox[0] as NostrEvent;
    expect(h.decrypt(event)).toEqual(payload);
    expect(event.content).not.toContain("chan-1");
    const eve = createSigner(randomBytes(32));
    expect(() => eve.decrypt(h.agent.publicKey, event.content)).toThrow();
  });

  it("dates the event from the payload timestamp", async () => {
    const h = publisherHarness();
    await h.publisher.publish(metricFixture());

    expect((h.outbox[0] as NostrEvent).created_at).toBe(
      Math.floor(Date.parse("2026-08-03T12:00:00.123Z") / 1000),
    );
  });

  it("refuses to publish an all-unknown metric", async () => {
    const h = publisherHarness();
    const published = await h.publisher.publish(
      metricFixture({ turn: EMPTY_USAGE_COUNTERS, cumulative: null }),
    );

    expect(published).toBe(false);
    expect(h.outbox).toHaveLength(0);
  });

  it("rejects a cumulative series without its ordering key", async () => {
    const h = publisherHarness();
    await expect(h.publisher.publish(metricFixture({ turnSeq: null }))).rejects.toThrow(
      /turnSeq/,
    );
    await expect(h.publisher.publish(metricFixture({ sessionId: null }))).rejects.toThrow(
      /sessionId/,
    );
  });

  it("carries an unreliable delta through to the owner", async () => {
    const h = publisherHarness();
    await h.publisher.publish(metricFixture({ turn: null, deltaReliable: false }));

    const payload = h.decrypt(h.outbox[0] as NostrEvent);
    expect(payload.turn).toBeNull();
    expect(payload.deltaReliable).toBe(false);
  });
});

describe("tracker and publisher end to end", () => {
  it("moves one turn's usage from Pi events to a signed durable event", async () => {
    const { tracker } = trackerHarness();
    const h = publisherHarness();
    tracker.observe(
      "sess-1",
      "turn-1",
      usage({ input: 900, output: 120, total: 1_020, cacheRead: 100, costUsd: 0.031 }),
    );

    const metric = tracker.settle({ ...settleArgs, stopReason: "end_turn" });
    expect(metric).not.toBeNull();
    expect(await h.publisher.publish(metric as UsageMetricPayload)).toBe(true);

    const payload = h.decrypt(h.outbox[0] as NostrEvent);
    expect(payload.harness).toBe("pi");
    expect(payload.turn?.inputTokens).toBe(1_000);
    expect(payload.turn?.cacheReadTokens).toBe(100);
    expect(payload.turn?.totalTokens).toBe(1_020);
    expect(payload.stopReason).toBe("end_turn");
  });
});
