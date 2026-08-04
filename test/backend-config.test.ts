/**
 * `provider_config`: the schema, and the desktop's validation of what comes back.
 *
 * The most valuable assertion here is the anti-secret lint. Buzz Desktop
 * rejects any config key whose word-split contains `secret`, `password`,
 * `token`, `key` or `credential` — a deliberately blunt rule with accepted
 * false positives (`ssh_key_path` holds a path and is refused anyway). A
 * provider that names a field badly is not "mostly fine": every deploy fails at
 * validation. So the rule is reproduced here and run against our own schema.
 */

import { describe, expect, it } from "vitest";
import {
  configSchema,
  DEFAULT_COMMAND,
  DEFAULT_STARTUP_TIMEOUT_SECONDS,
  parseProviderConfig,
} from "../src/backend/config.js";

/** The desktop's `split_config_key`, reproduced. */
function splitConfigKey(key: string): string[] {
  const parts = key.split(/[_\-.]/).filter((part) => part !== "");
  const words: string[] = [];
  for (const part of parts) {
    // camelCase and ACRONYMBoundary splits, as the desktop performs them.
    for (const word of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      if (word !== "") words.push(word.toLowerCase());
    }
  }
  return words;
}

const BANNED = new Set(["secret", "password", "token", "key", "credential"]);

describe("provider config schema", () => {
  it("uses no field name the desktop's anti-secret lint would reject (I2)", () => {
    const properties = (configSchema()["properties"] ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(properties)) {
      const words = splitConfigKey(key);
      const offending = words.filter((word) => BANNED.has(word));
      expect(offending, `config key ${key} would be rejected as secret-shaped`).toEqual([]);
    }
  });

  it("stays well inside the desktop's twenty-field and 64KB caps", () => {
    const properties = (configSchema()["properties"] ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties).length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(configSchema()).length).toBeLessThan(65_536);
  });

  it("requires nothing, so the provider works with an untouched form", () => {
    expect(configSchema()["required"]).toEqual([]);
    const config = parseProviderConfig({});
    expect(config.command).toBe(DEFAULT_COMMAND);
    expect(config.startupTimeoutSeconds).toBe(DEFAULT_STARTUP_TIMEOUT_SECONDS);
  });

  it("treats a cleared field as unset rather than as an empty value", () => {
    // A cleared numeric input can reach a provider as `""` rather than being
    // omitted; degrading to the default is the only reading that is not a bug.
    const config = parseProviderConfig({ startup_timeout_seconds: "", command: "  " });
    expect(config.startupTimeoutSeconds).toBe(DEFAULT_STARTUP_TIMEOUT_SECONDS);
    expect(config.command).toBe(DEFAULT_COMMAND);
  });

  it("accepts a numeric field the UI submitted as a string", () => {
    expect(parseProviderConfig({ startup_timeout_seconds: "45" }).startupTimeoutSeconds).toBe(45);
  });

  it("reports a non-numeric timeout instead of silently defaulting", () => {
    expect(() => parseProviderConfig({ startup_timeout_seconds: "soon" })).toThrow(/must be a number/);
  });

  it("expands a leading tilde in paths", () => {
    const config = parseProviderConfig({ state_root: "~/agents" });
    expect(config.stateRoot.startsWith("~")).toBe(false);
    expect(config.stateRoot.endsWith("/agents")).toBe(true);
  });

  it("rejects an unknown log level", () => {
    expect(() => parseProviderConfig({ log_level: "chatty" })).toThrow(/log_level/);
  });

  it("advertises only string defaults, which are the only ones the UI prefills", () => {
    const properties = configSchema()["properties"] as Record<string, Record<string, unknown>>;
    for (const [key, schema] of Object.entries(properties)) {
      if (!("default" in schema)) continue;
      expect(typeof schema["default"], `${key} default must be a string to prefill`).toBe("string");
    }
  });
});
