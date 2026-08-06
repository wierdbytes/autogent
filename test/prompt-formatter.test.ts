import { describe, expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import {
  displayAuthor,
  formatEventBlock,
  formatPrimaryPrompt,
  formatSteeringPrompt,
  formatSystemPromptContext,
} from "../src/runtime/prompt-formatter.js";
import { USER_A_PUBKEY } from "./helpers/fakes.js";

const CHANNEL = { channelId: "chan-1", name: "general", channelType: "stream" as const };
const ROOT = "a".repeat(64);

describe("event block", () => {
  it("renders exactly From / Time / Content with a resolved username", () => {
    const prompt = formatPrimaryPrompt({
      authorLabel: "WierdBytes",
      authorPubkey: USER_A_PUBKEY,
      createdAt: Math.floor(Date.UTC(2026, 7, 6, 15, 4, 16) / 1000),
      content: "@Линкед Коуч и ещё один",
    });
    expect(prompt).toBe(
      [
        "From: @WierdBytes",
        "Time: 2026-08-06T15:04:16.000Z",
        "Content:",
        "@Линкед Коуч и ещё один",
      ].join("\n"),
    );
  });

  it("falls back to the npub when no profile name is known", () => {
    const block = formatEventBlock({
      authorLabel: null,
      authorPubkey: USER_A_PUBKEY,
      createdAt: 1_700_000_000,
      content: "hi",
    });
    expect(block.startsWith(`From: ${npubEncode(USER_A_PUBKEY)}`)).toBe(true);
  });

  it("keeps multi-line content intact under the Content header", () => {
    const block = formatEventBlock({
      authorLabel: "alice",
      authorPubkey: USER_A_PUBKEY,
      createdAt: 1_700_000_000,
      content: "line one\nline two",
    });
    expect(block.endsWith("Content:\nline one\nline two")).toBe(true);
  });

  it("never leaks legacy metadata fields into the prompt", () => {
    const prompt = formatPrimaryPrompt({
      authorLabel: "alice",
      authorPubkey: USER_A_PUBKEY,
      createdAt: 1_700_000_000,
      content: "hello",
    });
    for (const forbidden of ["Event ID:", "Channel:", "Kind:", "Tags:", "Parsed:", "[Context]", "[Buzz event"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });
});

describe("displayAuthor", () => {
  it("prefixes resolved names with @ and falls back to npub", () => {
    expect(displayAuthor("bob", USER_A_PUBKEY)).toBe("@bob");
    expect(displayAuthor(null, USER_A_PUBKEY)).toBe(npubEncode(USER_A_PUBKEY));
  });

  it("degrades to the raw pubkey when npub encoding fails", () => {
    expect(displayAuthor(null, "not-hex")).toBe("not-hex");
  });
});

describe("steering prompt", () => {
  it("frames the event block as an addition to work in progress", () => {
    const prompt = formatSteeringPrompt({
      authorLabel: "bob",
      authorPubkey: USER_A_PUBKEY,
      createdAt: 1_700_000_000,
      content: "also this",
    });
    expect(prompt.startsWith("[Steering]\n")).toBe(true);
    expect(prompt).toContain("Fold it into the work in progress");
    expect(prompt.endsWith("Content:\nalso this")).toBe(true);
  });
});

describe("system prompt context", () => {
  it("describes a channel-level conversation", () => {
    expect(
      formatSystemPromptContext({ channel: CHANNEL, threadRootId: null, selfName: "Линкед Коуч" }),
    ).toEqual([
      "Scope: channel",
      "Channel: general (#chan-1)",
      "Self username: @Линкед Коуч",
      "Replies: your visible answer is published to this channel automatically as a reply to the triggering message. Do not attempt to send it yourself.",
      "Buzz CLI: `buzz messages get --channel chan-1` reads recent channel history; `buzz messages thread --channel chan-1 --event <root-id>` reads a thread.",
    ]);
  });

  it("describes a thread conversation with its static root", () => {
    const lines = formatSystemPromptContext({
      channel: CHANNEL,
      threadRootId: ROOT,
      selfName: "Линкед Коуч",
    });
    expect(lines[0]).toBe("Scope: thread");
    expect(lines).toContain(`Thread root: ${ROOT}`);
    expect(lines).toContain(
      `Buzz CLI: \`buzz messages thread --channel chan-1 --event ${ROOT}\` reads this thread; \`buzz messages get --channel chan-1\` reads recent channel history.`,
    );
  });

  it("marks DM channels as dm scope", () => {
    const lines = formatSystemPromptContext({
      channel: { channelId: "dm-1", name: null, channelType: "dm" },
      threadRootId: null,
      selfName: "agent",
    });
    expect(lines[0]).toBe("Scope: dm");
    expect(lines[1]).toBe("Channel: dm-1");
  });
});
