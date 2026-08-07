/**
 * Runtime configuration for `autogent-nostr`.
 *
 * Precedence: CLI flag > environment variable > config file > default.
 *
 * Secrets are deliberately absent from this structure. The agent secret key is
 * loaded by the identity store into the signer and never lands in a config
 * object, a log line, or `process.env` (plan §10.1).
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Who the agent is willing to answer (plan §10.4). */
export type RespondToMode = "owner-only" | "allowlist" | "anyone" | "nobody";

/** Which channel events reach the agent at all. */
export type SubscribeMode = "mentions" | "all";

/** What to do with an assistant message too large for one chat event. */
export type OversizeOutputPolicy = "split" | "truncate" | "reject";

/**
 * How much of a turn reaches Langfuse.
 *
 * These are the pi-langfuse extension's capture presets, passed through as
 * `LANGFUSE_PRIVACY_PRESET`: `metadata-only` — shapes and counters, no user
 * text; `prompts-only` — inputs plus metadata; `conversations` — prompts and
 * completions but no tool payloads; `full-debug` — everything, redaction aside.
 */
export type LangfusePrivacyPreset =
  | "metadata-only"
  | "prompts-only"
  | "conversations"
  | "full-debug";

/**
 * Accepts a preset name, tolerating the legacy `full` spelling from configs
 * written before tracing moved to the pi-langfuse extension.
 */
export function normalizeLangfusePrivacy(value: unknown): LangfusePrivacyPreset | null {
  if (typeof value !== "string") return null;
  if (value === "full") return "full-debug";
  return (LANGFUSE_PRIVACY_PRESETS as readonly string[]).includes(value)
    ? (value as LangfusePrivacyPreset)
    : null;
}

export interface PiConfig {
  /** Working directory for the agent's tools. Also the session bucket key. */
  cwd: string;
  /** `~/.pi/agent` unless overridden. */
  agentDir?: string;
  /** Provider-qualified model id, e.g. `anthropic/claude-sonnet-4-5`. */
  model?: string;
  thinkingLevel?: string;
  /** Tool allowlist. When set, only these tools exist. */
  tools?: string[];
  /** Tool denylist, applied on top of the default tool set. */
  excludeTools?: string[];
  /** Extra system prompt appended to Pi's own. */
  appendSystemPrompt?: string;
  /**
   * Extension sources loaded into every session, on top of whatever the
   * agentDir settings already provide. Accepts paths and `npm:`/`git:`
   * specifiers (resolved by Pi's package manager).
   */
  extensions?: string[];
}

export interface SecurityConfig {
  respondTo: RespondToMode;
  /** Extra pubkeys allowed when `respondTo === "allowlist"`. */
  allowlist: string[];
  /** Sibling agents (same owner) that may talk to this agent. */
  siblingAgents: string[];
  /** Absolute paths the agent's tools may read. Empty means "cwd only". */
  readRoots: string[];
  /** Absolute paths the agent's tools may write. Empty means "cwd only". */
  writeRoots: string[];
  /** Substrings that disqualify a bash command outright. */
  commandDenylist: string[];
}

export interface SchedulerConfig {
  /** Max channels running a turn at the same time. */
  maxConcurrentTurns: number;
  /** Seconds of Pi silence before a turn is aborted. */
  idleTimeoutSec: number;
  /** Hard wall-clock ceiling for one turn, in seconds. */
  maxTurnDurationSec: number;
  /** How many prior channel messages to fetch as context. 0 disables. */
  contextMessageLimit: number;
}

/**
 * Langfuse tracing via the pi-langfuse extension.
 *
 * When enabled, the runtime loads the pi-langfuse Pi extension (currently
 * our fork, see `LANGFUSE_EXTENSION_SOURCE`) into
 * every session and passes host/privacy through its environment surface.
 * Credentials are deliberately absent: `publicKey`/`secretKey` are resolved
 * separately (runtime/provider-auth.ts) so they never land in a config object
 * or a log line, matching the no-secrets invariant of this module.
 */
export interface LangfuseConfig {
  enabled: boolean;
  /** Ingestion host — cloud or self-hosted (`LANGFUSE_BASE_URL`). */
  host: string;
  /** Capture preset (`LANGFUSE_PRIVACY_PRESET`). */
  privacy: LangfusePrivacyPreset;
}

