/**
 * Owner-side Langfuse key management (tracing plan §5.2, §9 step 4):
 * the `autogent/langfuse` slug/record-body plumbing and the pure key-shape
 * validation used by `langfuse set`. CLI commands themselves talk to a live
 * relay via `connectAsAgent`/`RecordClient`, already covered end-to-end by
 * the `auth`/`config` commands they mirror — no need to re-mock that here.
 */

import { describe, expect, it } from "vitest";
import {
  CONFIG_SLUG,
  LANGFUSE_SLUG,
  isValidSlug,
  parseRecordBody,
  serializeRecordBody,
} from "../src/nostr/config-records.js";
import { checkLangfuseKeyShape } from "../src/owner-auth/langfuse-cli.js";

describe("LANGFUSE_SLUG", () => {
  it("is a valid config-record slug", () => {
    expect(isValidSlug(LANGFUSE_SLUG)).toBe(true);
    expect(LANGFUSE_SLUG).toBe("autogent/langfuse");
  });
});

describe("langfuse record body", () => {
  it("round-trips a live key pair", () => {
    const value = { public_key: "pk-lf-abc", secret_key: "sk-lf-xyz" };
    const body = parseRecordBody(
      serializeRecordBody({ slug: LANGFUSE_SLUG, value }),
      LANGFUSE_SLUG,
    );
    expect(body).toEqual({ slug: LANGFUSE_SLUG, value });
  });

  it("accepts a tombstone (value: null) — unlike autogent/config", () => {
    const tomb = parseRecordBody(
      JSON.stringify({ slug: LANGFUSE_SLUG, value: null }),
      LANGFUSE_SLUG,
    );
    expect(tomb).toEqual({ slug: LANGFUSE_SLUG, value: null });

    // The contrast this guards: the same shape is rejected under CONFIG_SLUG.
    expect(parseRecordBody(JSON.stringify({ slug: CONFIG_SLUG, value: null }), CONFIG_SLUG)).toBeNull();
  });

  it("rejects a body whose slug does not match the queried slug", () => {
    expect(
      parseRecordBody(JSON.stringify({ slug: "autogent/other", value: {} }), LANGFUSE_SLUG),
    ).toBeNull();
  });

  it("rejects a non-object, non-null value", () => {
    expect(
      parseRecordBody(JSON.stringify({ slug: LANGFUSE_SLUG, value: "pk-lf-abc" }), LANGFUSE_SLUG),
    ).toBeNull();
    expect(
      parseRecordBody(JSON.stringify({ slug: LANGFUSE_SLUG, value: [1] }), LANGFUSE_SLUG),
    ).toBeNull();
  });
});

describe("checkLangfuseKeyShape", () => {
  it("is silent for well-formed keys", () => {
    expect(checkLangfuseKeyShape("pk-lf-abc", "sk-lf-xyz")).toEqual([]);
  });

  it("warns, but does not throw, on an unexpected public-key prefix", () => {
    const warnings = checkLangfuseKeyShape("not-a-key", "sk-lf-xyz");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/public key/i);
  });

  it("warns on an unexpected secret-key prefix", () => {
    const warnings = checkLangfuseKeyShape("pk-lf-abc", "not-a-key");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/secret key/i);
  });

  it("warns on both when both prefixes are off, and never rejects", () => {
    expect(checkLangfuseKeyShape("nope", "nope")).toHaveLength(2);
  });
});
