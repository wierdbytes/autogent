/**
 * `autogent-nostr run` — boots the service and keeps it alive.
 *
 * Secrets are read once, handed to the signer, and scrubbed from the
 * environment before anything the model can reach is constructed (plan §10.1).
 *
 * In record-configured (remote) mode the boot order is relay-first (remote
 * plan §3): the sealed identity may be materialised from the deploy Secret's
 * env triple, then the `autogent/config` and `autogent/auth` config-record
 * heads are
 * fetched over the same authenticated relay connection the runtime will keep,
 * and only then is the runtime constructed — with the record-derived effective
 * config, or degraded (prompts refused, presence "degraded") when a head is
 * missing.
 */

import { mkdirSync } from "node:fs";
import { applyEnv, defaultConfig, validateConfig, type AgentConfig } from "./config.js";
import { RecordClient } from "./nostr/record-client.js";
import { createEventBuilder } from "./nostr/event-builder.js";
import { CONFIG_SLUG, AUTH_SLUG } from "./nostr/config-records.js";
import { RelaySupervisor } from "./nostr/relay-supervisor.js";
import { bootstrapIdentityFromEnv } from "./provisioning/bootstrap.js";
import { createIdentityStore } from "./provisioning/identity-store.js";
import { scrubProcessEnv } from "./security/secret-vault.js";
import { AppRuntime, type RemoteRuntimeOptions } from "./runtime/app-runtime.js";
import { systemClock } from "./runtime/clock.js";
import { createLogger } from "./runtime/logger.js";
import type { Logger, RelayPort } from "./runtime/ports.js";
import { authContentFromValue, authValueFromContent, piAgentDir, reconcileProviderAuth, recordAuthSynced } from "./runtime/provider-auth.js";
import { applyCoreConfig, parseCoreConfig } from "./runtime/remote-config.js";
import type { Signer } from "./nostr/signer.js";
import type { AuthTag } from "./nostr/nip-oa.js";

export interface RunOptions {
  config?: Partial<AgentConfig>;
}

interface RemoteBootstrap {
  config: AgentConfig;
  relay: RelayPort;
  remote: RemoteRuntimeOptions;
}

/**
 * Relay-first bootstrap for record-configured agents (remote plan §3.2–3.3).
 *
 * Never throws on a missing head — missing is a *state* (degraded), not an
 * error — but does propagate connection failures: without the relay there is
 * neither config nor credentials, and the substrate's restart policy is the
 * right retry loop.
 */
