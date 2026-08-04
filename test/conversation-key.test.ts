import { describe, expect, it } from "vitest";
import {
  canonicalThreadRoot,
  conversationKey,
  parseThreadTags,
} from "../src/runtime/conversation-key.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("NIP-10 tag parsing", () => {
  it("prefers explicit markers", () => {
    expect(
      parseThreadTags([
        ["e", A, "", "root"],
        ["e", B, "", "reply"],
      ]),
    ).toEqual({ rootEventId: A, replyEventId: B });
  });

  it("falls back to the deprecated positional form", () => {
    expect(parseThreadTags([["e", A], ["e", B], ["e", C]])).toEqual({
      rootEventId: A,
      replyEventId: C,
    });
  });

  it("treats a lone unmarked tag as the root only", () => {
    expect(parseThreadTags([["e", A]])).toEqual({ rootEventId: A, replyEventId: null });
  });

  it("ignores mention markers", () => {
    expect(parseThreadTags([["e", A, "", "mention"]])).toEqual({
      rootEventId: null,
      replyEventId: null,
    });
  });

  it("discards tags that are not valid event ids", () => {
    // A malformed thread tag must never become routing data: trusting it would
    // let a crafted message redirect the agent's replies into another thread.
    expect(parseThreadTags([["e", "not-an-id", "", "root"]])).toEqual({
      rootEventId: null,
      replyEventId: null,
    });
    expect(parseThreadTags([["e", A.toUpperCase(), "", "root"]])).toEqual({
      rootEventId: null,
      replyEventId: null,
    });
  });
});

describe("canonical thread root", () => {
  it("uses the NIP-10 root when present", () => {
    expect(canonicalThreadRoot({ id: B, tags: [["e", A, "", "root"]] })).toBe(A);
  });

  it("makes a top-level event its own root", () => {
    expect(canonicalThreadRoot({ id: B, tags: [] })).toBe(B);
  });

  it("starts a fresh thread when the tags are malformed", () => {
    expect(canonicalThreadRoot({ id: B, tags: [["e", "garbage", "", "root"]] })).toBe(B);
  });
});

describe("conversation key", () => {
  it("separates relay, channel and thread", () => {
    expect(conversationKey("relay", "chan", A)).not.toBe(conversationKey("relay", "chan2", A));
    expect(conversationKey("relay", "chan", A)).not.toBe(conversationKey("relay2", "chan", A));
    expect(conversationKey("relay", "chan", A)).toBe(conversationKey("relay", "chan", A));
  });

  it("cannot be spoofed by ids that concatenate to the same string", () => {
    expect(conversationKey("a", "bc", A)).not.toBe(conversationKey("ab", "c", A));
  });
});
