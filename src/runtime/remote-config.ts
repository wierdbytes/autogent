/**
 * Core-engram configuration (remote plan §3.3).
 *
 * The `core` engram carries the owner-side effective config as a versioned
 * JSON document, embedded in the NIP-AE core body's `profile` field. It is a
 * derived artifact: Desktop/CLI recompute and republish it on every deploy and
 * agent-record change, so the runtime treats the head as authoritative and the
 * env-derived config as a base layer for local development only.
 */

import type { AgentConfig, RespondToMode } from "../config.js";

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
  /** 0 is a legal "run indefinitely". */
  inactivity_exit_sec?: number;
}

const RESPOND_TO: ReadonlySet<string> = new Set(["owner-only", "allowlist", "anyone", "nobody"]);
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
 * Parses the config JSON found in the core engram's `profile` field.
 *
 * Strict on the envelope (`v: 1` or reject — an unknown version may carry
 * semantics we would silently misapply), tolerant on unknown extra keys so a
 * newer owner-side writer does not brick an older agent.
 */
export function parseCoreConfig(profile: string): ParsedCoreConfig {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(profile);
  } catch {
    return { config: null, problems: ["core config is not valid JSON"] };
  }
  const object = asObject(raw);
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
 * The engram head wins wherever it says something; base values survive where
 * it is silent (plan §3.3, precedence: engram > env).
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
  if (core.inactivity_exit_sec !== undefined) next.lifecycle.inactivityExitSec = core.inactivity_exit_sec;
  return next;
}

/** Serialises an effective config into the core-engram `profile` payload. */
export function serializeCoreConfig(config: CoreConfigV1): string {
  return JSON.stringify(config);
}
