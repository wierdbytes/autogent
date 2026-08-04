import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/runtime/clock.js";
import { createSigner, type Signer } from "../src/nostr/signer.js";
import { KIND, tagValue, type NostrEvent } from "../src/nostr/types.js";
import type {
  EventBuilderPort,
  Logger,
  ObserverFrameDraft,
  SessionStateRepository,
} from "../src/runtime/ports.js";
import type { ObserverEvent } from "../src/telemetry/observer-envelope.js";
import {
  OBSERVER_FRAME_BUDGET_BYTES,
  OBSERVER_MAX_PLAINTEXT_BYTES,
} from "../src/telemetry/observer-envelope.js";
import {
  ObserverPublisher,
  UNSCOPED_SESSION_KEY,
  type ObserverPublisherOptions,
} from "../src/telemetry/observer-publisher.js";
import {
  assistantChunkFrame,
  frameDraft,
  toolCallUpdateFrame,
  turnCompletedFrame,
  turnStartedFrame,
  utf8ByteLength,
  type FrameRoute,
} from "../src/telemetry/buzz-desktop-compat.js";

const ROUTE = {
  channelId: "chan-1",
  sessionId: "sess-1",
  turnId: "turn-1",
} satisfies FrameRoute & { turnId: string };

/** Mirrors the durable session table without touching SQLite. */
class FakeSessionState implements SessionStateRepository {
  readonly seq = new Map<string, number>();
  readonly baselines = new Map<string, { turnSeq: number; counters: unknown }>();

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

function collectingLogger(errors: string[]): Logger {
  const logger: Logger = {
    error: (message) => errors.push(message),
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => logger,
  };
  return logger;
}

function builderFor(signer: Signer, clock: FakeClock): EventBuilderPort {
  return {
    build: (draft) =>
      signer.sign({
        pubkey: signer.publicKey,
        created_at: draft.created_at ?? Math.floor(clock.now() / 1000),
        kind: draft.kind,
        tags: draft.tags,
        content: draft.content,
      }),
  };
}

interface Harness {
  clock: FakeClock;
  agent: Signer;
  owner: Signer;
  sessions: FakeSessionState;
  published: NostrEvent[];
  publisher: ObserverPublisher;
  decrypt(event: NostrEvent): ObserverEvent;
}

function harness(
  overrides: Partial<ObserverPublisherOptions> = {},
  sessions = new FakeSessionState(),
): Harness {
  const clock = new FakeClock();
  const agent = createSigner(randomBytes(32));
  const owner = createSigner(randomBytes(32));
  const published: NostrEvent[] = [];
  const publisher = new ObserverPublisher({
    signer: agent,
    ownerPubkey: owner.publicKey,
    builder: builderFor(agent, clock),
    relay: { publishEphemeral: (event) => published.push(event) },
    sessions,
    clock,
    ...overrides,
  });
  return {
    clock,
    agent,
    owner,
    sessions,
    published,
    publisher,
    decrypt: (event) => JSON.parse(owner.decrypt(agent.publicKey, event.content)) as ObserverEvent,
  };
}

const emit = (publisher: ObserverPublisher, route: FrameRoute = ROUTE): void => {
  publisher.emit(frameDraft(turnCompletedFrame(), route));
};

describe("kind 24200 event shape", () => {
  it("tags the owner, the agent, the telemetry frame and the channel", () => {
    const h = harness();
    emit(h.publisher);

    const event = h.published[0] as NostrEvent;
    expect(event.kind).toBe(KIND.OBSERVER);
    expect(event.pubkey).toBe(h.agent.publicKey);
    expect(tagValue(event, "p")).toBe(h.owner.publicKey);
    expect(tagValue(event, "agent")).toBe(h.agent.publicKey);
    expect(tagValue(event, "frame")).toBe("telemetry");
    expect(tagValue(event, "h")).toBe("chan-1");
    expect(event.tags.filter((tag) => tag[0] === "p")).toHaveLength(1);
  });

  it("omits the channel tag when the frame is not channel-scoped", () => {
    const h = harness();
    h.publisher.emit(
      frameDraft(turnCompletedFrame(), { channelId: null, sessionId: "sess-1", turnId: null }),
    );

    expect(tagValue(h.published[0] as NostrEvent, "h")).toBeUndefined();
  });

  it("dates the event from the frame timestamp", () => {
    const h = harness();
    emit(h.publisher);

    const event = h.published[0] as NostrEvent;
    expect(event.created_at).toBe(Math.floor(Date.parse(h.decrypt(event).timestamp) / 1000));
  });
});

describe("NIP-44 addressing", () => {
  it("round-trips the envelope for the owner", async () => {
    const h = harness();
    h.publisher.emit(
      frameDraft(assistantChunkFrame("msg_1", "hello owner"), {
        ...ROUTE,
        startedAt: "2026-08-03T11:59:55.000Z",
      }),
    );
    await h.publisher.flush();

    const envelope = h.decrypt(h.published[0] as NostrEvent);
    expect(envelope).toEqual({
      seq: 1,
      timestamp: envelope.timestamp,
      kind: "acp_read",
      agentIndex: 0,
      channelId: "chan-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      startedAt: "2026-08-03T11:59:55.000Z",
      payload: assistantChunkFrame("msg_1", "hello owner").payload,
    });
  });

  it("omits startedAt entirely when the frame carries none", () => {
    const h = harness();
    emit(h.publisher);

    expect(h.decrypt(h.published[0] as NostrEvent)).not.toHaveProperty("startedAt");
  });

  it("is unreadable by anyone but the owner", () => {
    const h = harness();
    emit(h.publisher);

    const eve = createSigner(randomBytes(32));
    expect(() => eve.decrypt(h.agent.publicKey, (h.published[0] as NostrEvent).content)).toThrow();
    // The agent keeps read access: it is one half of the conversation key.
    expect(() =>
      JSON.parse(h.agent.decrypt(h.owner.publicKey, (h.published[0] as NostrEvent).content)),
    ).not.toThrow();
  });

  it("never leaves plaintext in the event content", async () => {
    const h = harness();
    h.publisher.emit(frameDraft(assistantChunkFrame("msg_1", "secret transcript"), ROUTE));
    await h.publisher.flush();

    expect((h.published[0] as NostrEvent).content).not.toContain("secret transcript");
  });
});

describe("sequence and ordering", () => {
  it("increases seq strictly within a session", () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) emit(h.publisher);

    expect(h.published.map((event) => h.decrypt(event).seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("continues the series across a restart from persisted state", () => {
    const sessions = new FakeSessionState();
    const first = harness({}, sessions);
    emit(first.publisher);
    emit(first.publisher);
    first.publisher.close();

    // A new process, a new publisher, the same durable session row.
    const second = harness({}, sessions);
    emit(second.publisher);

    expect(first.published.map((event) => first.decrypt(event).seq)).toEqual([1, 2]);
    expect(second.decrypt(second.published[0] as NostrEvent).seq).toBe(3);
  });

  it("counts session-less frames in their own bucket", () => {
    const h = harness();
    emit(h.publisher);
    h.publisher.emit(
      frameDraft(turnCompletedFrame(), { channelId: null, sessionId: null, turnId: null }),
    );

    expect(h.sessions.seq.get("sess-1")).toBe(1);
    expect(h.sessions.seq.get(UNSCOPED_SESSION_KEY)).toBe(1);
  });

  it("stamps ISO-8601 milliseconds that strictly increase", () => {
    const h = harness();
    for (let index = 0; index < 4; index += 1) emit(h.publisher);

    const timestamps = h.published.map((event) => h.decrypt(event).timestamp);
    for (const timestamp of timestamps) {
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    const parsed = timestamps.map((timestamp) => Date.parse(timestamp));
    // Distinct stamps keep Desktop's (seq, timestamp) dedup key unique even
    // though seq restarts per session.
    for (let index = 1; index < parsed.length; index += 1) {
      expect(parsed[index] as number).toBeGreaterThan(parsed[index - 1] as number);
    }
  });

  it("keeps two concurrent sessions distinguishable despite reused seq values", () => {
    const h = harness();
    emit(h.publisher, ROUTE);
    emit(h.publisher, { channelId: "chan-2", sessionId: "sess-2", turnId: "turn-2" });

    const envelopes = h.published.map((event) => h.decrypt(event));
    expect(envelopes.map((envelope) => envelope.seq)).toEqual([1, 1]);
    expect(envelopes[0]?.timestamp).not.toBe(envelopes[1]?.timestamp);
  });
});

describe("size enforcement", () => {
  it("splits an oversized tool result under the working budget", () => {
    const h = harness();
    const output = "x".repeat(OBSERVER_FRAME_BUDGET_BYTES * 3);
    h.publisher.emit(
      frameDraft(
        toolCallUpdateFrame({ toolCallId: "call_1", status: "completed", content: output }),
        ROUTE,
      ),
    );

    expect(h.published.length).toBeGreaterThan(3);
    const chunks = h.published.map((event) => h.decrypt(event));
    chunks.forEach((envelope, index) => {
      expect(utf8ByteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(
        OBSERVER_MAX_PLAINTEXT_BYTES,
      );
      const update = (envelope.payload as { params: { update: Record<string, unknown> } }).params
        .update;
      expect(update.chunkIndex).toBe(index + 1);
    });
    const rejoined = chunks
      .map((envelope) => {
        const update = (envelope.payload as { params: { update: { content: string } } }).params
          .update;
        return update.content.replace(/^\[result chunk \d+\/\d+]\n/, "");
      })
      .join("");
    expect(rejoined).toBe(output);
  });

  it("elides a frame that still exceeds the plaintext ceiling", () => {
    // A budget above the NIP-44 limit lets an unsplittable payload reach the
    // publisher's last-resort guard.
    const h = harness({ payloadBudgetBytes: OBSERVER_MAX_PLAINTEXT_BYTES * 2 });
    h.publisher.emit(
      frameDraft(turnStartedFrame([" ".repeat(OBSERVER_MAX_PLAINTEXT_BYTES)]), ROUTE),
    );

    const envelope = h.decrypt(h.published[0] as NostrEvent);
    expect(envelope.kind).toBe("acp_read");
    expect(envelope.payload).toMatchObject({ type: "observer_payload_elided" });
    expect(utf8ByteLength(JSON.stringify(envelope))).toBeLessThan(OBSERVER_MAX_PLAINTEXT_BYTES);
  });
});

describe("turn liveness", () => {
  it("heartbeats a quiet turn at the configured interval", async () => {
    const h = harness();
    const stop = h.publisher.trackTurn(ROUTE);
    await h.clock.advance(25_000);
    stop();

    const kinds = h.published.map((event) => h.decrypt(event).kind);
    expect(kinds).toEqual(["turn_liveness", "turn_liveness"]);
  });

  it("stays silent while the turn is producing frames", async () => {
    const h = harness();
    const stop = h.publisher.trackTurn(ROUTE);
    await h.clock.advance(5_000);
    emit(h.publisher);
    await h.clock.advance(5_000);
    stop();

    expect(h.published.map((event) => h.decrypt(event).kind)).toEqual(["turn_completed"]);
  });

  it("stops heartbeating once the turn is released", async () => {
    const h = harness();
    h.publisher.trackTurn(ROUTE)();
    await h.clock.advance(60_000);

    expect(h.published).toHaveLength(0);
  });
});

describe("failure containment", () => {
  it("logs and swallows a transport failure instead of failing the turn", () => {
    const errors: string[] = [];
    const h = harness({
      relay: {
        publishEphemeral: () => {
          throw new Error("relay socket closed");
        },
      },
      logger: collectingLogger(errors),
    });

    expect(() => emit(h.publisher)).not.toThrow();
    expect(errors).toEqual(["observer frame publish failed"]);
  });

  it("flushes coalesced frames on demand", async () => {
    const h = harness();
    h.publisher.emit(frameDraft(assistantChunkFrame("msg_1", "buffered"), ROUTE));
    expect(h.published).toHaveLength(0);

    await h.publisher.flush();
    expect(h.published).toHaveLength(1);
  });
});

describe("frame drafts", () => {
  it("honours an explicit agentIndex override", () => {
    const h = harness();
    const draft: ObserverFrameDraft = { ...frameDraft(turnCompletedFrame(), ROUTE), agentIndex: 3 };
    h.publisher.emit(draft);

    expect(h.decrypt(h.published[0] as NostrEvent).agentIndex).toBe(3);
  });
});