export interface TelemetryConfig {
  /** Publish NIP-AO kind 24200 frames to the owner. */
  enabled: boolean;
  /** Window for coalescing text/thinking deltas into one frame. */
  coalesceMs: number;
  /** Publish NIP-AM kind 44200 usage metrics. */
  metricsEnabled: boolean;
  langfuse: LangfuseConfig;
}

export interface OutputConfig {
  /** Largest chat message body we will publish, in bytes. */
  maxMessageBytes: number;
  oversizePolicy: OversizeOutputPolicy;
}

export interface LifecycleConfig {
  /**
   * Self-terminate after this many seconds with no dispatched events and no
   * turns in flight (remote plan §6.2.5). 0 — the legal "run indefinitely".
   */
  inactivityExitSec: number;
  /**
   * Hard ceiling for the whole post-signal shutdown path, in seconds. Must fit
   * inside the substrate's grace budget (k8s: terminationGracePeriodSeconds).
   */
  shutdownBudgetSec: number;
}

export interface BuzzCliConfig {
  /** Serve `buzz` CLI requests from the model's bash through the broker. */
  enabled: boolean;
  /** Subcommand prefixes refused by the broker, e.g. `"agents"` or `"messages delete"`. */
  denyCommands: string[];
}

export interface RemoteConfig {
  /**
   * When true the agent is record-configured (remote plan §3.3): the
   * `autogent/config` config-record head (kind 30078) overrides env,
   * `autogent/auth` is
   * materialised into a pi `auth.json`, and a missing head is fail-closed
   * degraded rather than "start empty". Set by the k8s provider; off for
   * local development.
   */
  recordConfig: boolean;
}

export interface AgentConfig {
  relayUrl: string;
  /** Stable local identifier for the relay, used in conversation keys. */
  relayId: string;
  /** State directory, mode 0700. Holds the sealed identity and the database. */
  stateDir: string;
  subscribe: SubscribeMode;
  /** When set, restrict to these channel ids. Empty means "all memberships". */
  channels: string[];
  presence: { enabled: boolean; heartbeatSec: number };
  profile: { name: string; about: string; picture?: string };
  pi: PiConfig;
  security: SecurityConfig;
  scheduler: SchedulerConfig;
  telemetry: TelemetryConfig;
  output: OutputConfig;
  buzzCli: BuzzCliConfig;
  lifecycle: LifecycleConfig;
  remote: RemoteConfig;
  logLevel: "error" | "warn" | "info" | "debug";
}

export function defaultStateDir(): string {
  return process.env.AUTOGENT_STATE_DIR ?? join(homedir(), ".autogent-nostr");
}

/**
 * Config with every optional decision resolved to the plan's default posture:
 * owner-only, mentions-only, fail-closed.
 */
export function defaultConfig(): AgentConfig {
  return {
    relayUrl: "ws://localhost:3000",
    relayId: "default",
    stateDir: defaultStateDir(),
    subscribe: "mentions",
    channels: [],
    presence: { enabled: true, heartbeatSec: 60 },
    profile: { name: "Pi Agent", about: "Autonomous Pi SDK agent" },
    pi: { cwd: process.cwd(), extensions: [] },
    security: {
      respondTo: "owner-only",
      allowlist: [],
      siblingAgents: [],
      readRoots: [],
      writeRoots: [],
      commandDenylist: [],
    },
    scheduler: {
      maxConcurrentTurns: 4,
      idleTimeoutSec: 900,
      maxTurnDurationSec: 7200,
      contextMessageLimit: 12,
    },
    telemetry: {
      enabled: true,
      coalesceMs: 40,
      metricsEnabled: true,
      langfuse: {
        enabled: false,
        host: "https://cloud.langfuse.com",
        privacy: "conversations",
      },
    },
    output: { maxMessageBytes: 16_000, oversizePolicy: "split" },
    buzzCli: { enabled: true, denyCommands: [] },
    lifecycle: { inactivityExitSec: 0, shutdownBudgetSec: 60 },
    remote: { recordConfig: false },
    logLevel: "info",
  };
}

