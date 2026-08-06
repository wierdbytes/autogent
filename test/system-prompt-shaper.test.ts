/**
 * System prompt shaping (src/prompts/system-prompt-shaper.ts): the SDK's
 * Guidelines and Pi-documentation sections must disappear, and the
 * conversation context lines must land directly below the
 * `Current working directory` line.
 */

import { describe, expect, it } from "vitest";
import {
  shapeSystemPrompt,
  systemPromptShaperExtension,
} from "../src/prompts/system-prompt-shaper.js";

/** A faithful skeleton of the SDK's default system prompt. */
const SDK_PROMPT = [
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
  "Available tools:\n- read: Read file contents\n- bash: Execute bash commands",
  "In addition to the tools above, you may have access to other custom tools depending on the project.",
  "Guidelines:\n- Be concise in your responses\n- Show file paths clearly when working with files",
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: /docs/README.md\n- Additional docs: /docs",
  "## Buzz CLI\nowner prelude",
  "owner instructions",
  "<skills_available>\nnone\n</skills_available>\nCurrent working directory: /work/dir",
].join("\n\n");

const CONTEXT = [
  "Scope: channel",
  "Channel: general (#chan-1)",
  "Self username: @Линкед Коуч",
];

describe("shapeSystemPrompt", () => {
  const shaped = shapeSystemPrompt(SDK_PROMPT, CONTEXT);

  it("drops the Guidelines and Pi documentation sections", () => {
    expect(shaped).not.toContain("Guidelines:");
    expect(shaped).not.toContain("Pi documentation");
    // Neighbouring sections survive untouched.
    expect(shaped).toContain("Available tools:");
    expect(shaped).toContain("## Buzz CLI");
    expect(shaped).toContain("owner instructions");
  });

  it("inserts the context lines directly below the cwd line", () => {
    expect(shaped).toContain(
      [
        "Current working directory: /work/dir",
        "Scope: channel",
        "Channel: general (#chan-1)",
        "Self username: @Линкед Коуч",
      ].join("\n"),
    );
  });

  it("appends the context at the end when there is no cwd line", () => {
    const shapedCustom = shapeSystemPrompt("fully custom prompt", CONTEXT);
    expect(shapedCustom).toBe(`fully custom prompt\n\n${CONTEXT.join("\n")}`);
  });

  it("leaves the prompt untouched when there is nothing to do", () => {
    expect(shapeSystemPrompt("plain prompt", [])).toBe("plain prompt");
  });
});

describe("systemPromptShaperExtension", () => {
  it("registers a before_agent_start hook that returns the shaped prompt", () => {
    let handler: ((event: { systemPrompt: string }) => unknown) | null = null;
    systemPromptShaperExtension(CONTEXT)({
      on: (event, callback) => {
        expect(event).toBe("before_agent_start");
        handler = callback;
      },
    });

    const result = handler!({ systemPrompt: SDK_PROMPT }) as { systemPrompt: string };
    expect(result.systemPrompt).toBe(shapeSystemPrompt(SDK_PROMPT, CONTEXT));
  });
});