async function bootstrapRemote(
  base: AgentConfig,
  signer: Signer,
  authTag: AuthTag,
  logger: Logger,
): Promise<RemoteBootstrap> {
  const builder = createEventBuilder({ signer, authTag, clock: systemClock });
  const relay = new RelaySupervisor({
    url: base.relayUrl,
    builder,
    clock: systemClock,
    logger: logger.child({ component: "relay" }),
  });
  await relay.connect();

  const records = new RecordClient({
    relay,
    signer,
    clock: systemClock,
    logger: logger.child({ component: "records" }),
  });

  // Pi credentials live inside the sealed state dir, not in $HOME: the tool
  // policy already denies the state dir to the model's tools.
  const baseConfig = structuredClone(base);
  baseConfig.pi.agentDir = piAgentDir(base.stateDir);

  // --- core (config) head -------------------------------------------------
  let effective = baseConfig;
  let missingCore = true;
  let coreHeadCreatedAt = 0;
  const coreHead = await records.fetchHead(CONFIG_SLUG);
  if (coreHead && coreHead.body.slug === CONFIG_SLUG) {
    const parsed = parseCoreConfig(coreHead.body.value);
    if (parsed.config) {
      const candidate = applyCoreConfig(baseConfig, parsed.config);
      const problems = validateConfig(candidate);
      if (problems.length === 0) {
        effective = candidate;
        missingCore = false;
        coreHeadCreatedAt = coreHead.createdAt;
      } else {
        // A head that parses but validates unusable is treated like a missing
        // head: degraded on the base config beats a crash loop the owner can
        // only observe as "pod restarting".
        for (const problem of problems) logger.error("core record config unusable", { problem });
      }
    } else {
      for (const problem of parsed.problems) logger.error("core record rejected", { problem });
    }
  } else {
    logger.warn("no core config record head; starting degraded");
  }

  // --- provider-auth head -------------------------------------------------
  const authHead = await records.fetchHead(AUTH_SLUG);
  const headView =
    authHead && authHead.body.slug === AUTH_SLUG
      ? { content: authContentFromValue(authHead.body.value), createdAt: authHead.createdAt }
      : null;
  const reconciled = await reconcileProviderAuth(base.stateDir, headView, logger);

  let missingAuth = false;
  let authHeadCreatedAt = authHead?.createdAt ?? 0;
  switch (reconciled.action) {
    case "missing":
      logger.warn("no provider-auth record and no local auth.json; starting degraded");
      missingAuth = true;
      break;
    case "revoked":
      logger.warn("provider-auth record is tombstoned; starting degraded");
      missingAuth = true;
      break;
    case "publish-local": {
      const value = authValueFromContent(reconciled.content);
      if (value === null) {
        logger.warn("local auth.json is not a JSON object; not publishing it");
        break;
      }
      try {
        const head = await records.publish(
          AUTH_SLUG,
          { slug: AUTH_SLUG, value },
          { createdAt: authHeadCreatedAt },
        );
        await recordAuthSynced(base.stateDir, reconciled.content, head.createdAt);
        authHeadCreatedAt = head.createdAt;
        logger.info("published local auth.json as the new provider-auth head");
      } catch (error) {
        // Local credentials still work; the write-back watcher retries later.
        logger.warn("could not publish local auth.json", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
    case "materialized":
      logger.info("provider-auth record materialised into auth.json");
      break;
    case "none":
      break;
  }

  return {
    config: effective,
    relay,
    remote: {
      records,
      baseConfig,
      missing: { core: missingCore, providerAuth: missingAuth },
      coreHeadCreatedAt,
      authHeadCreatedAt,
    },
  };
}

export async function run(options: RunOptions = {}): Promise<number> {
  let config: AgentConfig = { ...applyEnv(defaultConfig()), ...options.config };
  const logger = createLogger(config.logLevel);

  const problems = validateConfig(config);
  if (problems.length > 0) {
    for (const problem of problems) logger.error("invalid configuration", { problem });
    return 2;
  }

  // In a container the workspace lives on a freshly-provisioned PVC; creating
  // it here beats requiring an init container for one mkdir.
  try {
    mkdirSync(config.pi.cwd, { recursive: true });
  } catch {
    // A read-only or pre-existing cwd surfaces later, with a better message.
  }

  const store = createIdentityStore({ stateDir: config.stateDir });

  // Container first start: materialise the sealed identity from the deploy
  // Secret. On every later start the sealed state wins and the env is ignored.
  const bootstrap = await bootstrapIdentityFromEnv(store, {
    nsec: process.env["AUTOGENT_NSEC"],
    authTag: process.env["AUTOGENT_AUTH_TAG"],
    relayUrl: config.relayUrl,
    profileName: config.profile.name,
  });
  if (bootstrap.kind === "bootstrapped") {
    logger.info("identity bootstrapped from environment", { agentPubkey: bootstrap.agentPubkey });
  }

  const record = await store.requireRecord();
  if (!record.ownerPubkey || !record.auth) {
    logger.error("agent is not provisioned; run `autogent-nostr provision import` first");
    return 2;
  }

  const signer = await store.loadSigner();
  const scrubbed = scrubProcessEnv();
  if (scrubbed.length > 0) logger.debug("scrubbed bootstrap secrets", { count: scrubbed.length });

  let relay: RelayPort | undefined;
  let remote: RemoteRuntimeOptions | undefined;
  if (config.remote.recordConfig) {
    let bootstrapped: RemoteBootstrap;
    try {
      bootstrapped = await bootstrapRemote(config, signer, record.auth, logger);
    } catch (error) {
      logger.error("relay-first bootstrap failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 1;
    }
    config = bootstrapped.config;
    relay = bootstrapped.relay;
    remote = bootstrapped.remote;
  }

  const runtime = new AppRuntime({
    config,
    signer,
    ownerPubkey: record.ownerPubkey,
    authTag: record.auth,
    logger,
    ...(relay ? { relay } : {}),
    ...(remote ? { remote } : {}),
  });

  const shutdown = (signal: string) => {
    logger.info("shutdown signal", { signal });
    void runtime.stop(signal);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await runtime.start();
  } catch (error) {
    logger.error("startup failed", { error });
    await runtime.stop("startup_failed");
    return 1;
  }

  await runtime.finished;
  // I5, exit-code contract: intentional termination (owner `!shutdown`,
  // inactivity ceiling, a signal) exits 0 so a supervisor with `OnFailure`
  // does not resurrect it; a terminal relay failure is a crash and exits 1.
  return runtime.stopReason === "relay_terminal" ? 1 : 0;
}
