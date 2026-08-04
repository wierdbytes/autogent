/**
 * Environment layering.
 *
 * The precedence rule is not a detail: it is the difference between a remote
 * agent that behaves like its local twin and one that quietly ignores the
 * overrides its owner set. User env beats Buzz's behaviour defaults — locally
 * and here — while the values that define *which* agent this is beat everything.
 */

import { describe, expect, it } from "vitest";
import { buildAgentEnv } from "../src/backend/env.js";
import { parseDeployPayload } from "../src/backend/payload.js";
import { mintAgent } from "./helpers/backend-request.js";

function envFor(
  overrides: Record<string, unknown> = {},
  ambient: NodeJS.ProcessEnv = { PATH: "/usr/bin" },
): Record<string, string> {
  const payload = parseDeployPayload(mintAgent(overrides).agent);
  return buildAgentEnv({
    payload,
    stateDir: "/state",
    workspace: "/work",
    generation: "gen-1",
    logLevel: null,
    path: "/resolved/bin",
    ambient,
  });
}

describe("agent environment", () => {
  it("puts the user layer above the policy layer", () => {
    const env = envFor({
      launch: {
        command: "autogent-nostr",
        args: [],
        policy_env: { BUZZ_ACP_MODEL: "policy-model" },
        env: { AUTOGENT_MODEL: "user-model" },
        owner_pubkey: null,
      },
    });
    expect(env["AUTOGENT_MODEL"]).toBe("user-model");
  });

  it("translates the harness's knobs into the agent's, keeping them overridable", () => {
    const env = envFor({
      launch: {
        command: "autogent-nostr",
        args: [],
        policy_env: {
          BUZZ_ACP_MODEL: "anthropic/claude-sonnet-4-5",
          BUZZ_ACP_IDLE_TIMEOUT: "600",
          BUZZ_ACP_MAX_TURN_DURATION: "3600",
          BUZZ_ACP_AGENTS: "8",
        },
        env: {},
        owner_pubkey: null,
      },
    });
    expect(env["AUTOGENT_MODEL"]).toBe("anthropic/claude-sonnet-4-5");
    expect(env["AUTOGENT_IDLE_TIMEOUT"]).toBe("600");
    expect(env["AUTOGENT_MAX_TURN_DURATION"]).toBe("3600");
    expect(env["AUTOGENT_MAX_CONCURRENT_TURNS"]).toBe("8");
  });

  it("folds team instructions into the system prompt rather than dropping them", () => {
    const env = envFor({
      system_prompt: "You are terse.",
      launch: {
        command: "autogent-nostr",
        args: [],
        policy_env: { BUZZ_ACP_TEAM_INSTRUCTIONS: "Ship on Fridays." },
        env: {},
        owner_pubkey: null,
      },
    });
    expect(env["AUTOGENT_SYSTEM_PROMPT"]).toBe("You are terse.\n\nShip on Fridays.");
  });

  it("lets no user variable redirect the relay, the state dir or the gate", () => {
    const env = envFor({
      respond_to: "anyone",
      launch: {
        command: "autogent-nostr",
        args: [],
        policy_env: {},
        env: {
          AUTOGENT_RELAY_URL: "wss://attacker.example",
          AUTOGENT_STATE_DIR: "/tmp/elsewhere",
          AUTOGENT_RESPOND_TO: "anyone",
          AUTOGENT_CWD: "/",
        },
        owner_pubkey: null,
      },
    });
    expect(env["AUTOGENT_RELAY_URL"]).toBe("ws://localhost:3000");
    expect(env["AUTOGENT_STATE_DIR"]).toBe("/state");
    expect(env["AUTOGENT_CWD"]).toBe("/work");
    expect(env["AUTOGENT_RESPOND_TO"]).toBe("anyone"); // from the record, not the env
  });

  it("never carries identity in the environment", () => {
    const env = envFor({
      launch: {
        command: "autogent-nostr",
        args: [],
        policy_env: {},
        env: { BUZZ_PRIVATE_KEY: "nsec1injected", NOSTR_PRIVATE_KEY: "x", BUZZ_AUTH_TAG: "y" },
        owner_pubkey: null,
      },
    });
    expect(env["BUZZ_PRIVATE_KEY"]).toBeUndefined();
    expect(env["NOSTR_PRIVATE_KEY"]).toBeUndefined();
    expect(env["BUZZ_AUTH_TAG"]).toBeUndefined();
    expect(Object.values(env).some((value) => value.startsWith("nsec1"))).toBe(false);
  });

  it("refuses to let user env disable presence, the only status signal there is", () => {
    expect(() =>
      envFor({
        launch: {
          command: "autogent-nostr",
          args: [],
          policy_env: {},
          env: { BUZZ_ACP_NO_PRESENCE: "1" },
          owner_pubkey: null,
        },
      }),
    ).toThrow(/only signal/);

    expect(() =>
      envFor({
        launch: {
          command: "autogent-nostr",
          args: [],
          policy_env: {},
          env: { AUTOGENT_PRESENCE: "false" },
          owner_pubkey: null,
        },
      }),
    ).toThrow(/only signal/);
  });

  it("does not bake the launching machine's own agent configuration into the child", () => {
    const env = envFor({}, {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      AUTOGENT_CHANNELS: "a-channel-the-developer-was-debugging",
      BUZZ_RELAY_URL: "wss://the-developers-relay",
      ANTHROPIC_API_KEY: "sk-kept",
    });
    expect(env["AUTOGENT_CHANNELS"]).toBeUndefined();
    expect(env["BUZZ_RELAY_URL"]).toBeUndefined();
    // …while everything the agent legitimately needs is still inherited.
    expect(env["HOME"]).toBe("/home/dev");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-kept");
  });

  it("uses the legacy env_vars only when there is no launch block", () => {
    const env = envFor({ launch: null, env_vars: { LEGACY: "yes" } });
    expect(env["LEGACY"]).toBe("yes");

    const layered = envFor({
      env_vars: { LEGACY: "yes" },
      launch: {
        command: "autogent-nostr",
        args: [],
        policy_env: {},
        env: { RESOLVED: "yes" },
        owner_pubkey: null,
      },
    });
    expect(layered["RESOLVED"]).toBe("yes");
    expect(layered["LEGACY"]).toBeUndefined();
  });

  it("rejects a key that is not a valid variable name", () => {
    expect(() =>
      envFor({
        launch: {
          command: "autogent-nostr",
          args: [],
          policy_env: {},
          env: { "BUZZ_AUTH_TAG=x": "smuggled" },
          owner_pubkey: null,
        },
      }),
    ).toThrow(/not a valid environment variable name/);
  });

  it("carries the generation token as the lifecycle correlator", () => {
    expect(envFor()["BUZZ_MANAGED_AGENT_START_NONCE"]).toBe("gen-1");
  });
});
