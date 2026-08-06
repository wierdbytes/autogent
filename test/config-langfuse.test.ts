import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEnv, defaultConfig, validateConfig } from "../src/config.js";

const LANGFUSE_ENV_KEYS = [
  "AUTOGENT_LANGFUSE",
  "AUTOGENT_LANGFUSE_HOST",
  "AUTOGENT_LANGFUSE_PRIVACY",
  "AUTOGENT_LANGFUSE_SAMPLE",
  "AUTOGENT_LANGFUSE_ENV",
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

  it("defaults to off, cloud host, conversations, full sampling", () => {
    expect(defaultConfig().telemetry.langfuse).toEqual({
      enabled: false,
      host: "https://cloud.langfuse.com",
      privacy: "conversations",
      sampleRate: 1,
    });
    // No environment by default: the publisher derives it from remote.recordConfig.
    expect(defaultConfig().telemetry.langfuse.environment).toBeUndefined();
  });

  it("applies the full env overlay", () => {
    process.env["AUTOGENT_LANGFUSE"] = "true";
    process.env["AUTOGENT_LANGFUSE_HOST"] = "https://langfuse.example.com";
    process.env["AUTOGENT_LANGFUSE_PRIVACY"] = "metadata-only";
    process.env["AUTOGENT_LANGFUSE_SAMPLE"] = "0.25";
    process.env["AUTOGENT_LANGFUSE_ENV"] = "staging";

    expect(applyEnv(defaultConfig()).telemetry.langfuse).toEqual({
      enabled: true,
      host: "https://langfuse.example.com",
      privacy: "metadata-only",
      sampleRate: 0.25,
      environment: "staging",
    });
  });

  it("leaves the base intact when the env is silent", () => {
    const base = defaultConfig();
    base.telemetry.langfuse = {
      enabled: true,
      host: "https://from-record.example.com",
      privacy: "full",
      sampleRate: 0.5,
      environment: "prod",
    };
    expect(applyEnv(base).telemetry.langfuse).toEqual(base.telemetry.langfuse);
  });

  it("degrades a typo'd privacy preset to the base value instead of throwing", () => {
    process.env["AUTOGENT_LANGFUSE_PRIVACY"] = "everything";
    expect(applyEnv(defaultConfig()).telemetry.langfuse.privacy).toBe("conversations");

    const base = defaultConfig();
    base.telemetry.langfuse.privacy = "full";
    expect(applyEnv(base).telemetry.langfuse.privacy).toBe("full");
  });

  it("ignores a non-numeric sample rate", () => {
    process.env["AUTOGENT_LANGFUSE_SAMPLE"] = "most-of-them";
    expect(applyEnv(defaultConfig()).telemetry.langfuse.sampleRate).toBe(1);
  });

  it("accepts a sample rate of 0 from the env", () => {
    process.env["AUTOGENT_LANGFUSE_SAMPLE"] = "0";
    expect(applyEnv(defaultConfig()).telemetry.langfuse.sampleRate).toBe(0);
  });

  it("treats a non-truthy AUTOGENT_LANGFUSE as off", () => {
    const base = defaultConfig();
    base.telemetry.langfuse.enabled = true;
    process.env["AUTOGENT_LANGFUSE"] = "no";
    expect(applyEnv(base).telemetry.langfuse.enabled).toBe(false);
  });
});

describe("validateConfig for langfuse", () => {
  it("accepts the defaults and an enabled, well-formed exporter", () => {
    expect(validateConfig(defaultConfig())).toEqual([]);

    const enabled = defaultConfig();
    enabled.telemetry.langfuse.enabled = true;
    enabled.telemetry.langfuse.host = "http://localhost:3030";
    enabled.telemetry.langfuse.sampleRate = 0;
    expect(validateConfig(enabled)).toEqual([]);
  });

  it("rejects an out-of-range sample rate when enabled", () => {
    const config = defaultConfig();
    config.telemetry.langfuse.enabled = true;
    config.telemetry.langfuse.sampleRate = 1.5;
    expect(validateConfig(config).join()).toMatch(/langfuse\.sampleRate/);

    config.telemetry.langfuse.sampleRate = -1;
    expect(validateConfig(config).join()).toMatch(/langfuse\.sampleRate/);

    config.telemetry.langfuse.sampleRate = Number.NaN;
    expect(validateConfig(config).join()).toMatch(/langfuse\.sampleRate/);
  });

  it("rejects a host without a scheme when enabled", () => {
    const config = defaultConfig();
    config.telemetry.langfuse.enabled = true;
    config.telemetry.langfuse.host = "cloud.langfuse.com";
    expect(validateConfig(config).join()).toMatch(/langfuse\.host/);
  });

  it("ignores garbage behind a disabled exporter", () => {
    const config = defaultConfig();
    config.telemetry.langfuse.enabled = false;
    config.telemetry.langfuse.sampleRate = 42;
    config.telemetry.langfuse.host = "not-a-url";
    expect(validateConfig(config)).toEqual([]);
  });
});
