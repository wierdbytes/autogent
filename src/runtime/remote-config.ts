/**
 * Core-record configuration (remote plan §3.3).
 *
 * The `autogent/config` record carries the owner-side effective config as a
 * versioned JSON document, stored as-is in the record body's `value` field.
 * It is a derived artifact: Desktop/CLI recompute and republish it on every and
 * agent-record change, so the runtime treats the head as authoritative and the
 * env-derived config as a base layer for local development only.
 */

import type { AgentConfig, LangfusePrivacyPreset, RespondToMode } from "../config.js";

export interface CoreConfigV1 {
  v: 1;
  model?: string;
  thinking?: string;
  system_prompt?: string;
  respond_to?: RespondToMode;
  respond_to_allowlist?: string[];
  tools?: { include?: string[]; exclude?: string[] };
  /** Pi extension sources (paths or `npm:`/`git:` specifiers), replacing the base list. */
  extensions?: string[];
  scheduler?: { max_concurrent_turns?: number; context_message_limit?: number };
  /** buzz CLI broker feature flag and subcommand denylist (buzz-cli plan §7). */
  buzz_cli?: { enabled?: boolean; deny_commands?: string[] };
  /** 0 is a legal "run indefinitely". */
  inactivity_exit_sec?: number;
  /**
   * Langfuse trace export (tracing plan §5.3). Credentials never travel here:
   * they live in the separate `autogent/langfuse` record.
   */
  langfuse?: {
    enabled?: boolean;
    host?: string;
    privacy?: LangfusePrivacyPreset;
    sample_rate?: number;
    environment?: string;
  };
}

const RESPOND_TO: ReadonlySet<string> = new Set(["owner-only", "allowlist", "anyone", "nobody"]);
const LANGFUSE_PRIVACY: ReadonlySet<string> = new Set(["metadata-only", "conversations", "full"]);
const HEX64 = /^[0-9a-f]{64}$/;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(object: Record<string, unknown>, key: string, problems: string[]): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    problems.push(`${key} must be a string`);
    return undefined;
  }
  return value;
}

function optionalStringList(
  object: Record<string, unknown>,
  key: string,
  problems: string[],
): string[] | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    problems.push(`${key} must be an array of strings`);
    return undefined;
  }
  return value as string[];
}

function optionalNonNegative(
  object: Record<string, unknown>,
  key: string,
  problems: string[],
): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    problems.push(`${key} must be a non-negative number`);
    return undefined;
  }
  return value;
}

export interface ParsedCoreConfig {
  config: CoreConfigV1 | null;
  /** Non-empty means the document was rejected; the agent stays on its prior config. */
  problems: string[];
}

/**
 * Parses the config document found in the config record's `value` field.
 *
 * Strict on the envelope (`v: 1` or reject — an unknown version may carry
 * semantics we would silently misapply), tolerant on unknown extra keys so a
 * newer owner-side writer does not brick an older agent.
 */
