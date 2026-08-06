import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authFilePath,
  digestOf,
  isPlausibleAuthJson,
  langfuseCredentialsFromEnv,
  langfuseCredentialsFromValue,
  materializeAuth,
  piAgentDir,
  readLocalAuth,
  reconcileProviderAuth,
  recordAuthSynced,
  watchAuthFile,
} from "../src/runtime/provider-auth.js";

const AUTH_V1 = JSON.stringify({ anthropic: { type: "oauth", refresh: "r1", access: "a1", expires: 1 } });
const AUTH_V2 = JSON.stringify({ anthropic: { type: "oauth", refresh: "r2", access: "a2", expires: 2 } });

describe("provider-auth materialisation", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "autogent-auth-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes auth.json with owner-only permissions inside the state dir", async () => {
    const path = await materializeAuth(stateDir, AUTH_V1, 100);
    expect(path).toBe(authFilePath(stateDir));
    expect(await readFile(path, "utf8")).toBe(AUTH_V1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(piAgentDir(stateDir)).mode & 0o777).toBe(0o700);
  });

  it("reports missing when there is neither a head nor a local file", async () => {
    expect(await reconcileProviderAuth(stateDir, null)).toEqual({ action: "missing" });
  });

  it("treats a tombstoned head as revoked even when a local file exists", async () => {
    await materializeAuth(stateDir, AUTH_V1, 100);
    expect(await reconcileProviderAuth(stateDir, { content: null, createdAt: 200 })).toEqual({
      action: "revoked",
    });
  });

  it("materialises the head when the PVC is empty", async () => {
    const result = await reconcileProviderAuth(stateDir, { content: AUTH_V1, createdAt: 100 });
    expect(result.action).toBe("materialized");
    expect(await readLocalAuth(stateDir)).toBe(AUTH_V1);
  });

  it("publishes the local file when the relay lost the head", async () => {
    await materializeAuth(stateDir, AUTH_V1, 100);
    const result = await reconcileProviderAuth(stateDir, null);
    expect(result).toMatchObject({ action: "publish-local", content: AUTH_V1 });
  });

  it("is a no-op when local matches the synced head", async () => {
    await materializeAuth(stateDir, AUTH_V1, 100);
    expect((await reconcileProviderAuth(stateDir, { content: AUTH_V1, createdAt: 100 })).action).toBe(
      "none",
    );
  });

  it("applies a newer head over an unchanged local file", async () => {
    await materializeAuth(stateDir, AUTH_V1, 100);
    const result = await reconcileProviderAuth(stateDir, { content: AUTH_V2, createdAt: 200 });
    expect(result.action).toBe("materialized");
    expect(await readLocalAuth(stateDir)).toBe(AUTH_V2);
  });

  it("prefers a diverged local file whose mtime is newer than the head", async () => {
    await materializeAuth(stateDir, AUTH_V1, 100);
    // pi refreshed the token and the process died before write-back.
    await writeFile(authFilePath(stateDir), AUTH_V2);
    const future = new Date(Date.now() + 60_000);
    utimesSync(authFilePath(stateDir), future, future);

    const result = await reconcileProviderAuth(stateDir, { content: AUTH_V1, createdAt: 100 });
    expect(result).toMatchObject({ action: "publish-local", content: AUTH_V2 });
  });

  it("prefers the head over a diverged local file that is older", async () => {
    await materializeAuth(stateDir, AUTH_V1, 100);
    await writeFile(authFilePath(stateDir), AUTH_V2);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(authFilePath(stateDir), past, past);
    const headCreatedAt = Math.floor(Date.now() / 1000);

    const result = await reconcileProviderAuth(stateDir, { content: AUTH_V1, createdAt: headCreatedAt });
    expect(result.action).toBe("materialized");
    expect(await readLocalAuth(stateDir)).toBe(AUTH_V1);
  });

  it("validates auth.json plausibility", () => {
    expect(isPlausibleAuthJson(AUTH_V1)).toBe(true);
    expect(isPlausibleAuthJson("[]")).toBe(false);
    expect(isPlausibleAuthJson("nope")).toBe(false);
  });
});

