import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import type { AgentConfig } from "../src/config.js";
import { signAttestation } from "../src/nostr/nip-oa.js";
import type { AuthTag } from "../src/nostr/nip-oa.js";
import { createAttestation } from "../src/provisioning/attest.js";
import {
  createDoctorFacade,
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
} from "../src/provisioning/doctor.js";
import type { CheckResult, DoctorFacade, PathFacts } from "../src/provisioning/doctor.js";
import { importAttestation } from "../src/provisioning/import.js";
import { initIdentity } from "../src/provisioning/init.js";
import { createIdentityStore } from "../src/provisioning/identity-store.js";
import type { IdentityRecord, IdentityStore } from "../src/provisioning/identity-store.js";

const POSIX = process.platform !== "win32";
const RELAY_URL = "wss://relay.example";

let workDir: string;
let stateDir: string;
let store: IdentityStore;
let ownerSecretPath: string;
let ownerSecret: Uint8Array;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pi-nostr-doctor-"));
  stateDir = join(workDir, "state");
  store = createIdentityStore({ stateDir });
  ownerSecret = generateSecretKey();
  ownerSecretPath = join(workDir, "owner.key");
  await writeFile(ownerSecretPath, Buffer.from(ownerSecret).toString("hex"), { mode: 0o600 });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultConfig(), stateDir, relayUrl: RELAY_URL, ...overrides };
}

