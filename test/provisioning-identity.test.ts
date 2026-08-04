import { mkdtemp, rm, stat, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileSecretBackend,
  IdentityStore,
  ProvisioningError,
  SECRET_FILE_MODE,
  STATE_DIR_MODE,
  createIdentityStore,
  parseIdentityRecord,
  parsePairingRequest,
} from "../src/provisioning/identity-store.js";
import type { IdentityRecord } from "../src/provisioning/identity-store.js";

const POSIX = process.platform !== "win32";
const SECRET = new Uint8Array(32).fill(0x11);
const SECRET_HEX = Buffer.from(SECRET).toString("hex");

let stateDir: string;
let store: IdentityStore;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "pi-nostr-identity-"));
  store = createIdentityStore({ stateDir: join(stateDir, "state") });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function record(agentPubkey: string): IdentityRecord {
  return {
    version: 1,
    agentPubkey,
    createdAt: 1_700_000_000_000,
    pairing: {
      version: 1,
      agentPubkey,
      relayUrl: "wss://relay.example",
      profile: { name: "Pi Agent", about: "Autonomous Pi SDK agent" },
      nonce: "0".repeat(32),
    },
    ownerPubkey: null,
    auth: null,
    provisionedAt: null,
  };
}

describe("sealed secret", () => {
  it("creates the state directory 0700 and the secret file 0600", async () => {
    await store.sealSecret(SECRET);
    if (!POSIX) return;
    expect((await stat(store.stateDir)).mode & 0o777).toBe(STATE_DIR_MODE);
    expect((await stat(store.backend.location as string)).mode & 0o777).toBe(SECRET_FILE_MODE);
  });

  it("loads the secret only as a signer", async () => {
    await store.sealSecret(SECRET);
    const signer = await store.loadSigner();
    expect(signer.publicKey).toBe(getPublicKey(SECRET));
    expect(Object.values(signer)).not.toContain(SECRET_HEX);
  });

  it("refuses to clobber an existing secret unless replacing", async () => {
    await store.sealSecret(SECRET);
    await expect(store.sealSecret(new Uint8Array(32).fill(0x22))).rejects.toThrow(ProvisioningError);
    await store.sealSecret(new Uint8Array(32).fill(0x22), true);
    expect((await store.loadSigner()).publicKey).toBe(getPublicKey(new Uint8Array(32).fill(0x22)));
  });

  it("reports a missing secret with an actionable code", async () => {
    await expect(store.loadSigner()).rejects.toMatchObject({ code: "secret-missing" });
  });
});

describe("secret containment", () => {
  it("keeps the secret out of every object the store hands back", async () => {
    await store.sealSecret(SECRET);
    const stored = record(getPublicKey(SECRET));
    await store.writeRecord(stored);

    const signer = await store.loadSigner();
    const surfaces = [
      JSON.stringify(store),
      JSON.stringify(store.backend),
      JSON.stringify(await store.readRecord()),
      JSON.stringify(signer),
      JSON.stringify({ ...signer }),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(SECRET_HEX);
    }

    // The file itself is the one place it exists, which is the documented limitation.
    expect(await readFile(store.backend.location as string, "utf8")).toContain(SECRET_HEX);
  });
});

describe("identity record", () => {
  it("round-trips through disk", async () => {
    const stored = record("b".repeat(64));
    await store.writeRecord(stored);
    expect(await store.readRecord()).toEqual(stored);
  });

  it("returns null when absent and throws from requireRecord", async () => {
    expect(await store.readRecord()).toBeNull();
    await expect(store.requireRecord()).rejects.toMatchObject({ code: "identity-missing" });
  });

  it("rejects a malformed record rather than half-loading it", () => {
    const broken = { ...record("b".repeat(64)), agentPubkey: "nope" };
    expect(() => parseIdentityRecord(broken)).toThrow(/agentPubkey/);
  });
});

describe("pairing request validation", () => {
  const valid = record("b".repeat(64)).pairing;

  it("accepts the canonical shape", () => {
    expect(parsePairingRequest(valid)).toEqual(valid);
  });

  it("rejects a non-websocket relay, a short nonce and a bad version", () => {
    expect(() => parsePairingRequest({ ...valid, relayUrl: "https://relay" })).toThrow(/relayUrl/);
    expect(() => parsePairingRequest({ ...valid, nonce: "short" })).toThrow(/nonce/);
    expect(() => parsePairingRequest({ ...valid, version: 2 })).toThrow(/version/);
    expect(() => parsePairingRequest({ ...valid, profile: { name: 1 } })).toThrow(/profile/);
  });
});

describe("file backend", () => {
  it("reports a widened mode through stat so doctor can see it", async () => {
    if (!POSIX) return;
    const backend = new FileSecretBackend(join(store.stateDir, "agent.key"));
    await store.ensureStateDir();
    await backend.seal(SECRET);
    await chmod(backend.location, 0o644);
    expect((await stat(backend.location)).mode & 0o077).not.toBe(0);
  });

  it("refuses a secret that is not 32 bytes", async () => {
    await store.ensureStateDir();
    await expect(store.sealSecret(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});
