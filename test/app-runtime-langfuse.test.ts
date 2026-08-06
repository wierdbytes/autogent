/**
 * Langfuse via the pi-langfuse extension: credentials over the
 * `autogent/langfuse` record — boot from the head, revocation by tombstone,
 * late arrival of the keys, and the `enabled` flip in the core record — all
 * hot, none of them degrading. The runtime's contract is the extension's env
 * surface (`LANGFUSE_*`) plus the session extension list; tracing itself is
 * the extension's job.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { defaultConfig, type AgentConfig } from "../src/config.js";
import { RecordClient } from "../src/nostr/record-client.js";
import { CONFIG_SLUG, LANGFUSE_SLUG, deriveRecordDTag } from "../src/nostr/config-records.js";
import { signAttestation } from "../src/nostr/nip-oa.js";
import { createSigner } from "../src/nostr/signer.js";
import { KIND, type NostrEvent } from "../src/nostr/types.js";
import { AppRuntime } from "../src/runtime/app-runtime.js";
import { systemClock } from "../src/runtime/clock.js";
import { LANGFUSE_EXTENSION_SOURCE } from "../src/runtime/langfuse-extension.js";
import type { LangfuseCredentials } from "../src/runtime/provider-auth.js";
import type { Logger } from "../src/runtime/ports.js";
import { openInMemoryDatabase } from "../src/state/database.js";
import { FakeRelayPort } from "./helpers/fake-relay-port.js";
import { FakeSession } from "./helpers/fakes.js";

const KEYS = { public_key: "pk-lf-test", secret_key: "sk-lf-test" };
const HOST = "http://127.0.0.1:1";

const LANGFUSE_ENV_KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PRIVACY_PRESET",
] as const;

/** The shape `SessionRegistryPort.applyConfig` receives. */
interface SessionConfigUpdate {
  model?: string;
  thinkingLevel?: string;
  appendSystemPrompt?: string;
  tools?: string[];
  excludeTools?: string[];
  extensions?: string[];
}

async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface LogLine {
  level: string;
  message: string;
}

function recordingLogger(lines: LogLine[]): Logger {
  const logger: Logger = {
    error: (message) => void lines.push({ level: "error", message }),
    warn: (message) => void lines.push({ level: "warn", message }),
    info: (message) => void lines.push({ level: "info", message }),
    debug: (message) => void lines.push({ level: "debug", message }),
    child: () => logger,
  };
  return logger;
}

interface Harness {
  runtime: AppRuntime;
  relay: FakeRelayPort;
  stateDir: string;
  lines: LogLine[];
  /** `applyConfig` updates the runtime pushed into the session registry. */
  configUpdates: SessionConfigUpdate[];
  recordEvent(slug: string, body: unknown, createdAt: number): NostrEvent;
}

async function bootRemote(options: {
  langfuseEnabled: boolean;
  credentials?: LangfuseCredentials | null;
}): Promise<Harness> {
  const agentSecret = generateSecretKey();
  const signer = createSigner(new Uint8Array(agentSecret));
  const ownerSecret = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerSecret);
  const authTag = signAttestation(ownerSecret, signer.publicKey, "");
  const stateDir = mkdtempSync(join(tmpdir(), "autogent-langfuse-"));

  const relay = new FakeRelayPort();
  relay.queryResponders.push(() => []);

  const state = openInMemoryDatabase();
  const session = new FakeSession("session-langfuse");
  const records = new RecordClient({ relay, signer, clock: systemClock });
  const lines: LogLine[] = [];
  const configUpdates: SessionConfigUpdate[] = [];

  const base = defaultConfig();
  const baseConfig: AgentConfig = {
    ...base,
    relayId: "test",
    stateDir,
    presence: { enabled: false, heartbeatSec: 3600 },
    remote: { recordConfig: true },
    telemetry: {
      ...base.telemetry,
      langfuse: { ...base.telemetry.langfuse, enabled: options.langfuseEnabled, host: HOST },
    },
  };

  const runtime = new AppRuntime({
    config: baseConfig,
    signer,
    ownerPubkey,
    authTag,
    logger: recordingLogger(lines),
    clock: systemClock,
    relay,
    state,
    sessions: {
      acquire: async () => session,
      release: async () => {},
      releaseForChannel: async () => {},
      disposeAll: async () => {},
      applyConfig: async (update: SessionConfigUpdate) => {
        configUpdates.push(update);
      },
    },
    remote: {
      records,
      baseConfig,
      missing: { core: false, providerAuth: false },
      coreHeadCreatedAt: 0,
      authHeadCreatedAt: 0,
      langfuseCredentials: options.credentials ?? null,
      langfuseHeadCreatedAt: 0,
    },
  });

  await runtime.start();
  await settle();

  return {
    runtime,
    relay,
    stateDir,
    lines,
    configUpdates,
    recordEvent(slug, body, createdAt) {
      return finalizeEvent(
        {
          kind: KIND.APP_DATA,
          created_at: createdAt,
          tags: [["d", deriveRecordDTag(signer, slug)]],
          content: signer.encrypt(signer.publicKey, JSON.stringify(body)),
        },
        agentSecret,
      ) as NostrEvent;
    },
  };
}

