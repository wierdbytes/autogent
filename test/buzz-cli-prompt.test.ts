/**
 * The buzz CLI system prompt (buzz-cli plan §5): the two deltas from buzz-acp
 * are load-bearing, so they are asserted, not just described.
 */

import { describe, expect, it } from "vitest";
import { BUZZ_CLI_PROMPT } from "../src/prompts/buzz-cli.js";

describe("BUZZ_CLI_PROMPT", () => {
  it("teaches self-discovery through --help instead of exhaustive docs", () => {
    expect(BUZZ_CLI_PROMPT).toContain("buzz <group> --help");
  });

  it("states the exit-code contract", () => {
    expect(BUZZ_CLI_PROMPT).toMatch(/0 ok, 1 bad input, 2 network, 3 auth, 4 other, 5 write conflict/);
  });

  it("tells the model auth is harness-managed so it does not hunt for keys", () => {
    expect(BUZZ_CLI_PROMPT).toMatch(/BUZZ_PRIVATE_KEY/);
    expect(BUZZ_CLI_PROMPT).toMatch(/not visible to you/);
    expect(BUZZ_CLI_PROMPT).toMatch(/--private-key/);
  });

  it("preserves the auto-publish reply model to prevent double-posting", () => {
    expect(BUZZ_CLI_PROMPT).toMatch(/published to the triggering channel automatically/);
    expect(BUZZ_CLI_PROMPT).toMatch(/do not send it yourself/i);
  });

  it("teaches the stdin pattern for multiline content", () => {
    expect(BUZZ_CLI_PROMPT).toContain("--content -");
    expect(BUZZ_CLI_PROMPT).toContain("printf");
  });

  it("covers the command groups the model needs daily", () => {
    for (const group of ["messages", "channels", "canvas", "reactions", "dms", "users", "feed", "repos", "issues", "pr", "upload"]) {
      expect(BUZZ_CLI_PROMPT).toContain(`\`buzz ${group}\``);
    }
  });

  it("tells the model to include buzz:// links verbatim", () => {
    expect(BUZZ_CLI_PROMPT).toContain("buzz://");
    expect(BUZZ_CLI_PROMPT).toContain("verbatim");
  });
});