/* -------------------------------------------------------------------------- */
/* Environment overlay                                                        */
/* -------------------------------------------------------------------------- */

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function envNumber(name: string): number | undefined {
  const raw = envString(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envBool(name: string): boolean | undefined {
  const raw = envString(name)?.toLowerCase();
  if (raw === undefined) return undefined;
  return raw === "1" || raw === "true" || raw === "yes";
}

function envList(name: string): string[] | undefined {
  const raw = envString(name);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const RESPOND_TO_MODES: readonly RespondToMode[] = ["owner-only", "allowlist", "anyone", "nobody"];

export const LANGFUSE_PRIVACY_PRESETS: readonly LangfusePrivacyPreset[] = [
  "metadata-only",
  "prompts-only",
  "conversations",
  "full-debug",
];

/**
 * Applies `AUTOGENT_*` (and the inherited `BUZZ_RELAY_URL`) over a base config.
 *
 * Unrecognised enum values fall back to the base value rather than throwing, so
 * a typo degrades to the safe default instead of taking the service down.
 */
export function applyEnv(base: AgentConfig, env = process.env): AgentConfig {
  const next: AgentConfig = structuredClone(base);

  next.relayUrl = envString("AUTOGENT_RELAY_URL") ?? envString("BUZZ_RELAY_URL") ?? next.relayUrl;
  next.relayId = envString("AUTOGENT_RELAY_ID") ?? next.relayId;
  next.stateDir = envString("AUTOGENT_STATE_DIR") ?? next.stateDir;

  const subscribe = envString("AUTOGENT_SUBSCRIBE");
  if (subscribe === "mentions" || subscribe === "all") next.subscribe = subscribe;
  next.channels = envList("AUTOGENT_CHANNELS") ?? next.channels;

  const respondTo = envString("AUTOGENT_RESPOND_TO") as RespondToMode | undefined;
  if (respondTo && RESPOND_TO_MODES.includes(respondTo)) next.security.respondTo = respondTo;
  next.security.allowlist = envList("AUTOGENT_RESPOND_TO_ALLOWLIST") ?? next.security.allowlist;
  next.security.siblingAgents = envList("AUTOGENT_SIBLING_AGENTS") ?? next.security.siblingAgents;
  next.security.readRoots = envList("AUTOGENT_READ_ROOTS") ?? next.security.readRoots;
  next.security.writeRoots = envList("AUTOGENT_WRITE_ROOTS") ?? next.security.writeRoots;
  next.security.commandDenylist =
    envList("AUTOGENT_COMMAND_DENYLIST") ?? next.security.commandDenylist;

  next.pi.cwd = envString("AUTOGENT_CWD") ?? next.pi.cwd;
  next.pi.model = envString("AUTOGENT_MODEL") ?? next.pi.model;
  next.pi.thinkingLevel = envString("AUTOGENT_THINKING") ?? next.pi.thinkingLevel;
  next.pi.tools = envList("AUTOGENT_TOOLS") ?? next.pi.tools;
  next.pi.excludeTools = envList("AUTOGENT_EXCLUDE_TOOLS") ?? next.pi.excludeTools;
  next.pi.appendSystemPrompt = envString("AUTOGENT_SYSTEM_PROMPT") ?? next.pi.appendSystemPrompt;
  next.pi.extensions = envList("AUTOGENT_EXTENSIONS") ?? next.pi.extensions;

  next.scheduler.maxConcurrentTurns =
    envNumber("AUTOGENT_MAX_CONCURRENT_TURNS") ?? next.scheduler.maxConcurrentTurns;
  next.scheduler.idleTimeoutSec =
    envNumber("AUTOGENT_IDLE_TIMEOUT") ?? next.scheduler.idleTimeoutSec;
  next.scheduler.maxTurnDurationSec =
    envNumber("AUTOGENT_MAX_TURN_DURATION") ?? next.scheduler.maxTurnDurationSec;
  next.scheduler.contextMessageLimit =
    envNumber("AUTOGENT_CONTEXT_MESSAGE_LIMIT") ?? next.scheduler.contextMessageLimit;

  next.telemetry.enabled = envBool("AUTOGENT_TELEMETRY") ?? next.telemetry.enabled;
  next.telemetry.metricsEnabled = envBool("AUTOGENT_METRICS") ?? next.telemetry.metricsEnabled;
  next.telemetry.coalesceMs = envNumber("AUTOGENT_TELEMETRY_COALESCE_MS") ?? next.telemetry.coalesceMs;

  const langfuse = next.telemetry.langfuse;
  langfuse.enabled = envBool("AUTOGENT_LANGFUSE") ?? langfuse.enabled;
  langfuse.host = envString("AUTOGENT_LANGFUSE_HOST") ?? langfuse.host;
  const langfusePrivacy = normalizeLangfusePrivacy(envString("AUTOGENT_LANGFUSE_PRIVACY"));
  if (langfusePrivacy) langfuse.privacy = langfusePrivacy;

  next.presence.enabled = envBool("AUTOGENT_PRESENCE") ?? next.presence.enabled;
  next.profile.name = envString("AUTOGENT_PROFILE_NAME") ?? next.profile.name;
  next.profile.about = envString("AUTOGENT_PROFILE_ABOUT") ?? next.profile.about;

  next.lifecycle.inactivityExitSec =
    envNumber("AUTOGENT_INACTIVITY_EXIT") ?? next.lifecycle.inactivityExitSec;
  next.lifecycle.shutdownBudgetSec =
    envNumber("AUTOGENT_SHUTDOWN_BUDGET") ?? next.lifecycle.shutdownBudgetSec;
  next.remote.recordConfig =
    envBool("AUTOGENT_REMOTE_CONFIG") ?? envBool("AUTOGENT_ENGRAM_CONFIG") ?? next.remote.recordConfig;

  next.buzzCli.enabled = envBool("AUTOGENT_BUZZ_CLI") ?? next.buzzCli.enabled;
  next.buzzCli.denyCommands = envList("AUTOGENT_BUZZ_DENY_COMMANDS") ?? next.buzzCli.denyCommands;

  next.output.maxMessageBytes =
    envNumber("AUTOGENT_MAX_MESSAGE_BYTES") ?? next.output.maxMessageBytes;
  const oversize = envString("AUTOGENT_OVERSIZE_POLICY");
  if (oversize === "split" || oversize === "truncate" || oversize === "reject") {
    next.output.oversizePolicy = oversize;
  }

  const logLevel = envString("AUTOGENT_LOG_LEVEL");
  if (logLevel === "error" || logLevel === "warn" || logLevel === "info" || logLevel === "debug") {
    next.logLevel = logLevel;
  }

  void env;
  return next;
}

/** Returns human-readable problems. An empty array means the config is usable. */
export function validateConfig(config: AgentConfig): string[] {
  const problems: string[] = [];
  if (!/^wss?:\/\//.test(config.relayUrl)) {
    problems.push(`relayUrl must start with ws:// or wss:// (got ${config.relayUrl})`);
  }
  if (config.scheduler.idleTimeoutSec >= config.scheduler.maxTurnDurationSec) {
    problems.push("scheduler.idleTimeoutSec must be less than scheduler.maxTurnDurationSec");
  }
  if (config.scheduler.maxConcurrentTurns < 1) {
    problems.push("scheduler.maxConcurrentTurns must be at least 1");
  }
  if (config.output.maxMessageBytes < 512) {
    problems.push("output.maxMessageBytes must be at least 512");
  }
  if (config.security.respondTo === "allowlist" && config.security.allowlist.length === 0) {
    problems.push("security.respondTo is 'allowlist' but the allowlist is empty");
  }
  if (config.lifecycle.inactivityExitSec < 0) {
    problems.push("lifecycle.inactivityExitSec must be zero or positive");
  }
  if (config.lifecycle.shutdownBudgetSec < 10) {
    problems.push("lifecycle.shutdownBudgetSec must be at least 10 seconds");
  }
  // Only a switched-on integration is validated: a stale or garbage value
  // behind `enabled: false` cannot affect the agent, and refusing to boot over
  // it would be a needless outage.
  if (config.telemetry.langfuse.enabled) {
    const { host } = config.telemetry.langfuse;
    if (!/^https?:\/\//.test(host)) {
      problems.push(`telemetry.langfuse.host must start with http:// or https:// (got ${host})`);
    }
  }
  return problems;
}
