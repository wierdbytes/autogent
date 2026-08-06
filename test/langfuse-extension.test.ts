import { describe, expect, it } from "vitest";
import {
  LANGFUSE_EXTENSION_SOURCE,
  clearLangfuseEnv,
  setLangfuseEnv,
  withLangfuseExtension,
} from "../src/runtime/langfuse-extension.js";

describe("withLangfuseExtension", () => {
  it("appends the extension when tracing is on", () => {
    expect(withLangfuseExtension([], true)).toEqual([LANGFUSE_EXTENSION_SOURCE]);
    expect(withLangfuseExtension(undefined, true)).toEqual([LANGFUSE_EXTENSION_SOURCE]);
    expect(withLangfuseExtension(["npm:other"], true)).toEqual([
      "npm:other",
      LANGFUSE_EXTENSION_SOURCE,
    ]);
  });

  it("does not duplicate an owner-listed extension", () => {
    expect(withLangfuseExtension([LANGFUSE_EXTENSION_SOURCE], true)).toEqual([
      LANGFUSE_EXTENSION_SOURCE,
    ]);
  });

  it("leaves the owner's list alone when tracing is off", () => {
    expect(withLangfuseExtension(["npm:other"], false)).toEqual(["npm:other"]);
    expect(withLangfuseExtension(undefined, false)).toEqual([]);
    // The owner's explicit word wins: a manually listed extension survives.
    expect(withLangfuseExtension([LANGFUSE_EXTENSION_SOURCE], false)).toEqual([
      LANGFUSE_EXTENSION_SOURCE,
    ]);
  });
});

describe("langfuse env surface", () => {
  it("round-trips set and clear", () => {
    const env: NodeJS.ProcessEnv = { OTHER: "keep" };
    setLangfuseEnv(
      { host: "https://langfuse.example.com", privacy: "metadata-only" },
      { publicKey: "pk-lf-x", secretKey: "sk-lf-x" },
      env,
    );
    expect(env).toEqual({
      OTHER: "keep",
      LANGFUSE_PUBLIC_KEY: "pk-lf-x",
      LANGFUSE_SECRET_KEY: "sk-lf-x",
      LANGFUSE_BASE_URL: "https://langfuse.example.com",
      LANGFUSE_PRIVACY_PRESET: "metadata-only",
    });

    clearLangfuseEnv(env);
    expect(env).toEqual({ OTHER: "keep" });
  });
});
