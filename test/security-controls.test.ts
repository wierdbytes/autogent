import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { KIND } from "../src/nostr/types.js";
import type { NostrTag } from "../src/nostr/types.js";
import type { ControlCommandEvent } from "../src/security/control-commands.js";
import {
  looksLikeControlCommand,
  mentionsAgent,
  parseControlCommand,
} from "../src/security/control-commands.js";

const OWNER = getPublicKey(generateSecretKey());
const AGENT = getPublicKey(generateSecretKey());
const STRANGER = getPublicKey(generateSecretKey());

const CONTEXT = { agentPubkey: AGENT, ownerPubkey: OWNER };

function event(overrides: Partial<ControlCommandEvent> = {}): ControlCommandEvent {
  return {
    kind: KIND.CHAT,
    pubkey: OWNER,
    content: "!cancel",
    tags: [["p", AGENT]] as NostrTag[],
    ...overrides,
  };
}

describe("owner control commands", () => {
  it("accepts each command from the owner when the agent is mentioned", () => {
    for (const [content, expected] of [
      ["!cancel", "cancel"],
      ["!shutdown", "shutdown"],
      ["!rotate", "rotate"],
    ] as const) {
      expect(parseControlCommand(event({ content }), CONTEXT)).toBe(expected);
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseControlCommand(event({ content: "  !rotate \n" }), CONTEXT)).toBe("rotate");
  });

  it("rejects the same text from a non-owner", () => {
    expect(parseControlCommand(event({ pubkey: STRANGER }), CONTEXT)).toBeNull();
    expect(looksLikeControlCommand("!cancel")).toBe(true);
  });

  it("rejects a command that does not mention this agent", () => {
    expect(parseControlCommand(event({ tags: [] }), CONTEXT)).toBeNull();
    expect(parseControlCommand(event({ tags: [["p", STRANGER]] }), CONTEXT)).toBeNull();
  });

  it("rejects control text embedded in a sentence", () => {
    expect(parseControlCommand(event({ content: "please !cancel that" }), CONTEXT)).toBeNull();
    expect(parseControlCommand(event({ content: "!cancelled" }), CONTEXT)).toBeNull();
  });

  // Buzz's composer writes "@Name" into the body whenever it `p`-tags someone,
  // and a mentions-only agent never receives an untagged message — so without
  // this the commands cannot be sent from the UI at all.
  it("accepts a command wrapped in mentions", () => {
    for (const content of [
      "!shutdown @Autogent-1",
      "@Autogent-1 !shutdown",
      "@Autogent-1 !shutdown @someone-else",
    ]) {
      expect(parseControlCommand(event({ content }), CONTEXT)).toBe("shutdown");
    }
  });

  it("treats a mention with spaces as one unit when it knows its own name", () => {
    const named = { ...CONTEXT, agentName: "Pi Agent" };
    expect(parseControlCommand(event({ content: "@Pi Agent !cancel" }), named)).toBe("cancel");
    expect(parseControlCommand(event({ content: "!cancel @pi agent" }), named)).toBe("cancel");
    // Without the name there is nothing to tell the second word from prose.
    expect(parseControlCommand(event({ content: "@Pi Agent !cancel" }), CONTEXT)).toBeNull();
  });

  it("still rejects prose that merely ends or starts with a mention", () => {
    for (const content of [
      "@Autogent-1 please !cancel that",
      "remind me to !cancel @Autogent-1",
      "@Autogent-1 !cancelled",
    ]) {
      expect(parseControlCommand(event({ content }), CONTEXT)).toBeNull();
    }
  });

  it("rejects a non-chat kind carrying the same text", () => {
    expect(parseControlCommand(event({ kind: KIND.OBSERVER }), CONTEXT)).toBeNull();
    expect(parseControlCommand(event({ kind: 1 }), CONTEXT)).toBeNull();
  });

  it("rejects every command before provisioning, when no owner is known", () => {
    expect(parseControlCommand(event(), { agentPubkey: AGENT, ownerPubkey: null })).toBeNull();
  });

  it("returns null for ordinary prose so it stays on the prompt path", () => {
    expect(parseControlCommand(event({ content: "what is the status?" }), CONTEXT)).toBeNull();
    expect(looksLikeControlCommand("what is the status?")).toBe(false);
  });
});

describe("mention detection", () => {
  it("matches only an exact p tag for this agent", () => {
    expect(mentionsAgent([["p", AGENT]], AGENT)).toBe(true);
    expect(mentionsAgent([["p", AGENT, "wss://relay"]], AGENT)).toBe(true);
    expect(mentionsAgent([["p", STRANGER], ["p", AGENT]], AGENT)).toBe(true);
    expect(mentionsAgent([["e", AGENT]], AGENT)).toBe(false);
    expect(mentionsAgent([["p"]], AGENT)).toBe(false);
    expect(mentionsAgent([], AGENT)).toBe(false);
  });
});
