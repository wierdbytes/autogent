import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { applyCoreConfig, parseCoreConfig } from "../src/runtime/remote-config.js";

describe("parseCoreConfig", () => {
  it("parses a full v1 document", () => {
    const { config, problems } = parseCoreConfig({
        v: 1,
        model: "anthropic/claude-sonnet-4-5",
        thinking: "high",
        system_prompt: "be terse",
        respond_to: "allowlist",
        respond_to_allowlist: ["a".repeat(64)],
        tools: { include: ["read", "bash"], exclude: ["write"] },
        extensions: ["npm:@wierdbytes/pi-anthropic", "npm:@acme/pi-extra"],
        scheduler: { max_concurrent_turns: 2, context_message_limit: 6 },
        buzz_cli: { enabled: false, deny_commands: ["agents"] },
        inactivity_exit_sec: 7200,
      });
    expect(problems).toEqual([]);
    expect(config).toMatchObject({
      v: 1,
      model: "anthropic/claude-sonnet-4-5",
      thinking: "high",
      respond_to: "allowlist",
      extensions: ["npm:@wierdbytes/pi-anthropic", "npm:@acme/pi-extra"],
      buzz_cli: { enabled: false, deny_commands: ["agents"] },
      inactivity_exit_sec: 7200,
    });
  });

  it("rejects malformed buzz_cli fields", () => {
    expect(parseCoreConfig({ v: 1, buzz_cli: { enabled: "yes" } }).config).toBeNull();
    expect(parseCoreConfig({ v: 1, buzz_cli: { deny_commands: [1] } }).config).toBeNull();
    expect(parseCoreConfig({ v: 1, buzz_cli: "on" }).config).toBeNull();
  });

  it("rejects a non-string-list extensions field", () => {
    const { config, problems } = parseCoreConfig({ v: 1, extensions: ["ok", 42] });
    expect(config).toBeNull();
    expect(problems.join()).toMatch(/extensions/);
  });

  it("accepts a minimal document and ignores unknown keys", () => {
    const { config, problems } = parseCoreConfig({ v: 1, future_field: true });
    expect(problems).toEqual([]);
    expect(config).toEqual({ v: 1 });
  });

  it("rejects an unknown version outright", () => {
    const { config, problems } = parseCoreConfig({ v: 2, model: "x" });
    expect(config).toBeNull();
    expect(problems[0]).toMatch(/version/);
  });

  it("rejects the whole document when any field is malformed", () => {
    const { config, problems } = parseCoreConfig({ v: 1, model: "ok", respond_to: "everyone" });
    expect(config).toBeNull();
    expect(problems.join()).toMatch(/respond_to/);
  });

  it("rejects non-hex allowlist entries", () => {
    const { config } = parseCoreConfig({ v: 1, respond_to_allowlist: ["not-a-key"] });
    expect(config).toBeNull();
  });

  it("treats inactivity_exit_sec 0 as legal (indefinite)", () => {
    const { config } = parseCoreConfig({ v: 1, inactivity_exit_sec: 0 });
    expect(config?.inactivity_exit_sec).toBe(0);
  });

  it("parses a full langfuse block", () => {
    const { config, problems } = parseCoreConfig({
      v: 1,
      langfuse: {
        enabled: true,
        host: "https://langfuse.example.com",
        privacy: "metadata-only",
        sample_rate: 0.25,
        environment: "staging",
      },
    });
    expect(problems).toEqual([]);
    expect(config?.langfuse).toEqual({
      enabled: true,
      host: "https://langfuse.example.com",
      privacy: "metadata-only",
      sample_rate: 0.25,
      environment: "staging",
    });
  });

  it("accepts the boundary sample rates", () => {
    expect(parseCoreConfig({ v: 1, langfuse: { sample_rate: 0 } }).config?.langfuse).toEqual({
      sample_rate: 0,
    });
    expect(parseCoreConfig({ v: 1, langfuse: { sample_rate: 1 } }).config?.langfuse).toEqual({
      sample_rate: 1,
    });
  });

  it("rejects malformed langfuse fields", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ v: 1, langfuse: "on" }, /langfuse must be an object/],
      [{ v: 1, langfuse: [] }, /langfuse must be an object/],
      [{ v: 1, langfuse: { enabled: "yes" } }, /langfuse\.enabled/],
      [{ v: 1, langfuse: { privacy: "everything" } }, /langfuse\.privacy/],
      [{ v: 1, langfuse: { sample_rate: 1.5 } }, /langfuse\.sample_rate/],
      [{ v: 1, langfuse: { sample_rate: -0.1 } }, /langfuse\.sample_rate/],
      [{ v: 1, langfuse: { sample_rate: "0.5" } }, /langfuse\.sample_rate/],
      [{ v: 1, langfuse: { sample_rate: Number.NaN } }, /langfuse\.sample_rate/],
      [{ v: 1, langfuse: { host: 42 } }, /host/],
      [{ v: 1, langfuse: { environment: ["prod"] } }, /environment/],
    ];
    for (const [document, expected] of cases) {
      const { config, problems } = parseCoreConfig(document);
      // A structural problem anywhere rejects the whole document.
      expect(config, JSON.stringify(document)).toBeNull();
      expect(problems.join(), JSON.stringify(document)).toMatch(expected);
    }
  });

  it("rejects the whole document when only the langfuse block is malformed", () => {
    const { config } = parseCoreConfig({
      v: 1,
      model: "anthropic/claude-sonnet-4-5",
      langfuse: { privacy: "verbose" },
    });
    expect(config).toBeNull();
  });

  it("rejects non-object documents", () => {
    expect(parseCoreConfig("{").config).toBeNull();
    expect(parseCoreConfig(null).config).toBeNull();
    expect(parseCoreConfig([1, 2]).config).toBeNull();
  });
});

