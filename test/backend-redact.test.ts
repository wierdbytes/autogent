/**
 * Output scrubbing.
 *
 * Buzz Desktop redacts provider output on the assumption that it is hostile, so
 * this is belt to its suspenders — but the provider is also run by hand and by
 * tests, where nothing sits between its stdout and a terminal. A component that
 * only behaves when somebody else is watching is not the property we want.
 */

import { describe, expect, it } from "vitest";
import { redactSecrets, secretsFromRequest, REDACTED } from "../src/backend/redact.js";
import { mintAgent } from "./helpers/backend-request.js";

describe("redaction", () => {
  it("collects the values worth scrubbing from every layer of a request", () => {
    const minted = mintAgent({
      env_vars: { LEGACY_SECRET: "legacy-value" },
      launch: {
        command: "autogent-nostr",
        args: [],
        env: { API_TOKEN: "user-layer-value" },
        policy_env: { POLICY: "policy-layer-value" },
        owner_pubkey: mintOwner(),
      },
    });
    const secrets = secretsFromRequest(JSON.stringify({ op: "deploy", agent: minted.agent }));

    expect(secrets).toContain(minted.nsec);
    expect(secrets).toContain("legacy-value");
    expect(secrets).toContain("user-layer-value");
    expect(secrets).toContain("policy-layer-value");
  });

  it("still finds the key in a request that failed to validate", () => {
    // The message about a malformed payload is exactly where a naive
    // implementation echoes the payload.
    const minted = mintAgent({ relay_url: 42 });
    const secrets = secretsFromRequest(JSON.stringify({ op: "deploy", agent: minted.agent }));
    expect(secrets).toContain(minted.nsec);
  });

  it("redacts longest-first so a shorter value cannot leave a tail exposed", () => {
    const text = "value=abcdefgh and value=abcd";
    expect(redactSecrets(text, ["abcd", "abcdefgh"])).toBe(
      `value=${REDACTED} and value=${REDACTED}`,
    );
  });

  it("redacts key-shaped tokens nobody told it about", () => {
    const stray = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    expect(redactSecrets(`boom ${stray}`, [])).toBe(`boom ${REDACTED}`);
  });

  it("leaves JSON keywords alone, whatever env var they arrived in", () => {
    // `BUZZ_ACP_LAZY_POOL=true` makes `true` a four-character "secret value".
    // Redacting it protects nothing and destroys any text that contains it.
    expect(redactSecrets('{"ok":true}', ["true"])).toBe('{"ok":true}');
    expect(redactSecrets("result was false", ["false"])).toBe("result was false");
  });

  it("ignores short values, which are noise rather than secrets", () => {
    // The desktop applies the same ≥ 4 rule: a two-character env value would
    // otherwise redact half of every message that happens to contain it.
    expect(redactSecrets("a=1", ["1"])).toBe("a=1");
    expect(redactSecrets("mode=dev", ["dev"])).toBe("mode=dev");
  });
});

function mintOwner(): string {
  return "a".repeat(64);
}
