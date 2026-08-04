import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentAuthPath,
  ensureAgentAuthDir,
  readAgentAuth,
  readBindings,
  recordBinding,
  refreshDigestOf,
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
    expect(file.bindings[0]?.refreshDigest).toBe(refreshDigestOf(AUTH_ACCOUNT_2));
  });

  it("removes bindings on revoke", async () => {
    await recordBinding(AGENT_A, AUTH_ACCOUNT_1, root);
    expect(await removeBinding(AGENT_A, root)).toBe(true);
    expect(await removeBinding(AGENT_A, root)).toBe(false);
    expect((await readBindings(root)).bindings).toHaveLength(0);
  });

  it("derives no digest from malformed credential files", () => {
    expect(refreshDigestOf("not json")).toBeNull();
    expect(refreshDigestOf(JSON.stringify({ anthropic: { type: "api_key" } }))).toBeNull();
  });
});