function statusOf(results: readonly CheckResult[], name: string): string {
  const found = results.find((result) => result.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found.status;
}

function detailOf(results: readonly CheckResult[], name: string): string {
  const found = results.find((result) => result.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found.detail;
}

/** Facade over a fixture, so check logic can be exercised without a real host. */
function fakeFacade(overrides: Partial<DoctorFacade> = {}): DoctorFacade {
  const agentPubkey = "b".repeat(64);
  const paths: Record<string, PathFacts> = {
    [stateDir]: { exists: true, isDirectory: true, mode: 0o700 },
    [join(stateDir, "agent.key")]: { exists: true, isDirectory: false, mode: 0o600 },
  };
  return {
    stateDir,
    secretPath: join(stateDir, "agent.key"),
    secretBackendDescription: "fixture",
    recordPath: join(stateDir, "identity.json"),
    platform: "linux",
    now: () => 1_800_000_000_000,
    statPath: async (path) => paths[path] ?? { exists: false, isDirectory: false, mode: 0 },
    readRecord: async () => null,
    loadAgentPubkey: async () => agentPubkey,
    probePiSdk: async () => ({ ok: true, detail: "fixture sdk" }),
    probePiAuth: async () => ({ ok: true, detail: "fixture auth" }),
    ...overrides,
  };
}

function provisionedRecord(agentPubkey: string, auth: AuthTag): IdentityRecord {
  return {
    version: 1,
    agentPubkey,
    createdAt: 1,
    pairing: {
      version: 1,
      agentPubkey,
      relayUrl: RELAY_URL,
      profile: { name: "Pi Agent", about: "Autonomous Pi SDK agent" },
      nonce: "0".repeat(32),
    },
    ownerPubkey: auth.ownerPubkey,
    auth,
    provisionedAt: 2,
  };
}

describe("permission checks", () => {
  it("fails a world-readable secret file on a real host", async () => {
    if (!POSIX) return;
    const initResult = await initIdentity({
      stateDir,
      relayUrl: RELAY_URL,
      profile: { name: "Pi Agent", about: "Autonomous Pi SDK agent" },
      store,
    });
    const attestation = await createAttestation({
      pairingRequest: initResult.pairingRequest,
      ownerSecret: { from: "file", path: ownerSecretPath },
    });
    await importAttestation({ attestation, store });

    const healthy = await runDoctor(config(), createDoctorFacade({ store }));
    expect(statusOf(healthy, "secret-permissions")).toBe("ok");
    expect(statusOf(healthy, "state-dir")).toBe("ok");
    expect(statusOf(healthy, "identity")).toBe("ok");
    expect(statusOf(healthy, "attestation")).toBe("ok");
    expect(statusOf(healthy, "attestation-conditions")).toBe("ok");

    await chmod(store.backend.location as string, 0o644);
    const results = await runDoctor(config(), createDoctorFacade({ store }));
    expect(statusOf(results, "secret-permissions")).toBe("fail");
    expect(detailOf(results, "secret-permissions")).toMatch(/0644/);
    expect(doctorExitCode(results)).toBe(1);
  });

  it("fails a group-readable state directory", async () => {
    const results = await runDoctor(
      config(),
      fakeFacade({
        statPath: async (path) =>
          path === stateDir
            ? { exists: true, isDirectory: true, mode: 0o750 }
            : { exists: true, isDirectory: false, mode: 0o600 },
      }),
    );
    expect(statusOf(results, "state-dir")).toBe("fail");
    expect(detailOf(results, "state-dir")).toMatch(/0750/);
  });

  it("downgrades POSIX mode assertions to warnings on win32", async () => {
    const results = await runDoctor(config(), fakeFacade({ platform: "win32" }));
    expect(statusOf(results, "state-dir")).toBe("warn");
    expect(statusOf(results, "secret-permissions")).toBe("warn");
  });

  it("fails a missing state directory", async () => {
    const results = await runDoctor(
      config(),
      fakeFacade({ statPath: async () => ({ exists: false, isDirectory: false, mode: 0 }) }),
    );
    expect(statusOf(results, "state-dir")).toBe("fail");
    expect(statusOf(results, "secret-permissions")).toBe("fail");
  });
});

describe("identity and attestation checks", () => {
  it("fails when the sealed secret does not match the recorded pubkey", async () => {
    const auth = signAttestation(ownerSecret, "b".repeat(64), "");
    const results = await runDoctor(
      config(),
      fakeFacade({
        readRecord: async () => provisionedRecord("b".repeat(64), auth),
        loadAgentPubkey: async () => "c".repeat(64),
      }),
    );
    expect(statusOf(results, "identity")).toBe("fail");
    expect(detailOf(results, "identity")).toMatch(/inconsistent/);
  });

  it("fails an initialised but unprovisioned host with an actionable next step", async () => {
    const agentPubkey = getPublicKey(generateSecretKey());
    const auth = signAttestation(ownerSecret, agentPubkey, "");
    const pending: IdentityRecord = {
      ...provisionedRecord(agentPubkey, auth),
      ownerPubkey: null,
      auth: null,
      provisionedAt: null,
    };
    const results = await runDoctor(
      config(),
      fakeFacade({ readRecord: async () => pending, loadAgentPubkey: async () => agentPubkey }),
    );
    expect(statusOf(results, "identity")).toBe("ok");
    expect(statusOf(results, "attestation")).toBe("fail");
    expect(detailOf(results, "attestation")).toMatch(/provision import/);
  });

  it("fails an attestation whose conditions block published kinds", async () => {
    const agentPubkey = getPublicKey(generateSecretKey());
    const auth = signAttestation(ownerSecret, agentPubkey, "kind=9");
    const results = await runDoctor(
      config(),
      fakeFacade({
        readRecord: async () => provisionedRecord(agentPubkey, auth),
        loadAgentPubkey: async () => agentPubkey,
      }),
    );
    expect(statusOf(results, "attestation")).toBe("ok");
    expect(statusOf(results, "attestation-conditions")).toBe("fail");
    expect(detailOf(results, "attestation-conditions")).toMatch(/24200/);
  });

  it("fails a forged attestation that names an owner it was not signed by", async () => {
    const agentPubkey = getPublicKey(generateSecretKey());
    const auth = signAttestation(ownerSecret, agentPubkey, "");
    const forged = { ...auth, ownerPubkey: getPublicKey(generateSecretKey()) };
    const record = provisionedRecord(agentPubkey, forged);
    const results = await runDoctor(
      config(),
      fakeFacade({
        readRecord: async () => record,
        loadAgentPubkey: async () => agentPubkey,
      }),
    );
    expect(statusOf(results, "attestation")).toBe("fail");
  });
});

describe("environment checks", () => {
  it("flags an invalid config and an unparseable relay URL", async () => {
    const results = await runDoctor(
      config({ relayUrl: "http://relay.example" }),
      fakeFacade(),
    );
    expect(statusOf(results, "config")).toBe("fail");
    expect(statusOf(results, "relay-url")).toBe("fail");
  });

  it("warns about an unencrypted non-local relay", async () => {
    const results = await runDoctor(config({ relayUrl: "ws://relay.example" }), fakeFacade());
    expect(statusOf(results, "relay-url")).toBe("warn");
    expect(statusOf(results, "config")).toBe("ok");
  });

  it("fails when the Pi SDK or its credentials are missing", async () => {
    const results = await runDoctor(
      config(),
      fakeFacade({
        probePiSdk: async () => ({ ok: false, detail: "cannot import" }),
        probePiAuth: async () => ({ ok: false, detail: "no auth.json" }),
      }),
    );
    expect(statusOf(results, "pi-sdk")).toBe("fail");
    expect(statusOf(results, "pi-auth")).toBe("fail");
  });

  it("probes the real Pi SDK and agent directory", async () => {
    const facade = createDoctorFacade({ store, agentDir: join(workDir, "no-such-agent-dir") });
    expect((await facade.probePiSdk()).ok).toBe(true);
    expect((await facade.probePiAuth()).ok).toBe(false);
  });
});

describe("report", () => {
  it("keeps every check independent when one throws", async () => {
    const results = await runDoctor(
      config(),
      fakeFacade({
        readRecord: async () => {
          throw new Error("identity.json is corrupt");
        },
      }),
    );
    expect(results).toHaveLength(9);
    expect(statusOf(results, "identity")).toBe("fail");
    expect(detailOf(results, "identity")).toMatch(/corrupt/);
    expect(statusOf(results, "pi-sdk")).toBe("ok");
  });

  it("renders one line per check and exits zero when only warnings remain", async () => {
    const results = await runDoctor(config({ relayUrl: "ws://relay.example" }), fakeFacade())
      .then((all) => all.filter((r) => r.status !== "fail"));
    expect(formatDoctorReport(results).split("\n")).toHaveLength(results.length);
    expect(doctorExitCode(results)).toBe(0);
  });
});
