import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_SECRET_ENV_VARS,
  CHILD_ENV_ALLOWLIST,
  buildChildEnv,
  isSecretEnvName,
  isSecretEnvValue,
  scrubProcessEnv,
  takeSecretEnv,
} from "../src/security/secret-vault.js";

const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

/** A parent environment as hostile as a real deployment's. */
function pollutedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    BUZZ_PRIVATE_KEY: "a".repeat(64),
    BUZZ_RELAY_URL: "wss://relay.example",
    BUZZ_AUTH_TAG: '["auth","x","",""]',
    NOSTR_PRIVATE_KEY: "b".repeat(64),
    NOSTR_SECRET_KEY: NSEC,
    AUTOGENT_AGENT_SECRET: "c".repeat(64),
    AUTOGENT_OWNER_SECRET: "d".repeat(64),
    AUTOGENT_RELAY_URL: "wss://relay.example",
    AUTOGENT_STATE_DIR: "/srv/agent/state",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-openai-secret",
    GITHUB_TOKEN: "ghp_secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    DATABASE_PASSWORD: "hunter2",
    MY_SIGNING_KEY: "sign",
    NODE_OPTIONS: "--require /tmp/evil.js",
    npm_config_registry: "https://registry.npmjs.org",
  };
}

const SECRET_VALUES = [
  "a".repeat(64),
  "b".repeat(64),
  "c".repeat(64),
  "d".repeat(64),
  NSEC,
  "sk-ant-secret",
  "sk-openai-secret",
  "ghp_secret",
  "aws-secret",
  "hunter2",
];

describe("child environment", () => {
  it("carries no secret-looking variable out of a polluted parent", () => {
    const child = buildChildEnv(pollutedEnv());
    const serialised = JSON.stringify(child);
    for (const value of SECRET_VALUES) {
      expect(serialised, value).not.toContain(value);
    }
    for (const name of Object.keys(child)) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  it("keeps only allowlisted names", () => {
    const child = buildChildEnv(pollutedEnv());
    expect(Object.keys(child).sort()).toEqual(["HOME", "LANG", "PATH", "TERM"]);
  });

  it("drops the whole agent configuration surface, not just the secrets", () => {
    const child = buildChildEnv(pollutedEnv());
    expect(child["AUTOGENT_RELAY_URL"]).toBeUndefined();
    expect(child["AUTOGENT_STATE_DIR"]).toBeUndefined();
    expect(child["BUZZ_RELAY_URL"]).toBeUndefined();
  });

  it("refuses NODE_OPTIONS, which is code execution in disguise", () => {
    expect(buildChildEnv(pollutedEnv())["NODE_OPTIONS"]).toBeUndefined();
    expect(buildChildEnv(pollutedEnv(), { allow: ["NODE_OPTIONS"] })["NODE_OPTIONS"]).toBe(
      "--require /tmp/evil.js",
    );
  });

  it("passes through explicitly widened names", () => {
    const child = buildChildEnv(pollutedEnv(), { allow: ["npm_config_registry"] });
    expect(child["npm_config_registry"]).toBe("https://registry.npmjs.org");
  });

  it("filters extras too, so no caller can reopen the hole", () => {
    const child = buildChildEnv(pollutedEnv(), {
      extra: { PWD: "/srv/agent/workspace", ANTHROPIC_API_KEY: "sk-leak", NOTES: NSEC },
    });
    expect(child["PWD"]).toBe("/srv/agent/workspace");
    expect(child["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(child["NOTES"]).toBeUndefined();
  });

  it("drops key material even under an innocent name", () => {
    const child = buildChildEnv({ PATH: "/bin", HOME: NSEC });
    expect(child["HOME"]).toBeUndefined();
    expect(child["PATH"]).toBe("/bin");
  });

  it("produces an empty environment from an empty parent", () => {
    expect(buildChildEnv({})).toEqual({});
  });

  it("allowlists nothing credential-shaped by construction", () => {
    for (const name of CHILD_ENV_ALLOWLIST) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });
});

describe("name and value classification", () => {
  it("recognises credential-shaped names", () => {
    for (const name of [
      "BUZZ_PRIVATE_KEY",
      "NOSTR_PRIVATE_KEY",
      "AUTOGENT_ANYTHING",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "DB_PASSWORD",
      "SOME_MNEMONIC",
      "MY_SIGNING_KEY",
      "AUTH_HEADER",
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it("leaves ordinary names alone", () => {
    for (const name of ["PATH", "HOME", "LANG", "TERM", "NODE_ENV", "CI"]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  it("recognises bech32 key material by value", () => {
    expect(isSecretEnvValue(NSEC)).toBe(true);
    expect(isSecretEnvValue(` ${NSEC} `)).toBe(true);
    expect(isSecretEnvValue("ncryptsec1abcdef")).toBe(true);
    expect(isSecretEnvValue("npub1anything")).toBe(false);
  });
});

describe("process environment scrubbing", () => {
  it("deletes every bootstrap secret and reports what it removed", () => {
    const env: NodeJS.ProcessEnv = {
      ...pollutedEnv(),
      AUTOGENT_SECRET_KEY: "e".repeat(64),
    };
    const removed = scrubProcessEnv(env);

    for (const name of BOOTSTRAP_SECRET_ENV_VARS) {
      expect(env[name], name).toBeUndefined();
    }
    expect(removed).toContain("BUZZ_PRIVATE_KEY");
    expect(removed).toContain("AUTOGENT_OWNER_SECRET");
    expect(removed).not.toContain("AUTOGENT_RELAY_URL");
    // Non-bootstrap configuration must survive: the runtime still reads it.
    expect(env["AUTOGENT_RELAY_URL"]).toBe("wss://relay.example");
  });

  it("accepts extra names and is idempotent", () => {
    const env: NodeJS.ProcessEnv = { CUSTOM_SECRET: "x", PATH: "/bin" };
    expect(scrubProcessEnv(env, ["CUSTOM_SECRET"])).toEqual(["CUSTOM_SECRET"]);
    expect(scrubProcessEnv(env, ["CUSTOM_SECRET"])).toEqual([]);
    expect(env["PATH"]).toBe("/bin");
  });

  it("reads and deletes a bootstrap secret in one step", () => {
    const env: NodeJS.ProcessEnv = { BUZZ_PRIVATE_KEY: "a".repeat(64), EMPTY: "   " };
    expect(takeSecretEnv("BUZZ_PRIVATE_KEY", env)).toBe("a".repeat(64));
    expect(env["BUZZ_PRIVATE_KEY"]).toBeUndefined();
    expect(takeSecretEnv("BUZZ_PRIVATE_KEY", env)).toBeUndefined();
    expect(takeSecretEnv("EMPTY", env)).toBeUndefined();
    expect(env["EMPTY"]).toBeUndefined();
  });
});
