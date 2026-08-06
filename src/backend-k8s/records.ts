/**
 * Config-record publication during `deploy` (remote plan §4.3 step 3).
 *
 * The provider holds the nsec by design (that is its job in the provider
 * protocol), so it can sign as the agent: the `autogent/config` record is
 * derived from the deploy profile's agent settings, and `autogent/auth`
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
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from "../registry/profiles.js";
import { RecordClient } from "../nostr/record-client.js";
import { createEventBuilder } from "../nostr/event-builder.js";
import { CONFIG_SLUG, AUTH_SLUG, LANGFUSE_SLUG } from "../nostr/config-records.js";
import { RelaySupervisor } from "../nostr/relay-supervisor.js";
import { createSigner } from "../nostr/signer.js";
import { fail } from "../backend/wire.js";
import {
  authValueFromContent,
  type LangfuseCredentials,
} from "../runtime/provider-auth.js";
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

/**
 * Derives the core-record config from the deploy profile's agent settings.
 * The registry profile is the *primary source*: whatever the Desktop payload
 * or its launch env carries for model, respond gate, tools, scheduler and
 * extensions is deliberately ignored — the GUI's remaining surface is picking
 * the profile, and one source cannot drift.
 *
 * The one exception is the system prompt: when the profile is silent on it,
 * the Desktop record's `system_prompt` (the GUI's "Agent instructions"
 * field) is used instead of being dropped, so a GUI-authored prompt is not
 * silently lost on a profile that never set one. A profile prompt still wins
 * outright — no concatenation — so a profile that *does* speak stays the
 * single source.
 */
export function buildCoreConfig(
  settings: AgentSettings,
  inactivitySeconds: number,
  extensions: string[] = [],
  fallbackSystemPrompt: string | null = null,
): CoreConfigV1 {
  const config: CoreConfigV1 = { v: 1 };

  if (settings.model !== null) config.model = settings.model;
  if (settings.thinking !== null) config.thinking = settings.thinking;
  const systemPrompt = settings.systemPrompt ?? fallbackSystemPrompt;
  if (systemPrompt !== null) config.system_prompt = systemPrompt;

  config.respond_to = settings.respondTo;
  if (settings.respondToAllowlist.length > 0) {
    config.respond_to_allowlist = settings.respondToAllowlist;
  }

  if (settings.toolsInclude.length > 0 || settings.toolsExclude.length > 0) {
    config.tools = {
      ...(settings.toolsInclude.length > 0 ? { include: settings.toolsInclude } : {}),
      ...(settings.toolsExclude.length > 0 ? { exclude: settings.toolsExclude } : {}),
    };
  }

  if (extensions.length > 0) config.extensions = extensions;

  if (settings.maxConcurrentTurns !== null || settings.contextMessageLimit !== null) {
    config.scheduler = {
      ...(settings.maxConcurrentTurns !== null
        ? { max_concurrent_turns: settings.maxConcurrentTurns }
        : {}),
      ...(settings.contextMessageLimit !== null
        ? { context_message_limit: settings.contextMessageLimit }
        : {}),
    };
  }

  // Tracing is emitted only when the profile turned it on. A disabled profile
  // emits no `langfuse` block at all: absence means "runtime defaults", and the
  // runtime default is disabled — so the two agree, and the record stays as
  // small as the profile's intent.
  if (settings.langfuseEnabled) {
    config.langfuse = {
      enabled: true,
      ...(settings.langfuseHost !== null ? { host: settings.langfuseHost } : {}),
      ...(settings.langfusePrivacy !== null ? { privacy: settings.langfusePrivacy } : {}),
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
  /** Agent settings from the deploy profile — the record's primary source. */
  settings?: AgentSettings;
  inactivitySeconds: number;
  /** Pi extension sources from the deploy profile. */
  extensions?: string[];
  /** Raw auth.json bytes from the owner-side store. */
  providerAuthJson: string;
  /** Langfuse API keys from the profile; absent = leave any existing head alone. */
  langfuseKeys?: LangfuseCredentials | null;
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

    const core = buildCoreConfig(
      input.settings ?? DEFAULT_AGENT_SETTINGS,
      input.inactivitySeconds,
      input.extensions ?? [],
      payload.systemPrompt,
    );
    await records.publish(CONFIG_SLUG, { slug: CONFIG_SLUG, value: core });
    await records.publish(AUTH_SLUG, {
      slug: AUTH_SLUG,
      value: authValue,
    });

    // Langfuse keys are published only when the profile has them locally.
    // Absence is *not* a revocation: the head may have been written by
    // `autogent-nostr langfuse set` on another machine, and a deploy must never
    // tombstone a credential it simply does not know about.
    if (input.langfuseKeys) {
      await records.publish(LANGFUSE_SLUG, {
        slug: LANGFUSE_SLUG,
        value: {
          public_key: input.langfuseKeys.publicKey,
          secret_key: input.langfuseKeys.secretKey,
        },
      });
    }
  } catch (error) {
    fail(
      `failed to publish deploy records to ${payload.relayUrl}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await relay.close();
  }
}