describe("langfuse credentials", () => {
  it("reads both standard env variables", () => {
    expect(
      langfuseCredentialsFromEnv({ LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-1" }),
    ).toEqual({ publicKey: "pk-lf-1", secretKey: "sk-lf-1" });
  });

  it("trims surrounding whitespace", () => {
    expect(
      langfuseCredentialsFromEnv({ LANGFUSE_PUBLIC_KEY: " pk-lf-1 ", LANGFUSE_SECRET_KEY: "sk-lf-1\n" }),
    ).toEqual({ publicKey: "pk-lf-1", secretKey: "sk-lf-1" });
  });

  it("treats a half-configured or empty env as absent", () => {
    expect(langfuseCredentialsFromEnv({ LANGFUSE_PUBLIC_KEY: "pk-lf-1" })).toBeNull();
    expect(langfuseCredentialsFromEnv({ LANGFUSE_SECRET_KEY: "sk-lf-1" })).toBeNull();
    expect(langfuseCredentialsFromEnv({})).toBeNull();
    expect(
      langfuseCredentialsFromEnv({ LANGFUSE_PUBLIC_KEY: "  ", LANGFUSE_SECRET_KEY: "sk-lf-1" }),
    ).toBeNull();
  });

  it("parses a well-formed record value", () => {
    expect(langfuseCredentialsFromValue({ public_key: "pk-lf-2", secret_key: "sk-lf-2" })).toEqual({
      publicKey: "pk-lf-2",
      secretKey: "sk-lf-2",
    });
  });

  it("treats a tombstone and any malformed shape as no credentials", () => {
    // null is the owner's revocation tombstone.
    expect(langfuseCredentialsFromValue(null)).toBeNull();
    expect(langfuseCredentialsFromValue(undefined)).toBeNull();
    expect(langfuseCredentialsFromValue(["pk", "sk"])).toBeNull();
    expect(langfuseCredentialsFromValue("pk-lf-2")).toBeNull();
    expect(langfuseCredentialsFromValue({})).toBeNull();
    expect(langfuseCredentialsFromValue({ public_key: "pk-lf-2" })).toBeNull();
    expect(langfuseCredentialsFromValue({ secret_key: "sk-lf-2" })).toBeNull();
    expect(langfuseCredentialsFromValue({ public_key: "", secret_key: "sk-lf-2" })).toBeNull();
    expect(langfuseCredentialsFromValue({ public_key: "pk-lf-2", secret_key: "   " })).toBeNull();
    expect(langfuseCredentialsFromValue({ public_key: 1, secret_key: 2 })).toBeNull();
  });
});

describe("watchAuthFile", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "autogent-watch-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("fires for a foreign write and ignores our own materialisation", async () => {
    await materializeAuth(stateDir, AUTH_V1, 100);
    const seen: string[] = [];
    const stop = watchAuthFile({
      stateDir,
      debounceMs: 20,
      onRefresh: (content) => seen.push(content),
    });

    try {
      // Rewrite with identical (synced) content: watcher must stay silent.
      await writeFile(authFilePath(stateDir), AUTH_V1);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(seen).toEqual([]);

      // A real refresh (content diverges from the sync watermark) must fire.
      await writeFile(authFilePath(stateDir), AUTH_V2);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(seen).toEqual([AUTH_V2]);

      // After recording the sync, the same content no longer fires.
      await recordAuthSynced(stateDir, AUTH_V2, 200);
      expect(digestOf(AUTH_V2)).not.toBe(digestOf(AUTH_V1));
      await writeFile(authFilePath(stateDir), AUTH_V2);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(seen).toEqual([AUTH_V2]);
    } finally {
      stop();
    }
  });
});
