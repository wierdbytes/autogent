/**
 * History fetcher (see src/runtime/history-fetcher.ts): `seed` mode rebuilds a
 * whole conversation for a fresh session — the agent's own replies included —
 * while `delta` mode returns only what a continuing session has not seen:
 * delivered triggers, the agent's replies and everything at or before the
 * watermark are dropped.
 */

import { describe, expect, it } from "vitest";
import { HistoryFetcher } from "../src/runtime/history-fetcher.js";
import { nullLogger } from "../src/runtime/logger.js";
import type { InboxDisposition } from "../src/runtime/ports.js";
import type { NostrEvent } from "../src/nostr/types.js";
import { FakeRelayPort } from "./helpers/fake-relay-port.js";
import { AGENT_PUBKEY, AGENT_SECRET, chatEvent, replyEvent } from "./helpers/fakes.js";

const CHANNEL = "11111111-2222-3333-4444-555555555555";

function setup(options: {
  events: NostrEvent[];
  limit?: number;
  dispositions?: Map<string, InboxDisposition>;
}) {
  const relay = new FakeRelayPort();
  relay.queryResponders.push(() => options.events);
  return new HistoryFetcher({
    relay,
    logger: nullLogger,
    limit: options.limit ?? 10,
    agentPubkey: AGENT_PUBKEY,
    dispositionOf: (eventId) => options.dispositions?.get(eventId) ?? null,
  });
}

function contents(messages: Array<{ content: string }>): string[] {
  return messages.map((message) => message.content);
}

describe("seed mode", () => {
  it("returns everything, marking the agent's own messages", async () => {
    const userMessage = chatEvent({ channelId: CHANNEL, content: "question" });
    const agentReply = chatEvent({ secret: AGENT_SECRET, channelId: CHANNEL, content: "answer" });
    const trigger = chatEvent({ channelId: CHANNEL, content: "follow-up" });
    const fetcher = setup({
      events: [userMessage, agentReply, trigger],
      dispositions: new Map([[userMessage.id, "prompted"]]),
    });

    const history = await fetcher.fetch(trigger, trigger.id, { mode: "seed" });

    expect(contents(history)).toEqual(["question", "answer"]);
    expect(history.map((message) => message.fromAgent)).toEqual([false, true]);
  });

  it("drops events queued for a turn of their own", async () => {
    const queued = chatEvent({ channelId: CHANNEL, content: "queued elsewhere" });
    const kept = chatEvent({ channelId: CHANNEL, content: "kept" });
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    const fetcher = setup({
      events: [queued, kept, trigger],
      dispositions: new Map([[queued.id, "queued"]]),
    });

    const history = await fetcher.fetch(trigger, trigger.id, { mode: "seed" });

    expect(contents(history)).toEqual(["kept"]);
  });

  it("windows to the newest `limit` messages", async () => {
    const events = ["one", "two", "three"].map((content) =>
      chatEvent({ channelId: CHANNEL, content }),
    );
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    const fetcher = setup({ events: [...events, trigger], limit: 2 });

    const history = await fetcher.fetch(trigger, trigger.id, { mode: "seed" });

    expect(contents(history)).toEqual(["two", "three"]);
  });

  it("scopes a threaded trigger to its thread", async () => {
    const root = chatEvent({ channelId: CHANNEL, content: "thread root" });
    const inThread = replyEvent({ channelId: CHANNEL, content: "in thread", rootEventId: root.id });
    const elsewhere = chatEvent({ channelId: CHANNEL, content: "elsewhere" });
    const trigger = replyEvent({ channelId: CHANNEL, content: "go", rootEventId: root.id });
    const fetcher = setup({ events: [root, inThread, elsewhere, trigger] });

    const history = await fetcher.fetch(trigger, root.id, { mode: "seed" });

    expect(contents(history)).toEqual(["thread root", "in thread"]);
  });

  it("returns [] when the fetch fails or the limit is zero", async () => {
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    const failing = new FakeRelayPort();
    failing.queryResponders.push(() => {
      throw new Error("relay down");
    });
    const fetcher = new HistoryFetcher({
      relay: failing,
      logger: nullLogger,
      limit: 10,
      agentPubkey: AGENT_PUBKEY,
    });
    expect(await fetcher.fetch(trigger, trigger.id, { mode: "seed" })).toEqual([]);

    const disabled = setup({ events: [trigger] });
    disabled.setLimit(0);
    expect(await disabled.fetch(trigger, trigger.id, { mode: "seed" })).toEqual([]);
  });
});

describe("delta mode", () => {
  it("drops the agent's own replies: the session has them as assistant turns", async () => {
    const userMessage = chatEvent({ channelId: CHANNEL, content: "question" });
    const agentReply = chatEvent({ secret: AGENT_SECRET, channelId: CHANNEL, content: "answer" });
    const trigger = chatEvent({ channelId: CHANNEL, content: "follow-up" });
    const fetcher = setup({ events: [userMessage, agentReply, trigger] });

    const history = await fetcher.fetch(trigger, trigger.id, { mode: "delta" });

    expect(contents(history)).toEqual(["question"]);
  });

  it("drops events already delivered to the session as prompts or steers", async () => {
    const delivered: InboxDisposition[] = [
      "prompted",
      "steer_pending",
      "steer_delivered",
      "completed",
    ];
    const events = delivered.map((disposition) =>
      chatEvent({ channelId: CHANNEL, content: disposition }),
    );
    const fresh = chatEvent({ channelId: CHANNEL, content: "unseen" });
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    const fetcher = setup({
      events: [...events, fresh, trigger],
      dispositions: new Map(events.map((event, index) => [event.id, delivered[index]!])),
    });

    const history = await fetcher.fetch(trigger, trigger.id, { mode: "delta" });

    expect(contents(history)).toEqual(["unseen"]);
  });

  it("keeps undelivered rejected/dead-letter events: history is their only way in", async () => {
    const undelivered: InboxDisposition[] = ["rejected", "dead_letter"];
    const events = undelivered.map((disposition) =>
      chatEvent({ channelId: CHANNEL, content: disposition }),
    );
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    const fetcher = setup({
      events: [...events, trigger],
      dispositions: new Map(events.map((event, index) => [event.id, undelivered[index]!])),
    });

    const history = await fetcher.fetch(trigger, trigger.id, { mode: "delta" });

    expect(contents(history)).toEqual(["rejected", "dead_letter"]);
  });

  it("drops everything at or before the watermark", async () => {
    const older = chatEvent({ channelId: CHANNEL, content: "older" });
    const newer = chatEvent({ channelId: CHANNEL, content: "newer" });
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    const fetcher = setup({ events: [older, newer, trigger] });

    const history = await fetcher.fetch(trigger, trigger.id, {
      mode: "delta",
      sinceExclusive: older.created_at,
    });

    expect(contents(history)).toEqual(["newer"]);
  });
});
