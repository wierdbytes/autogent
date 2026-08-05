/**
 * Config-record publication during `deploy` (remote plan §4.3 step 3).
 *
 * The provider holds the nsec by design (that is its job in the provider
 * protocol), so it can sign as the agent: the `autogent/config` record is
 * derived from the deploy payload's effective config, and `autogent/auth`
 * ships the credential file that `autogent auth login` produced. Both are on
 * the relay
 * *before* any k8s object exists, so a Pod never starts into a world where
 * its config could not have arrived yet.
 *
 * The records are kind 30078, self-encrypted to the agent key and published
 * without the NIP-OA auth tag; the builder below exists only for the NIP-42
 * connection handshake, which the relay does gate on the attestation.
 */

import type { DeployPayload } from "../backend/payload.js";
import { RecordClient } from "../nostr/record-client.js";
import { createEventBuilder } from "../nostr/event-builder.js";
import { CONFIG_SLUG, AUTH_SLUG } from "../nostr/config-records.js";
import { RelaySupervisor } from "../nostr/relay-supervisor.js";
import { createSigner } from "../nostr/signer.js";
import { fail } from "../backend/wire.js";
import { authValueFromContent } from "../runtime/provider-auth.js";
import { systemClock } from "../runtime/clock.js";
import { nullLogger } from "../runtime/logger.js";
import type { CoreConfigV1 } from "../runtime/remote-config.js";

/** Non-secret env the Pod receives directly instead of via the record. */
export const POD_ENV_PASSTHROUGH: readonly string[] = [
  "AUTOGENT_RELAY_ID",
  "AUTOGENT_TELEMETRY",
  "AUTOGENT_METRICS",
  "AUTOGENT_LOG_LEVEL",
  "AUTOGENT_PROFILE_NAME",
  "AUTOGENT_PROFILE_ABOUT",
  "AUTOGENT_SUBSCRIBE",
];

function effectiveEnv(payload: DeployPayload): Record<string, string> {
  // Tier order mirrors the local provider: policy defaults under user env.
  if (payload.launch) return { ...payload.launch.policyEnv, ...payload.launch.env };
  return { ...payload.envVars };
}

function numberOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function listOf(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length > 0 ? items : undefined;
}

/**
 * Derives the core-record config from the payload (`launch.env` never reaches
 * the Pod — this projection is how the desktop's effective config travels).
 */
export function buildCoreConfig(
  payload: DeployPayload,
  inactivitySeconds: number,
  profileExtensions: string[] = [],
): CoreConfigV1 {
  const env = effectiveEnv(payload);
  const config: CoreConfigV1 = { v: 1 };

  const model = env["AUTOGENT_MODEL"] ?? env["BUZZ_ACP_MODEL"] ?? payload.model ?? undefined;
  if (model) config.model = model;
  const thinking = env["AUTOGENT_THINKING"];
  if (thinking) config.thinking = thinking;
  const systemPrompt = payload.systemPrompt ?? env["AUTOGENT_SYSTEM_PROMPT"] ?? undefined;
  if (systemPrompt) config.system_prompt = systemPrompt;

  config.respond_to = payload.respondTo;
  if (payload.respondToAllowlist.length > 0) {
    config.respond_to_allowlist = payload.respondToAllowlist;
  }

  const include = listOf(env["AUTOGENT_TOOLS"]);
  const exclude = listOf(env["AUTOGENT_EXCLUDE_TOOLS"]);
  if (include || exclude) {
    config.tools = { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
  }

  // Per-agent env from the Desktop wins over the registry profile, mirroring
  // the model/tools tiers above.
  const extensions =
    listOf(env["AUTOGENT_EXTENSIONS"]) ??
    (profileExtensions.length > 0 ? profileExtensions : undefined);
  if (extensions) config.extensions = extensions;

  const maxConcurrent = numberOf(env["AUTOGENT_MAX_CONCURRENT_TURNS"] ?? env["BUZZ_ACP_AGENTS"]);
  const contextLimit = numberOf(env["AUTOGENT_CONTEXT_MESSAGE_LIMIT"]);
  if (maxConcurrent !== undefined || contextLimit !== undefined) {
    config.scheduler = {
      ...(maxConcurrent !== undefined && maxConcurrent >= 1
        ? { max_concurrent_turns: Math.floor(maxConcurrent) }
        : {}),
      ...(contextLimit !== undefined ? { context_message_limit: Math.floor(contextLimit) } : {}),
    };
  }

  config.inactivity_exit_sec = inactivitySeconds;
  return config;
}

/** The Pod env derived from the payload's non-secret passthrough keys. */
export function buildPodEnv(payload: DeployPayload): Record<string, string> {
  const env = effectiveEnv(payload);
  const out: Record<string, string> = {};
  for (const name of POD_ENV_PASSTHROUGH) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  if (payload.name && out["AUTOGENT_PROFILE_NAME"] === undefined) {
    out["AUTOGENT_PROFILE_NAME"] = payload.name;
  }
  return out;
}

export interface PublishRecordsInput {
  payload: DeployPayload;
  inactivitySeconds: number;
  /** From the deploy profile; overridden by `AUTOGENT_EXTENSIONS` in the payload env. */
  extensions?: string[];
  /** Raw auth.json bytes from the owner-side store. */
  providerAuthJson: string;
}

/**
 * Signs and publishes both config records over an authenticated relay
 * connection. Throws (in-band `ok:false` upstream) when the relay refuses
 * either head.
 */
export async function publishDeployRecords(input: PublishRecordsInput): Promise<void> {
  const { payload } = input;
  const signer = createSigner(new Uint8Array(payload.secret));
  const builder = createEventBuilder({ signer, authTag: payload.auth, clock: systemClock });
  const relay = new RelaySupervisor({
    url: payload.relayUrl,
    builder,
    clock: systemClock,
    logger: nullLogger,
  });

  const authValue = authValueFromContent(input.providerAuthJson);
  if (authValue === null) fail("providerAuthJson is not a JSON object");

  try {
    await relay.connect();
    const records = new RecordClient({ relay, signer, clock: systemClock });

    const core = buildCoreConfig(payload, input.inactivitySeconds, input.extensions ?? []);
    await records.publish(CONFIG_SLUG, { slug: CONFIG_SLUG, value: core });
    await records.publish(AUTH_SLUG, {
      slug: AUTH_SLUG,
      value: authValue,
    });
  } catch (error) {
    fail(
      `failed to publish deploy records to ${payload.relayUrl}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await relay.close();
  }
}
