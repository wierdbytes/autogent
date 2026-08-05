import { describe, expect, it } from "vitest";
import {
  formatEventBlock,
  formatPrimaryPrompt,
  formatSteeringPrompt,
} from "../src/runtime/prompt-formatter.js";
import { chatEvent, replyEvent, USER_A_PUBKEY } from "./helpers/fakes.js";

const CHANNEL = { channelId: "chan-1", name: "general", channelType: "stream" as const };

/**
 * The exact regexes Buzz Desktop uses in
 * `desktop/src/features/agents/ui/agentSessionTranscript.ts`. If our prompt
 * stops matching them, the stock viewer silently loses the user's identity on
 * every message, so they are asserted here rather than described.
 */
const DESKTOP_AUTHOR_RE = /^From:.*\bhex:\s*([0-9a-fA-F]{64})/m;
const DESKTOP_EVENT_ID_RE = /^Event ID:\s*([0-9a-fA-F]{64})\b/m;
const DESKTOP_SECTION_RE = /^\[([^\]]+)]\s*$/;

/** Mirrors Desktop's section splitter. */
function parseSections(text: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string }> = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of text.split("\n")) {
    const match = DESKTOP_SECTION_RE.exec(line);
    if (match) {
      if (current) sections.push({ title: current.title, body: current.body.join("\n") });
      current = { title: match[1] as string, body: [] };
      continue;
    }
    current?.body.push(line);
  }
  if (current) sections.push({ title: current.title, body: current.body.join("\n") });
  return sections;
}

/** Mirrors Desktop's choice of which section holds the user's message. */
function userSection(text: string) {
  return parseSections(text).find((section) => section.title.toLowerCase().startsWith("buzz event"));
}

describe("Desktop prompt parsing compatibility", () => {
  const event = chatEvent({ channelId: CHANNEL.channelId, content: "please summarise the thread" });
  const prompt = formatPrimaryPrompt({ event, channel: CHANNEL, promptTag: "@mention" });

  it("exposes the author pubkey where Desktop looks for it", () => {
    expect(DESKTOP_AUTHOR_RE.exec(prompt)?.[1]).toBe(USER_A_PUBKEY);
  });

  it("exposes the triggering event id where Desktop looks for it", () => {
    expect(DESKTOP_EVENT_ID_RE.exec(prompt)?.[1]).toBe(event.id);
  });

  it("puts the user's message in a [Buzz event: …] section", () => {
    const section = userSection(prompt);
    expect(section).toBeDefined();
    expect(section?.title).toBe("Buzz event: @mention");
    expect(section?.body).toContain("please summarise the thread");
  });

  it("emits a [Context] section before the event block", () => {
    const titles = parseSections(prompt).map((section) => section.title);
    expect(titles[0]).toBe("Context");
    expect(titles).toContain("Buzz event: @mention");
  });

  it("keeps the steering framing out of the buzz-event section title", () => {
    // Desktop takes the *first* section whose title starts with "buzz event";
    // a framing header sharing that prefix would shadow the real event block.
    const steer = formatSteeringPrompt({ event, channel: CHANNEL, promptTag: "@mention" });
    const section = userSection(steer);
    expect(section?.title).toBe("Buzz event: @mention");
    expect(DESKTOP_EVENT_ID_RE.exec(steer)?.[1]).toBe(event.id);
  });
});

describe("event block", () => {
  it("records thread structure for a nested reply", () => {
    const root = chatEvent({ channelId: CHANNEL.channelId, content: "root" });
    const reply = replyEvent({
      channelId: CHANNEL.channelId,
      content: "nested",
      rootEventId: root.id,
      parentEventId: root.id,
    });
    const block = formatEventBlock({ event: reply, channel: CHANNEL });
    expect(block).toContain(`root=${root.id}`);
    expect(block).toContain(`parent=${root.id}`);
  });

  it("labels scope as thread when the trigger is threaded", () => {
    const root = chatEvent({ channelId: CHANNEL.channelId, content: "root" });
    const reply = replyEvent({
      channelId: CHANNEL.channelId,
      content: "nested",
      rootEventId: root.id,
    });
    expect(formatPrimaryPrompt({ event: reply, channel: CHANNEL })).toContain("Scope: thread");
  });

  it("labels scope as dm for a direct message channel", () => {
    const event = chatEvent({ channelId: CHANNEL.channelId, content: "hi" });
    const prompt = formatPrimaryPrompt({
      event,
      channel: { ...CHANNEL, channelType: "dm" },
    });
    expect(prompt).toContain("Scope: dm");
  });

  it("tells the model its reply is published automatically", () => {
    const event = chatEvent({ channelId: CHANNEL.channelId, content: "hi" });
    expect(formatPrimaryPrompt({ event, channel: CHANNEL })).toContain("published to this channel automatically");
  });

  it("hints the buzz CLI history command with the concrete channel id", () => {
    const event = chatEvent({ channelId: CHANNEL.channelId, content: "hi" });
    const prompt = formatPrimaryPrompt({ event, channel: CHANNEL });
    expect(prompt).toContain(`buzz messages get --channel ${CHANNEL.channelId}`);
    expect(prompt).toContain(`buzz messages thread --channel ${CHANNEL.channelId}`);
  });

  it("hints the thread command with the concrete root id when threaded", () => {
    const root = chatEvent({ channelId: CHANNEL.channelId, content: "root" });
    const reply = replyEvent({
      channelId: CHANNEL.channelId,
      content: "nested",
      rootEventId: root.id,
    });
    const prompt = formatPrimaryPrompt({ event: reply, channel: CHANNEL });
    expect(prompt).toContain(
      `buzz messages thread --channel ${CHANNEL.channelId} --event ${root.id}`,
    );
  });

  it("includes conversation context when supplied", () => {
    const event = chatEvent({ channelId: CHANNEL.channelId, content: "now what?" });
    const prompt = formatPrimaryPrompt({
      event,
      channel: CHANNEL,
      context: {
        kind: "thread",
        total: 5,
        truncated: true,
        messages: [
          {
            eventId: "a".repeat(64),
            authorPubkey: USER_A_PUBKEY,
            authorLabel: "Ada",
            createdAt: 1_700_000_000,
            content: "earlier message",
          },
        ],
      },
    });
    expect(prompt).toContain("[Thread Context]");
    expect(prompt).toContain("earlier message");
    expect(prompt).toContain("Showing 1 of 5 messages");
  });
});
