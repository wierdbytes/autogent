import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { nsecEncode } from "nostr-tools/nip19";
import { bootstrapIdentityFromEnv } from "../src/provisioning/bootstrap.js";
import { createIdentityStore } from "../src/provisioning/identity-store.js";
import { signAttestation, toNostrTag } from "../src/nostr/nip-oa.js";

describe("bootstrapIdentityFromEnv", () => {
  let stateDir: string;
  const agentSecret = generateSecretKey();
  const agentPubkey = getPublicKey(agentSecret);
  const ownerSecret = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerSecret);
  const authTagJson = JSON.stringify(toNostrTag(signAttestation(ownerSecret, agentPubkey, "")));

  const inputs = (overrides: Partial<Record<"nsec" | "authTag", string | undefined>> = {}) => ({
    nsec: "nsec" in overrides ? overrides.nsec : nsecEncode(agentSecret),
    authTag: "authTag" in overrides ? overrides.authTag : authTagJson,
    relayUrl: "wss://relay.example",
    profileName: "Test Agent",
  });

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "autogent-bootstrap-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("materialises a sealed, provisioned identity on first start", async () => {
    const store = createIdentityStore({ stateDir });
    const outcome = await bootstrapIdentityFromEnv(store, inputs());
    expect(outcome).toEqual({ kind: "bootstrapped", agentPubkey, ownerPubkey });

    const record = await store.requireRecord();
    expect(record.agentPubkey).toBe(agentPubkey);
    expect(record.ownerPubkey).toBe(ownerPubkey);
    expect(record.auth?.ownerPubkey).toBe(ownerPubkey);
    expect(record.provisionedAt).not.toBeNull();

    const signer = await store.loadSigner();
    expect(signer.publicKey).toBe(agentPubkey);
  });

  it("accepts a 64-char hex secret as well as nsec", async () => {
    const store = createIdentityStore({ stateDir });
    const outcome = await bootstrapIdentityFromEnv(store, inputs({ nsec: bytesToHex(agentSecret) }));
    expect(outcome.kind).toBe("bootstrapped");
  });

  it("ignores the env once a sealed identity exists (state is the source of truth)", async () => {
    const store = createIdentityStore({ stateDir });
    await bootstrapIdentityFromEnv(store, inputs());

    // Second start delivers a *different* key; it must not clobber the seal.
    const otherSecret = generateSecretKey();
    const otherTag = JSON.stringify(
      toNostrTag(signAttestation(ownerSecret, getPublicKey(otherSecret), "")),
    );
    const outcome = await bootstrapIdentityFromEnv(
      store,
      inputs({ nsec: nsecEncode(otherSecret), authTag: otherTag }),
    );
    expect(outcome.kind).toBe("existing");
    expect((await store.requireRecord()).agentPubkey).toBe(agentPubkey);
  });

  it("reports absent when there is neither a seal nor a bootstrap env", async () => {
    const store = createIdentityStore({ stateDir });
    const outcome = await bootstrapIdentityFromEnv(store, inputs({ nsec: undefined }));
    expect(outcome.kind).toBe("absent");
  });

  it("refuses an nsec without an auth tag (fail-closed, I1)", async () => {
    const store = createIdentityStore({ stateDir });
    await expect(bootstrapIdentityFromEnv(store, inputs({ authTag: undefined }))).rejects.toThrow(
      /AUTOGENT_AUTH_TAG/,
    );
  });

  it("refuses an attestation minted for a different key", async () => {
    const store = createIdentityStore({ stateDir });
    const foreign = JSON.stringify(
      toNostrTag(signAttestation(ownerSecret, getPublicKey(generateSecretKey()), "")),
    );
    await expect(bootstrapIdentityFromEnv(store, inputs({ authTag: foreign }))).rejects.toThrow(
      /does not verify/,
    );
  });

  it("refuses conditions that do not cover the agent's publish surface", async () => {
    const store = createIdentityStore({ stateDir });
    const narrow = JSON.stringify(toNostrTag(signAttestation(ownerSecret, agentPubkey, "kind=9")));
    await expect(bootstrapIdentityFromEnv(store, inputs({ authTag: narrow }))).rejects.toThrow(
      /do not cover/,
    );
  });

  it("refuses garbage secrets and malformed tags", async () => {
    const store = createIdentityStore({ stateDir });
    await expect(bootstrapIdentityFromEnv(store, inputs({ nsec: "gibberish" }))).rejects.toThrow(
      /not a usable secret/,
    );
    await expect(bootstrapIdentityFromEnv(store, inputs({ authTag: "gibberish" }))).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
