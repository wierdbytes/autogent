/**
 * The create-intent fingerprint.
 *
 * Its two scope rules are asserted structurally rather than argued: the digest
 * must not move when a secret's *value* changes (or it would be a dictionary
 * oracle over a world-readable file), and it must not move when the attempt's
 * generation token changes (or every attempt would diverge from every other and
 * "replace on divergence" would degenerate into "replace always").
 */

import { describe, expect, it } from "vitest";
import { canonicalIntent, fingerprint, type CreateIntent } from "../src/backend/intent.js";

const base: CreateIntent = {
  command: "/usr/local/bin/autogent-nostr",
  args: ["run"],
  cwd: "/work",
  stateDir: "/state",
  env: {
    AUTOGENT_RELAY_URL: "ws://localhost:3000",
    ANTHROPIC_API_KEY: "sk-one",
    BUZZ_MANAGED_AGENT_START_NONCE: "gen-1",
  },
};

describe("create-intent fingerprint", () => {
  it("is stable across attempts of the same configuration", () => {
    const other: CreateIntent = {
      ...base,
      env: { ...base.env, BUZZ_MANAGED_AGENT_START_NONCE: "gen-2" },
    };
    expect(fingerprint(other)).toBe(fingerprint(base));
  });

  it("ignores key insertion order", () => {
    const reordered: CreateIntent = {
      ...base,
      env: {
        BUZZ_MANAGED_AGENT_START_NONCE: "gen-9",
        ANTHROPIC_API_KEY: "sk-one",
        AUTOGENT_RELAY_URL: "ws://localhost:3000",
      },
    };
    expect(fingerprint(reordered)).toBe(fingerprint(base));
  });

  it("does not move when a secret's value changes", () => {
    const rotated: CreateIntent = { ...base, env: { ...base.env, ANTHROPIC_API_KEY: "sk-two" } };
    expect(fingerprint(rotated)).toBe(fingerprint(base));
  });

  it("never lets a secret value into the digest input", () => {
    expect(canonicalIntent(base)).not.toContain("sk-one");
    expect(canonicalIntent(base)).toContain("ANTHROPIC_API_KEY");
  });

  it("moves when a secret-shaped variable appears or disappears", () => {
    const { ANTHROPIC_API_KEY: _dropped, ...rest } = base.env;
    void _dropped;
    expect(fingerprint({ ...base, env: rest })).not.toBe(fingerprint(base));
  });

  it("moves when anything that shapes the launch changes", () => {
    expect(fingerprint({ ...base, command: "/opt/autogent-nostr" })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, cwd: "/elsewhere" })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, stateDir: "/elsewhere" })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, args: ["run", "--verbose"] })).not.toBe(fingerprint(base));
    expect(
      fingerprint({ ...base, env: { ...base.env, AUTOGENT_MODEL: "gpt-5" } }),
    ).not.toBe(fingerprint(base));
  });
});
