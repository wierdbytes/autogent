/**
 * `autogent-nostr run` — boots the service and keeps it alive.
 *
 * Secrets are read once, handed to the signer, and scrubbed from the
 * environment before anything the model can reach is constructed (plan §10.1).
 */

import { applyEnv, defaultConfig, validateConfig, type AgentConfig } from "./config.js";
import { createIdentityStore } from "./provisioning/identity-store.js";
import { scrubProcessEnv } from "./security/secret-vault.js";
import { AppRuntime } from "./runtime/app-runtime.js";
import { createLogger } from "./runtime/logger.js";

export interface RunOptions {
  config?: Partial<AgentConfig>;
}

export async function run(options: RunOptions = {}): Promise<number> {
  const config: AgentConfig = { ...applyEnv(defaultConfig()), ...options.config };
  const logger = createLogger(config.logLevel);

  const problems = validateConfig(config);
  if (problems.length > 0) {
    for (const problem of problems) logger.error("invalid configuration", { problem });
    return 2;
  }

  const store = createIdentityStore({ stateDir: config.stateDir });
  const record = await store.requireRecord();
  if (!record.ownerPubkey || !record.auth) {
    logger.error("agent is not provisioned; run `autogent-nostr provision import` first");
    return 2;
  }

  const signer = await store.loadSigner();
  const scrubbed = scrubProcessEnv();
  if (scrubbed.length > 0) logger.debug("scrubbed bootstrap secrets", { count: scrubbed.length });

  const runtime = new AppRuntime({
    config,
    signer,
    ownerPubkey: record.ownerPubkey,
    authTag: record.auth,
    logger,
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
  return 0;
}
