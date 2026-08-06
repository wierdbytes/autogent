/**
 * Langfuse credentials over the `autogent/langfuse` record (tracing plan §5.2):
 * boot from the head, revocation by tombstone, late arrival of the keys, and
 * the `enabled` flip in the core record — all hot, none of them degrading.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { defaultConfig, type AgentConfig } from "../src/config.js";
import { RecordClient } from "../src/nostr/record-client.js";
import { CONFIG_SLUG, LANGFUSE_SLUG, deriveRecordDTag } from "../src/nostr/config-records.js";
import { signAttestation } from "../src/nostr/nip-oa.js";
import { createSigner, type Signer } from "../src/nostr/signer.js";
import { KIND, type NostrEvent } from "../src/nostr/types.js";
import { AppRuntime } from "../src/runtime/app-runtime.js";
import { systemClock } from "../src/runtime/clock.js";
import type { LangfuseCredentials } from "../src/runtime/provider-auth.js";
import type { Logger } from "../src/runtime/ports.js";
import { openInMemoryDatabase } from "../src/state/database.js";
import { FakeRelayPort } from "./helpers/fake-relay-port.js";
import { FakeSession } from "./helpers/fakes.js";

const KEYS = { public_key: "pk-lf-test", secret_key: "sk-lf-test" };

/**
 * A local, non-routable host: the publisher builds a real exporter, and no test
 * may ever be one DNS lookup away from talking to Langfuse cloud.
 */
const HOST = "http://127.0.0.1:1";

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
      rotate: async () => session,
      disposeAll: async () => {},
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

  afterEach(async () => {
    await harness.runtime.stop("test");
    rmSync(harness.stateDir, { recursive: true, force: true });
  });

  it("traces with credentials taken from the boot head", async () => {
    harness = await bootRemote({
      langfuseEnabled: true,
      credentials: { publicKey: KEYS.public_key, secretKey: KEYS.secret_key },
    });
    expect(harness.runtime.tracingKind).toBe("langfuse");
    expect(harness.runtime.degraded).toBe(false);
  });

  it("stays no-op and non-degraded with no head, warning once", async () => {
    harness = await bootRemote({ langfuseEnabled: true, credentials: null });
    expect(harness.runtime.tracingKind).toBe("noop");
    expect(harness.runtime.degraded).toBe(false);
    const warnings = harness.lines.filter(
      (line) => line.level === "warn" && line.message.includes("credentials missing"),
    );
    expect(warnings).toHaveLength(1);
  });

  it("disables tracing when the owner tombstones the keys", async () => {
    harness = await bootRemote({
      langfuseEnabled: true,
      credentials: { publicKey: KEYS.public_key, secretKey: KEYS.secret_key },
    });
    expect(harness.runtime.tracingKind).toBe("langfuse");

    harness.relay.deliver(
      harness.recordEvent(LANGFUSE_SLUG, { slug: LANGFUSE_SLUG, value: null }, 1_800_000_000),
    );
    await waitFor(() => harness.runtime.tracingKind === "noop");
    expect(harness.runtime.degraded).toBe(false);
  });

  it("enables tracing when the keys arrive after boot", async () => {
    harness = await bootRemote({ langfuseEnabled: true, credentials: null });
    expect(harness.runtime.tracingKind).toBe("noop");

    harness.relay.deliver(
      harness.recordEvent(LANGFUSE_SLUG, { slug: LANGFUSE_SLUG, value: KEYS }, 1_800_000_000),
    );
    await waitFor(() => harness.runtime.tracingKind === "langfuse");
  });

  it("follows the enabled flag in the core record, reusing stored keys", async () => {
    harness = await bootRemote({
      langfuseEnabled: true,
      credentials: { publicKey: KEYS.public_key, secretKey: KEYS.secret_key },
    });
    expect(harness.runtime.tracingKind).toBe("langfuse");

    harness.relay.deliver(
      harness.recordEvent(
        CONFIG_SLUG,
        { slug: CONFIG_SLUG, value: coreConfigValue(false) },
        1_800_000_000,
      ),
    );
    await waitFor(() => harness.runtime.tracingKind === "noop");

    harness.relay.deliver(
      harness.recordEvent(
        CONFIG_SLUG,
        { slug: CONFIG_SLUG, value: coreConfigValue(true) },
        1_800_000_001,
      ),
    );
    await waitFor(() => harness.runtime.tracingKind === "langfuse");
  });
});
