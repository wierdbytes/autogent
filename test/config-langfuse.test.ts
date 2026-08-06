import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyEnv,
  defaultConfig,
  normalizeLangfusePrivacy,
  validateConfig,
} from "../src/config.js";

const LANGFUSE_ENV_KEYS = [
  "AUTOGENT_LANGFUSE",
  "AUTOGENT_LANGFUSE_HOST",
  "AUTOGENT_LANGFUSE_PRIVACY",
] as const;

describe("langfuse config", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // applyEnv reads process.env directly, so the overlay is exercised through it.
    saved = Object.fromEntries(LANGFUSE_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of LANGFUSE_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of LANGFUSE_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("defaults to off, cloud host, conversations", () => {
    expect(defaultConfig().telemetry.langfuse).toEqual({
      enabled: false,
      host: "https://cloud.langfuse.com",
      privacy: "conversations",
    });
  });

  it("applies the full env overlay", () => {
    process.env["AUTOGENT_LANGFUSE"] = "true";
    process.env["AUTOGENT_LANGFUSE_HOST"] = "https://langfuse.example.com";
    process.env["AUTOGENT_LANGFUSE_PRIVACY"] = "metadata-only";

    expect(applyEnv(defaultConfig()).telemetry.langfuse).toEqual({
      enabled: true,
      host: "https://langfuse.example.com",
      privacy: "metadata-only",
    });
  });

  it("leaves the base intact when the env is silent", () => {
    const base = defaultConfig();
    base.telemetry.langfuse = {
      enabled: true,
      host: "https://from-record.example.com",
      privacy: "full-debug",
    };
    expect(applyEnv(base).telemetry.langfuse).toEqual(base.telemetry.langfuse);
  });

  it("degrades a typo'd privacy preset to the base value instead of throwing", () => {
    process.env["AUTOGENT_LANGFUSE_PRIVACY"] = "everything";
    expect(applyEnv(defaultConfig()).telemetry.langfuse.privacy).toBe("conversations");

    const base = defaultConfig();
    base.telemetry.langfuse.privacy = "full-debug";
    expect(applyEnv(base).telemetry.langfuse.privacy).toBe("full-debug");
  });

  it("maps the legacy 'full' preset to full-debug", () => {
    process.env["AUTOGENT_LANGFUSE_PRIVACY"] = "full";
    expect(applyEnv(defaultConfig()).telemetry.langfuse.privacy).toBe("full-debug");
  });

  it("treats a non-truthy AUTOGENT_LANGFUSE as off", () => {
    const base = defaultConfig();
    base.telemetry.langfuse.enabled = true;
    process.env["AUTOGENT_LANGFUSE"] = "no";
    expect(applyEnv(base).telemetry.langfuse.enabled).toBe(false);
  });
});

describe("normalizeLangfusePrivacy", () => {
  it("accepts the pi-langfuse presets", () => {
    for (const preset of ["metadata-only", "prompts-only", "conversations", "full-debug"]) {
      expect(normalizeLangfusePrivacy(preset)).toBe(preset);
    }
  });

  it("maps legacy 'full' and rejects everything else", () => {
    expect(normalizeLangfusePrivacy("full")).toBe("full-debug");
    expect(normalizeLangfusePrivacy("everything")).toBeNull();
    expect(normalizeLangfusePrivacy(42)).toBeNull();
    expect(normalizeLangfusePrivacy(undefined)).toBeNull();
  });
});

describe("validateConfig for langfuse", () => {
  it("accepts the defaults and an enabled, well-formed integration", () => {
    expect(validateConfig(defaultConfig())).toEqual([]);

    const enabled = defaultConfig();
    enabled.telemetry.langfuse.enabled = true;
    enabled.telemetry.langfuse.host = "http://localhost:3030";
    expect(validateConfig(enabled)).toEqual([]);
  });

  it("rejects a host without a scheme when enabled", () => {
    const config = defaultConfig();
    config.telemetry.langfuse.enabled = true;
    config.telemetry.langfuse.host = "cloud.langfuse.com";
    expect(validateConfig(config).join()).toMatch(/langfuse\.host/);
  });

  it("ignores garbage behind a disabled integration", () => {
    const config = defaultConfig();
    config.telemetry.langfuse.enabled = false;
    config.telemetry.langfuse.host = "not-a-url";
    expect(validateConfig(config)).toEqual([]);
  });
});
