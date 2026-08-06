import { describe, expect, it } from "vitest";
import {
  MAX_STRING_BYTES,
  MAX_TOOL_PAYLOAD_BYTES,
  capturePolicy,
  clampText,
  redactSecrets,
  shapeContent,
} from "../src/telemetry/langfuse-capture.js";

describe("capturePolicy", () => {
  it("metadata-only captures no content at all", () => {
    const policy = capturePolicy("metadata-only");
    expect(policy).toEqual({
      preset: "metadata-only",
      conversation: false,
      thinking: false,
      toolPayloads: false,
      systemPrompt: false,
    });
  });

  it("conversations captures prompts and replies but no tool payloads", () => {
    const policy = capturePolicy("conversations");
    expect(policy.conversation).toBe(true);
    expect(policy.thinking).toBe(false);
    expect(policy.toolPayloads).toBe(false);
    expect(policy.systemPrompt).toBe(false);
  });

  it("full captures everything", () => {
    const policy = capturePolicy("full");
    expect(policy).toEqual({
      preset: "full",
      conversation: true,
      thinking: true,
      toolPayloads: true,
      systemPrompt: true,
    });
  });
});

describe("redactSecrets", () => {
  it("masks bearer tokens", () => {
    const out = redactSecrets("curl -H 'Authorization: Bearer abcdef1234567890XYZ' https://x");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abcdef1234567890XYZ");
  });

  it("masks provider-prefixed api keys", () => {
    const out = redactSecrets("export ANTHROPIC=sk-ant-api03-AAAABBBBCCCC and pk-lf-1234567890ab");
    expect(out).not.toContain("sk-ant-api03-AAAABBBBCCCC");
    expect(out).not.toContain("pk-lf-1234567890ab");
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("masks nsec and ncryptsec secrets", () => {
    const nsec = `nsec1${"q".repeat(58)}`;
    const out = redactSecrets(`my key is ${nsec}, do not share`);
    expect(out).toBe("my key is [REDACTED], do not share");
  });

  it("masks PEM private key blocks whole", () => {
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
      "AAAAAAAAAAEAAAAzc21hbGw",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(`before\n${pem}\nafter`);
    expect(out).toBe("before\n[REDACTED]\nafter");
  });

  it("masks keyed secret assignments but keeps the key name", () => {
    expect(redactSecrets("api_key=hunter2secretvalue")).toBe("api_key=[REDACTED]");
    expect(redactSecrets('{"secret_key": "abcdef"}')).toContain('"secret_key": [REDACTED]');
    expect(redactSecrets("password = swordfish;")).toBe("password = [REDACTED];");
  });

  it("leaves innocent text untouched", () => {
    const text = "The tool read src/config.ts and found 3 problems: sk8 park, pk value, bearer of news.";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("clampText", () => {
  it("returns short text untouched", () => {
    expect(clampText("hello", 64)).toBe("hello");
  });

  it("truncates on a byte budget and reports the drop", () => {
    const text = "a".repeat(100);
    const out = clampText(text, 10);
    expect(out).toBe(`${"a".repeat(10)}…[truncated 90 bytes]`);
  });

  it("never cuts a multi-byte codepoint in half", () => {
    // Four 3-byte characters; a 10-byte budget lands inside the fourth.
    const text = "☃☃☃☃";
    const out = clampText(text, 10);
    expect(out.startsWith("☃☃☃")).toBe(true);
    expect(out).not.toContain("\uFFFD");
    expect(out).toContain("[truncated 3 bytes]");
  });
});

describe("shapeContent", () => {
  it("redacts before clamping and defaults to the string budget", () => {
    const nsec = `nsec1${"q".repeat(58)}`;
    expect(shapeContent(`key ${nsec}`)).toBe("key [REDACTED]");
    expect(shapeContent("x".repeat(MAX_STRING_BYTES + 10))).toContain("[truncated 10 bytes]");
  });

  it("accepts the larger tool budget", () => {
    const payload = "y".repeat(MAX_TOOL_PAYLOAD_BYTES + 5);
    expect(shapeContent(payload, MAX_TOOL_PAYLOAD_BYTES)).toContain("[truncated 5 bytes]");
    // The same payload under the default budget is cut much harder.
    expect(shapeContent(payload).length).toBeLessThan(shapeContent(payload, MAX_TOOL_PAYLOAD_BYTES).length);
  });
});
