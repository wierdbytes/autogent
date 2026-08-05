/**
 * Context fetcher dedup (see src/runtime/context-fetcher.ts): a continuing
 * session already holds its own replies and the triggers it was prompted with,
 * so those must not be re-injected — while a fresh session, whose only memory
 * is this context, must still get everything.
 */

import { describe, expect, it } from "vitest";
import { ContextFetcher } from "../src/runtime/context-fetcher.js";
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
  const fetcher = new ContextFetcher({
    relay,
    logger: nullLogger,
    limit: options.limit ?? 10,
    agentPubkey: AGENT_PUBKEY,
    deliveredDispositionOf: (eventId) => options.dispositions?.get(eventId) ?? null,
  });
  return fetcher;
}

function contents(context: { messages: Array<{ content: string }> } | null): string[] {
  return (context?.messages ?? []).map((message) => message.content);
}

describe("fresh session", () => {
  it("keeps agent replies and delivered triggers: context is the only memory seed", async () => {
    const userMessage = chatEvent({ channelId: CHANNEL, content: "question" });
    const agentReply = chatEvent({ secret: AGENT_SECRET, channelId: CHANNEL, content: "answer" });
    const trigger = chatEvent({ channelId: CHANNEL, content: "follow-up" });
    const fetcher = setup({
      events: [userMessage, agentReply, trigger],
      dispositions: new Map([[userMessage.id, "prompted"]]),
    });

    const context = await fetcher.fetch(trigger, trigger.id, { sessionHasHistory: false });

    expect(contents(context)).toEqual(["question", "answer"]);
    expect(context?.total).toBe(2);
    expect(context?.truncated).toBe(false);
  });
});

describe("continuing session", () => {
  it("drops the agent's own replies: the session has them as assistant messages", async () => {
    const userMessage = chatEvent({ channelId: CHANNEL, content: "question" });
    const agentReply = chatEvent({ secret: AGENT_SECRET, channelId: CHANNEL, content: "answer" });
    const trigger = chatEvent({ channelId: CHANNEL, content: "follow-up" });
    const fetcher = setup({ events: [userMessage, agentReply, trigger] });

    const context = await fetcher.fetch(trigger, trigger.id, { sessionHasHistory: true });

    expect(contents(context)).toEqual(["question"]);
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

    const context = await fetcher.fetch(trigger, trigger.id, { sessionHasHistory: true });

    expect(contents(context)).toEqual(["unseen"]);
  });

  it("keeps events that were never delivered, whatever their inbox state", async () => {
    const undelivered: InboxDisposition[] = ["queued", "rejected", "dead_letter"];
    const events = undelivered.map((disposition) =>
      chatEvent({ channelId: CHANNEL, content: disposition }),
    );
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    const fetcher = setup({
      events: [...events, trigger],
      dispositions: new Map(events.map((event, index) => [event.id, undelivered[index]!])),
    });

    const context = await fetcher.fetch(trigger, trigger.id, { sessionHasHistory: true });

    expect(contents(context)).toEqual(["queued", "rejected", "dead_letter"]);
  });

  it("computes total and truncated from the post-filter list", async () => {
    const users = ["one", "two", "three"].map((content) =>
      chatEvent({ channelId: CHANNEL, content }),
    );
    const agentNoise = ["a", "b"].map((content) =>
      chatEvent({ secret: AGENT_SECRET, channelId: CHANNEL, content }),
    );
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    const fetcher = setup({ events: [...users, ...agentNoise, trigger], limit: 2 });

    const context = await fetcher.fetch(trigger, trigger.id, { sessionHasHistory: true });

    // Filtered agent events must not count toward total or eat window slots.
    expect(context?.total).toBe(3);
    expect(context?.truncated).toBe(true);
    expect(contents(context)).toEqual(["two", "three"]);
  });

  it("returns null when filtering leaves nothing", async () => {
    const agentReply = chatEvent({ secret: AGENT_SECRET, channelId: CHANNEL, content: "answer" });
    const trigger = chatEvent({ channelId: CHANNEL, content: "go" });
    const fetcher = setup({ events: [agentReply, trigger] });

    const context = await fetcher.fetch(trigger, trigger.id, { sessionHasHistory: true });

    expect(context).toBeNull();
  });

  it("still scopes to the trigger's thread", async () => {
    const root = chatEvent({ channelId: CHANNEL, content: "thread root" });
    const inThread = replyEvent({ channelId: CHANNEL, content: "in thread", rootEventId: root.id });
    const otherThread = chatEvent({ channelId: CHANNEL, content: "elsewhere" });
    const trigger = replyEvent({ channelId: CHANNEL, content: "go", rootEventId: root.id });
    const fetcher = setup({ events: [root, inThread, otherThread, trigger] });

    const context = await fetcher.fetch(trigger, root.id, { sessionHasHistory: true });

    expect(context?.kind).toBe("thread");
    expect(contents(context)).toEqual(["thread root", "in thread"]);
  });
});