export function parseCoreConfig(document: unknown): ParsedCoreConfig {
  const problems: string[] = [];
  const object = asObject(document);
  if (!object) return { config: null, problems: ["core config must be a JSON object"] };
  if (object["v"] !== 1) {
    return { config: null, problems: [`unsupported core config version ${JSON.stringify(object["v"])}`] };
  }

  const config: CoreConfigV1 = { v: 1 };

  const model = optionalString(object, "model", problems);
  if (model !== undefined) config.model = model;
  const thinking = optionalString(object, "thinking", problems);
  if (thinking !== undefined) config.thinking = thinking;
  const systemPrompt = optionalString(object, "system_prompt", problems);
  if (systemPrompt !== undefined) config.system_prompt = systemPrompt;

  const respondTo = optionalString(object, "respond_to", problems);
  if (respondTo !== undefined) {
    if (RESPOND_TO.has(respondTo)) config.respond_to = respondTo as RespondToMode;
    else problems.push(`respond_to must be one of ${[...RESPOND_TO].join(", ")}`);
  }

  const allowlist = optionalStringList(object, "respond_to_allowlist", problems);
  if (allowlist !== undefined) {
    const bad = allowlist.filter((entry) => !HEX64.test(entry));
    if (bad.length > 0) problems.push(`respond_to_allowlist entries must be 64-char hex: ${bad.join(", ")}`);
    else config.respond_to_allowlist = allowlist;
  }

  const tools = asObject(object["tools"]);
  if (object["tools"] !== undefined && object["tools"] !== null) {
    if (!tools) problems.push("tools must be an object");
    else {
      const include = optionalStringList(tools, "include", problems);
      const exclude = optionalStringList(tools, "exclude", problems);
      config.tools = {
        ...(include !== undefined ? { include } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
      };
    }
  }

  const extensions = optionalStringList(object, "extensions", problems);
  if (extensions !== undefined) config.extensions = extensions;

  const scheduler = asObject(object["scheduler"]);
  if (object["scheduler"] !== undefined && object["scheduler"] !== null) {
    if (!scheduler) problems.push("scheduler must be an object");
    else {
      const maxConcurrent = optionalNonNegative(scheduler, "max_concurrent_turns", problems);
      const contextLimit = optionalNonNegative(scheduler, "context_message_limit", problems);
      if (maxConcurrent !== undefined && maxConcurrent < 1) {
        problems.push("scheduler.max_concurrent_turns must be at least 1");
      }
      config.scheduler = {
        ...(maxConcurrent !== undefined && maxConcurrent >= 1
          ? { max_concurrent_turns: Math.floor(maxConcurrent) }
          : {}),
        ...(contextLimit !== undefined ? { context_message_limit: Math.floor(contextLimit) } : {}),
      };
    }
  }

  const buzzCli = asObject(object["buzz_cli"]);
  if (object["buzz_cli"] !== undefined && object["buzz_cli"] !== null) {
    if (!buzzCli) problems.push("buzz_cli must be an object");
    else {
      const enabled = buzzCli["enabled"];
      if (enabled !== undefined && enabled !== null && typeof enabled !== "boolean") {
        problems.push("buzz_cli.enabled must be a boolean");
      }
      const denyCommands = optionalStringList(buzzCli, "deny_commands", problems);
      config.buzz_cli = {
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(denyCommands !== undefined ? { deny_commands: denyCommands } : {}),
      };
    }
  }

  const langfuse = asObject(object["langfuse"]);
  if (object["langfuse"] !== undefined && object["langfuse"] !== null) {
    if (!langfuse) problems.push("langfuse must be an object");
    else {
      const enabled = langfuse["enabled"];
      if (enabled !== undefined && enabled !== null && typeof enabled !== "boolean") {
        problems.push("langfuse.enabled must be a boolean");
      }
      const host = optionalString(langfuse, "host", problems);
      const environment = optionalString(langfuse, "environment", problems);

      const privacy = optionalString(langfuse, "privacy", problems);
      let validPrivacy: LangfusePrivacyPreset | undefined;
      if (privacy !== undefined) {
        if (LANGFUSE_PRIVACY.has(privacy)) validPrivacy = privacy as LangfusePrivacyPreset;
        else problems.push(`langfuse.privacy must be one of ${[...LANGFUSE_PRIVACY].join(", ")}`);
      }

      const sampleRaw = langfuse["sample_rate"];
      let sampleRate: number | undefined;
      if (sampleRaw !== undefined && sampleRaw !== null) {
        if (typeof sampleRaw !== "number" || !Number.isFinite(sampleRaw) || sampleRaw < 0 || sampleRaw > 1) {
          problems.push("langfuse.sample_rate must be a number between 0 and 1");
        } else sampleRate = sampleRaw;
      }

      config.langfuse = {
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(host !== undefined ? { host } : {}),
        ...(validPrivacy !== undefined ? { privacy: validPrivacy } : {}),
        ...(sampleRate !== undefined ? { sample_rate: sampleRate } : {}),
        ...(environment !== undefined ? { environment } : {}),
      };
    }
  }

  const inactivity = optionalNonNegative(object, "inactivity_exit_sec", problems);
  if (inactivity !== undefined) config.inactivity_exit_sec = Math.floor(inactivity);

  // Structural problems reject the whole document rather than applying half of
  // it: a partially-applied config is harder to reason about than a stale one.
  if (problems.length > 0) return { config: null, problems };
  return { config, problems: [] };
}

/**
 * Overlays a core config onto a base (env-derived) config.
 *
 * The record head wins wherever it says something; base values survive where
 * it is silent (plan §3.3, precedence: record > env).
 */
export function applyCoreConfig(base: AgentConfig, core: CoreConfigV1): AgentConfig {
  const next: AgentConfig = structuredClone(base);
  if (core.model !== undefined) next.pi.model = core.model;
  if (core.thinking !== undefined) next.pi.thinkingLevel = core.thinking;
  if (core.system_prompt !== undefined) next.pi.appendSystemPrompt = core.system_prompt;
  if (core.respond_to !== undefined) next.security.respondTo = core.respond_to;
  if (core.respond_to_allowlist !== undefined) next.security.allowlist = core.respond_to_allowlist;
  if (core.tools?.include !== undefined) next.pi.tools = core.tools.include;
  if (core.tools?.exclude !== undefined) next.pi.excludeTools = core.tools.exclude;
  if (core.extensions !== undefined) next.pi.extensions = core.extensions;
  if (core.scheduler?.max_concurrent_turns !== undefined) {
    next.scheduler.maxConcurrentTurns = core.scheduler.max_concurrent_turns;
  }
  if (core.scheduler?.context_message_limit !== undefined) {
    next.scheduler.contextMessageLimit = core.scheduler.context_message_limit;
  }
  if (core.buzz_cli?.enabled !== undefined) next.buzzCli.enabled = core.buzz_cli.enabled;
  if (core.buzz_cli?.deny_commands !== undefined) {
    next.buzzCli.denyCommands = core.buzz_cli.deny_commands;
  }
  if (core.inactivity_exit_sec !== undefined) next.lifecycle.inactivityExitSec = core.inactivity_exit_sec;
  const langfuse = core.langfuse;
  if (langfuse) {
    if (langfuse.enabled !== undefined) next.telemetry.langfuse.enabled = langfuse.enabled;
    if (langfuse.host !== undefined) next.telemetry.langfuse.host = langfuse.host;
    if (langfuse.privacy !== undefined) next.telemetry.langfuse.privacy = langfuse.privacy;
    if (langfuse.sample_rate !== undefined) next.telemetry.langfuse.sampleRate = langfuse.sample_rate;
    if (langfuse.environment !== undefined) next.telemetry.langfuse.environment = langfuse.environment;
  }
  return next;
}