describe("applyCoreConfig", () => {
  it("lets the record override env and keeps base values where silent", () => {
    const base = defaultConfig();
    base.pi.model = "anthropic/from-env";
    base.security.respondTo = "anyone";
    base.scheduler.maxConcurrentTurns = 4;

    const next = applyCoreConfig(base, {
      v: 1,
      model: "anthropic/from-record",
      scheduler: { max_concurrent_turns: 2 },
      inactivity_exit_sec: 600,
    });

    expect(next.pi.model).toBe("anthropic/from-record");
    expect(next.scheduler.maxConcurrentTurns).toBe(2);
    expect(next.lifecycle.inactivityExitSec).toBe(600);
    // silent fields keep the base
    expect(next.security.respondTo).toBe("anyone");
    expect(next.scheduler.contextMessageLimit).toBe(base.scheduler.contextMessageLimit);
    // and the base object is untouched
    expect(base.pi.model).toBe("anthropic/from-env");
  });

  it("replaces the extension list and keeps the base default when silent", () => {
    const base = defaultConfig();
    const replaced = applyCoreConfig(base, { v: 1, extensions: ["npm:@acme/pi-extra"] });
    expect(replaced.pi.extensions).toEqual(["npm:@acme/pi-extra"]);

    const silent = applyCoreConfig(base, { v: 1 });
    expect(silent.pi.extensions).toEqual(base.pi.extensions);
  });

  it("applies buzz_cli and keeps the base where silent", () => {
    const base = defaultConfig();
    expect(base.buzzCli.enabled).toBe(true);

    const flipped = applyCoreConfig(base, {
      v: 1,
      buzz_cli: { enabled: false, deny_commands: ["agents", "messages delete"] },
    });
    expect(flipped.buzzCli.enabled).toBe(false);
    expect(flipped.buzzCli.denyCommands).toEqual(["agents", "messages delete"]);

    const silent = applyCoreConfig(base, { v: 1, buzz_cli: {} });
    expect(silent.buzzCli.enabled).toBe(true);
    expect(silent.buzzCli.denyCommands).toEqual([]);
  });

  it("overlays langfuse field by field and keeps the base where silent", () => {
    const base = defaultConfig();
    base.telemetry.langfuse.enabled = false;
    base.telemetry.langfuse.host = "https://from-env.example.com";
    base.telemetry.langfuse.privacy = "full";
    base.telemetry.langfuse.sampleRate = 0.5;

    const next = applyCoreConfig(base, {
      v: 1,
      langfuse: { enabled: true, privacy: "metadata-only", environment: "prod" },
    });

    // record > env for the fields it names...
    expect(next.telemetry.langfuse.enabled).toBe(true);
    expect(next.telemetry.langfuse.privacy).toBe("metadata-only");
    expect(next.telemetry.langfuse.environment).toBe("prod");
    // ...and the base survives where it is silent.
    expect(next.telemetry.langfuse.host).toBe("https://from-env.example.com");
    expect(next.telemetry.langfuse.sampleRate).toBe(0.5);
    // the base object is untouched
    expect(base.telemetry.langfuse.enabled).toBe(false);
  });

  it("keeps the whole langfuse base when the record omits the block", () => {
    const base = defaultConfig();
    base.telemetry.langfuse.enabled = true;
    base.telemetry.langfuse.sampleRate = 0.1;

    expect(applyCoreConfig(base, { v: 1 }).telemetry.langfuse).toEqual(base.telemetry.langfuse);
    expect(applyCoreConfig(base, { v: 1, langfuse: {} }).telemetry.langfuse).toEqual(
      base.telemetry.langfuse,
    );
  });

  it("applies a langfuse sample rate of 0 (record disables sampling)", () => {
    const base = defaultConfig();
    expect(applyCoreConfig(base, { v: 1, langfuse: { sample_rate: 0 } }).telemetry.langfuse.sampleRate)
      .toBe(0);
  });

  it("overrides the respond-to surface atomically", () => {
    const base = defaultConfig();
    const next = applyCoreConfig(base, {
      v: 1,
      respond_to: "allowlist",
      respond_to_allowlist: ["b".repeat(64)],
    });
    expect(next.security.respondTo).toBe("allowlist");
    expect(next.security.allowlist).toEqual(["b".repeat(64)]);
  });
});
