import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentAuthPath,
  credentialDigestsOf,
  ensureAgentAuthDir,
  readAgentAuth,
  readBindings,
  recordBinding,
  removeBinding,
} from "../src/owner-auth/store.js";

const AGENT_A = "a".repeat(64);
const AGENT_B = "b".repeat(64);

const AUTH_ACCOUNT_1 = JSON.stringify({
  anthropic: { type: "oauth", refresh: "refresh-token-one", access: "x", expires: 1 },
});
const AUTH_ACCOUNT_2 = JSON.stringify({
  anthropic: { type: "oauth", refresh: "refresh-token-two", access: "y", expires: 2 },
});
const AUTH_MULTI_PROVIDER = JSON.stringify({
  anthropic: { type: "oauth", refresh: "refresh-token-one", access: "x", expires: 1 },
  google: { type: "api_key", key: "api-key-one" },
});
const AUTH_GOOGLE_ONLY = JSON.stringify({
  google: { type: "api_key", key: "api-key-one" },
});

describe("owner auth store", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autogent-owner-auth-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stores per-agent auth files and reads them back", async () => {
    const path = await ensureAgentAuthDir(AGENT_A, root);
    expect(path).toBe(agentAuthPath(AGENT_A, root));
    await writeFile(path, AUTH_ACCOUNT_1);
    expect(await readAgentAuth(AGENT_A, root)).toBe(AUTH_ACCOUNT_1);
    expect(await readAgentAuth(AGENT_B, root)).toBeNull();
  });

  it("binds one account to one agent and refuses the second agent (1:1)", async () => {
    expect(await recordBinding(AGENT_A, AUTH_ACCOUNT_1, root)).toEqual({ ok: true });

    const conflict = await recordBinding(AGENT_B, AUTH_ACCOUNT_1, root);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.conflict.agentPubkey).toBe(AGENT_A);

    // A different account binds fine.
    expect(await recordBinding(AGENT_B, AUTH_ACCOUNT_2, root)).toEqual({ ok: true });
    expect((await readBindings(root)).bindings).toHaveLength(2);
  });

  it("re-binding the same agent replaces its entry instead of duplicating", async () => {
    await recordBinding(AGENT_A, AUTH_ACCOUNT_1, root);
    await recordBinding(AGENT_A, AUTH_ACCOUNT_2, root);
    const file = await readBindings(root);
    expect(file.bindings).toHaveLength(1);
    expect(file.bindings[0]?.refreshDigest).toBe(credentialDigestsOf(AUTH_ACCOUNT_2)[0]?.digest);
  });

  it("records one binding per provider credential in the file", async () => {
    expect(await recordBinding(AGENT_A, AUTH_MULTI_PROVIDER, root)).toEqual({ ok: true });
    const file = await readBindings(root);
    expect(file.bindings.map((binding) => binding.providerId).sort()).toEqual([
      "anthropic",
      "google",
    ]);
  });

  it("enforces the 1:1 rule per provider, api_key credentials included", async () => {
    await recordBinding(AGENT_A, AUTH_MULTI_PROVIDER, root);

    // Same google key on another agent → refused.
    const conflict = await recordBinding(AGENT_B, AUTH_GOOGLE_ONLY, root);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.conflict.agentPubkey).toBe(AGENT_A);
      expect(conflict.conflict.providerId).toBe("google");
    }

    // A different account on the same provider binds fine.
    expect(await recordBinding(AGENT_B, AUTH_ACCOUNT_2, root)).toEqual({ ok: true });
  });

  it("removes bindings on revoke", async () => {
    await recordBinding(AGENT_A, AUTH_ACCOUNT_1, root);
    expect(await removeBinding(AGENT_A, root)).toBe(true);
    expect(await removeBinding(AGENT_A, root)).toBe(false);
    expect((await readBindings(root)).bindings).toHaveLength(0);
  });

  it("derives no digests from malformed credential files", () => {
    expect(credentialDigestsOf("not json")).toEqual([]);
    expect(credentialDigestsOf(JSON.stringify({ anthropic: { type: "api_key" } }))).toEqual([]);
    expect(credentialDigestsOf(JSON.stringify({ anthropic: { type: "oauth" } }))).toEqual([]);
  });
});
