import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Attestation } from "../src/provisioning/attest.js";
import {
  DEFAULT_CONDITIONS,
  attestFromFile,
  createAttestation,
  readOwnerSecret,
} from "../src/provisioning/attest.js";
import { importAttestation, importAttestationFile } from "../src/provisioning/import.js";
import { initIdentity } from "../src/provisioning/init.js";
import {
  SECRET_FILE_MODE,
  STATE_DIR_MODE,
  createIdentityStore,
} from "../src/provisioning/identity-store.js";
import type { IdentityStore, PairingRequest } from "../src/provisioning/identity-store.js";

const POSIX = process.platform !== "win32";
const RELAY_URL = "wss://relay.example";

let workDir: string;
let stateDir: string;
let store: IdentityStore;
let ownerSecret: Uint8Array;
let ownerSecretPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pi-nostr-provision-"));
  stateDir = join(workDir, "state");
  store = createIdentityStore({ stateDir });
  ownerSecret = generateSecretKey();
  ownerSecretPath = join(workDir, "owner.key");
  await writeFile(ownerSecretPath, `${Buffer.from(ownerSecret).toString("hex")}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function init(): Promise<{ pairingRequest: PairingRequest; agentPubkey: string }> {
  const result = await initIdentity({
    stateDir,
    relayUrl: RELAY_URL,
    profile: { name: "Pi Agent", about: "Autonomous Pi SDK agent" },
    store,
  });
  return { pairingRequest: result.pairingRequest, agentPubkey: result.agentPubkey };
}

async function attest(
  pairingRequest: PairingRequest,
  conditions = DEFAULT_CONDITIONS,
): Promise<Attestation> {
  return createAttestation({
    pairingRequest,
    ownerSecret: { from: "file", path: ownerSecretPath },
    conditions,
  });
}

describe("init", () => {
  it("emits a secret-free pairing request and seals the key", async () => {
    const result = await initIdentity({
      stateDir,
      relayUrl: RELAY_URL,
      profile: { name: "Pi Agent", about: "Autonomous Pi SDK agent" },
      store,
    });

    expect(result.pairingRequest).toEqual({
      version: 1,
      agentPubkey: result.agentPubkey,
      relayUrl: RELAY_URL,
      profile: { name: "Pi Agent", about: "Autonomous Pi SDK agent" },
      nonce: expect.any(String) as unknown as string,
    });

    const onDisk = JSON.parse(await readFile(result.pairingRequestPath, "utf8")) as unknown;
    expect(onDisk).toEqual(result.pairingRequest);

    const secretHex = await readFile(store.backend.location as string, "utf8");
    expect(JSON.stringify(onDisk)).not.toContain(secretHex.trim());
    expect((await store.loadSigner()).publicKey).toBe(result.agentPubkey);

    if (POSIX) {
      expect((await stat(stateDir)).mode & 0o777).toBe(STATE_DIR_MODE);
      expect((await stat(store.backend.location as string)).mode & 0o777).toBe(SECRET_FILE_MODE);
    }
  });

  it("refuses a second init unless forced", async () => {
    await init();
    await expect(
      initIdentity({ stateDir, relayUrl: RELAY_URL, profile: { name: "a", about: "b" }, store }),
    ).rejects.toMatchObject({ code: "identity-exists" });

    const forced = await initIdentity({
      stateDir,
      relayUrl: RELAY_URL,
      profile: { name: "a", about: "b" },
      store,
      force: true,
    });
    expect((await store.loadSigner()).publicKey).toBe(forced.agentPubkey);
  });

  it("rejects a relay URL that is not a websocket", async () => {
    await expect(
      initIdentity({
        stateDir,
        relayUrl: "https://relay.example",
        profile: { name: "a", about: "b" },
        store,
      }),
    ).rejects.toMatchObject({ code: "invalid-pairing-request" });
  });
});

describe("attest", () => {
  it("defaults to empty conditions and never echoes the owner secret", async () => {
    const { pairingRequest, agentPubkey } = await init();
    const attestation = await attest(pairingRequest);

    expect(attestation.conditions).toBe("");
    expect(attestation.agentPubkey).toBe(agentPubkey);
    expect(attestation.ownerPubkey).toBe(getPublicKey(ownerSecret));
    expect(attestation.nonce).toBe(pairingRequest.nonce);
    expect(attestation.relayUrl).toBe(RELAY_URL);
    expect(attestation.auth[0]).toBe("auth");
    expect(JSON.stringify(attestation)).not.toContain(Buffer.from(ownerSecret).toString("hex"));
  });

  it("accepts the owner secret from an interactive prompt, not from argv", async () => {
    const { pairingRequest } = await init();
    let prompted = "";
    const attestation = await createAttestation({
      pairingRequest,
      ownerSecret: { from: "stdin" },
      readSecretLine: async (promptText) => {
        prompted = promptText;
        return Buffer.from(ownerSecret).toString("hex");
      },
    });
    expect(prompted).toMatch(/owner secret/i);
    expect(attestation.ownerPubkey).toBe(getPublicKey(ownerSecret));
  });

  it("refuses to attest the agent with its own key", async () => {
    const { pairingRequest, agentPubkey } = await init();
    const agentSecretHex = (await readFile(store.backend.location as string, "utf8")).trim();
    const selfKeyPath = join(workDir, "self.key");
    await writeFile(selfKeyPath, agentSecretHex, { mode: 0o600 });

    await expect(
      createAttestation({ pairingRequest, ownerSecret: { from: "file", path: selfKeyPath } }),
    ).rejects.toMatchObject({ code: "self-attestation" });
    expect(pairingRequest.agentPubkey).toBe(agentPubkey);
  });

  it("rejects a malformed owner secret and a malformed conditions string", async () => {
    const { pairingRequest } = await init();
    const junkPath = join(workDir, "junk.key");
    await writeFile(junkPath, "not-a-key");

    await expect(
      createAttestation({ pairingRequest, ownerSecret: { from: "file", path: junkPath } }),
    ).rejects.toMatchObject({ code: "secret-source" });

    await expect(attest(pairingRequest, "kind=9&")).rejects.toMatchObject({
      code: "invalid-attestation",
    });
  });

  it("rejects a missing owner secret file", async () => {
    await expect(readOwnerSecret({ from: "file", path: join(workDir, "nope") })).rejects.toMatchObject(
      { code: "secret-source" },
    );
  });
});

describe("round trip", () => {
  it("init -> attest -> import succeeds with a separate owner key", async () => {
    const { pairingRequest, agentPubkey } = await init();
    const attestation = await attest(pairingRequest);
    const result = await importAttestation({ attestation, store });

    expect(result.agentPubkey).toBe(agentPubkey);
    expect(result.ownerPubkey).toBe(getPublicKey(ownerSecret));
    expect(result.conditions).toBe("");

    const record = await store.requireRecord();
    expect(record.ownerPubkey).toBe(result.ownerPubkey);
    expect(record.auth).toEqual(result.auth);
    expect(record.provisionedAt).toBeTypeOf("number");
  });

  it("works file-to-file the way the CLI drives it", async () => {
    const initResult = await initIdentity({
      stateDir,
      relayUrl: RELAY_URL,
      profile: { name: "Pi Agent", about: "Autonomous Pi SDK agent" },
      store,
    });
    const outPath = join(workDir, "attestation.json");
    await attestFromFile({
      pairingRequestPath: initResult.pairingRequestPath,
      outPath,
      ownerSecret: { from: "file", path: ownerSecretPath },
    });

    const imported = await importAttestationFile({ attestationPath: outPath, stateDir });
    expect(imported.agentPubkey).toBe(initResult.agentPubkey);
  });
});

describe("import rejections", () => {
  it("rejects an attestation bound to a different agent pubkey", async () => {
    const { pairingRequest } = await init();
    const otherAgent = getPublicKey(generateSecretKey());
    const attestation = await attest({ ...pairingRequest, agentPubkey: otherAgent });

    await expect(importAttestation({ attestation, store })).rejects.toMatchObject({
      code: "pubkey-mismatch",
    });
  });

  it("rejects a tampered signature", async () => {
    const { pairingRequest } = await init();
    const attestation = await attest(pairingRequest);
    const signature = attestation.auth[3] as string;
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
    const tampered: Attestation = { ...attestation, auth: [...attestation.auth.slice(0, 3), flipped] };

    await expect(importAttestation({ attestation: tampered, store })).rejects.toMatchObject({
      code: "signature-invalid",
    });
  });

  it("rejects an attestation whose owner is the agent itself", async () => {
    const { pairingRequest, agentPubkey } = await init();
    const attestation = await attest(pairingRequest);
    const selfAttested: Attestation = {
      ...attestation,
      ownerPubkey: agentPubkey,
      auth: ["auth", agentPubkey, "", (attestation.auth[3] as string)],
    };

    await expect(importAttestation({ attestation: selfAttested, store })).rejects.toMatchObject({
      code: "self-attestation",
    });
  });

  it("rejects a nonce from a different pairing request", async () => {
    const { pairingRequest } = await init();
    const attestation = await attest(pairingRequest);

    await expect(
      importAttestation({ attestation: { ...attestation, nonce: "f".repeat(32) }, store }),
    ).rejects.toMatchObject({ code: "nonce-mismatch" });
  });

  it("rejects a relay URL that does not match the pairing request", async () => {
    const { pairingRequest } = await init();
    const attestation = await attest(pairingRequest);

    await expect(
      importAttestation({ attestation: { ...attestation, relayUrl: "wss://evil.example" }, store }),
    ).rejects.toMatchObject({ code: "relay-mismatch" });
  });

  it("rejects conditions that do not cover every published kind", async () => {
    const { pairingRequest } = await init();
    const attestation = await attest(pairingRequest, "kind=9");

    await expect(importAttestation({ attestation, store })).rejects.toMatchObject({
      code: "conditions-incomplete",
    });
    await expect(importAttestation({ attestation, store })).rejects.toThrow(/24200/);
  });

  it("rejects an expired created_at window", async () => {
    const { pairingRequest } = await init();
    const attestation = await attest(pairingRequest, "created_at<1000");

    await expect(importAttestation({ attestation, store })).rejects.toMatchObject({
      code: "conditions-incomplete",
    });
  });

  it("rejects structurally broken artifacts", async () => {
    await init();
    for (const broken of [null, [], { version: 2 }, { version: 1, agentPubkey: "x" }]) {
      await expect(importAttestation({ attestation: broken, store })).rejects.toMatchObject({
        code: "invalid-attestation",
      });
    }
  });

  it("rejects an auth tag whose fields disagree with the artifact", async () => {
    const { pairingRequest } = await init();
    const attestation = await attest(pairingRequest);

    await expect(
      importAttestation({ attestation: { ...attestation, conditions: "kind=9" }, store }),
    ).rejects.toMatchObject({ code: "invalid-attestation" });

    await expect(
      importAttestation({
        attestation: { ...attestation, ownerPubkey: getPublicKey(generateSecretKey()) },
        store,
      }),
    ).rejects.toMatchObject({ code: "invalid-attestation" });
  });

  it("leaves the identity unprovisioned after a rejection", async () => {
    const { pairingRequest } = await init();
    const attestation = await attest(pairingRequest);
    await importAttestation({ attestation: { ...attestation, nonce: "f".repeat(32) }, store }).catch(
      () => undefined,
    );
    const record = await store.requireRecord();
    expect(record.ownerPubkey).toBeNull();
    expect(record.auth).toBeNull();
  });
});