/** The core-record shape `parseCoreConfig` expects for the langfuse block. */
function coreConfigValue(enabled: boolean): unknown {
  return { v: 1, langfuse: { enabled, host: HOST } };
}

describe("langfuse credentials record", () => {
  let harness: Harness;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // The runtime writes the extension's env surface; ambient LANGFUSE_* keys
    // (a developer's own) must neither leak in nor be destroyed.
    savedEnv = Object.fromEntries(LANGFUSE_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of LANGFUSE_ENV_KEYS) delete process.env[key];
  });

  afterEach(async () => {
    await harness.runtime.stop("test");
    rmSync(harness.stateDir, { recursive: true, force: true });
    for (const key of LANGFUSE_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("materialises the extension env from the boot head", async () => {
    harness = await bootRemote({
      langfuseEnabled: true,
      credentials: { publicKey: KEYS.public_key, secretKey: KEYS.secret_key },
    });
    expect(harness.runtime.langfuseActive).toBe(true);
    expect(process.env["LANGFUSE_PUBLIC_KEY"]).toBe(KEYS.public_key);
    expect(process.env["LANGFUSE_SECRET_KEY"]).toBe(KEYS.secret_key);
    expect(process.env["LANGFUSE_BASE_URL"]).toBe(HOST);
    expect(process.env["LANGFUSE_PRIVACY_PRESET"]).toBe("conversations");
    expect(harness.runtime.degraded).toBe(false);
  });

  it("stays inactive and non-degraded with no head, warning once", async () => {
    harness = await bootRemote({ langfuseEnabled: true, credentials: null });
    expect(harness.runtime.langfuseActive).toBe(false);
    expect(process.env["LANGFUSE_PUBLIC_KEY"]).toBeUndefined();
    expect(harness.runtime.degraded).toBe(false);
    const warnings = harness.lines.filter(
      (line) => line.level === "warn" && line.message.includes("credentials missing"),
    );
    expect(warnings).toHaveLength(1);
  });

  it("clears the env and rotates sessions when the owner tombstones the keys", async () => {
    harness = await bootRemote({
      langfuseEnabled: true,
      credentials: { publicKey: KEYS.public_key, secretKey: KEYS.secret_key },
    });
    expect(harness.runtime.langfuseActive).toBe(true);

    harness.relay.deliver(
      harness.recordEvent(LANGFUSE_SLUG, { slug: LANGFUSE_SLUG, value: null }, 1_800_000_000),
    );
    await waitFor(() => !harness.runtime.langfuseActive);
    expect(process.env["LANGFUSE_PUBLIC_KEY"]).toBeUndefined();
    expect(process.env["LANGFUSE_SECRET_KEY"]).toBeUndefined();
    expect(harness.runtime.degraded).toBe(false);
    // Idle sessions were rotated so the revocation binds to the next turn.
    expect(harness.configUpdates.length).toBeGreaterThan(0);
  });

  it("activates when the keys arrive after boot", async () => {
    harness = await bootRemote({ langfuseEnabled: true, credentials: null });
    expect(harness.runtime.langfuseActive).toBe(false);

    harness.relay.deliver(
      harness.recordEvent(LANGFUSE_SLUG, { slug: LANGFUSE_SLUG, value: KEYS }, 1_800_000_000),
    );
    await waitFor(() => harness.runtime.langfuseActive);
    expect(process.env["LANGFUSE_PUBLIC_KEY"]).toBe(KEYS.public_key);
  });

  it("follows the enabled flag in the core record, reusing stored keys", async () => {
    harness = await bootRemote({
      langfuseEnabled: true,
      credentials: { publicKey: KEYS.public_key, secretKey: KEYS.secret_key },
    });
    expect(harness.runtime.langfuseActive).toBe(true);

    harness.relay.deliver(
      harness.recordEvent(
        CONFIG_SLUG,
        { slug: CONFIG_SLUG, value: coreConfigValue(false) },
        1_800_000_000,
      ),
    );
    await waitFor(() => !harness.runtime.langfuseActive);
    // The core-record push strips the extension from new sessions.
    const disabledUpdate = harness.configUpdates.at(-1);
    expect(disabledUpdate?.extensions ?? []).not.toContain(LANGFUSE_EXTENSION_SOURCE);

    harness.relay.deliver(
      harness.recordEvent(
        CONFIG_SLUG,
        { slug: CONFIG_SLUG, value: coreConfigValue(true) },
        1_800_000_001,
      ),
    );
    await waitFor(() => harness.runtime.langfuseActive);
    const enabledUpdate = harness.configUpdates.at(-1);
    expect(enabledUpdate?.extensions).toContain(LANGFUSE_EXTENSION_SOURCE);
  });
});
