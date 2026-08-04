/**
 * `provider_config` — the persisted, UI-visible settings object.
 *
 * Invariant I2 (*no secrets in configuration*) is enforced on the desktop side
 * by a key-name lint that rejects any field whose word-split contains
 * `secret|password|token|key|credential`. Nothing here needs a credential: the
 * substrate is this machine, the agent's identity arrives inside the `deploy`
 * payload, and the Pi provider credential is whatever `~/.pi/agent/auth.json`
 * already holds for the user running Buzz.
 *
 * The schema is deliberately small and **fully defaulted**, so a user can pick
 * "autogent" in the Where-to-run dropdown and press Start without typing
 * anything. The desktop renders every field as a plain text input — no enums,
 * no nested objects, no masking (`ProviderConfigFields.tsx`) — so each field
 * here is a scalar a human can reasonably type.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fail } from "./wire.js";

/** Where instances live when the user does not say otherwise. */
export const DEFAULT_STATE_ROOT = join(homedir(), ".buzz-autogent");

/** The agent binary this provider deploys. See §Substrate note in the README. */
export const DEFAULT_COMMAND = "autogent-nostr";

/**
 * How long one deploy waits for the agent to actually come up.
 *
 * Startup confirmation is part of create (spec §Deploy State Machine): a spawn
 * that succeeded proves nothing, because a Node process can exit two seconds
 * later on a missing provider credential. The deadline bounds only how long a
 * single Start waits — it never authorises destroying anything.
 */
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 120;

export interface ProviderConfig {
  /** Name or absolute path of the agent binary. */
  command: string;
  /** Deployment scope: at most one live instance per agent key *per root*. */
  stateRoot: string;
  /** The agent's working directory. Empty means "inside the instance dir". */
  workspace: string | null;
  startupTimeoutSeconds: number;
  logLevel: string | null;
}

/** Expands a leading `~` and makes the path absolute. */
export function expandPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads a string field.
 *
 * `null` and `""` mean "not set" — a cleared UI field arrives as an empty
 * string, and treating that as an explicit empty value would make clearing a
 * box a way to deploy a nameless command.
 */
function stringField(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    fail(`provider_config.${key} must be a string (got ${typeof value})`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Reads a numeric field.
 *
 * A cleared numeric input can reach a provider as `""` rather than being
 * omitted (a known desktop defect around `coerceConfigValues`), so an empty
 * string degrades to the default. Anything else non-numeric is an in-band
 * error rather than a silent default — a typo in a timeout should be visible.
 */
function numberField(config: Record<string, unknown>, key: string): number | null {
  const value = config[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`provider_config.${key} must be a finite number`);
    return value;
  }
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      fail(`provider_config.${key} must be a number (got ${JSON.stringify(value)})`);
    }
    return parsed;
  }
  fail(`provider_config.${key} must be a number (got ${typeof value})`);
}

const LOG_LEVELS = new Set(["error", "warn", "info", "debug"]);

export function parseProviderConfig(raw: unknown): ProviderConfig {
  if (raw === undefined || raw === null) return parseProviderConfig({});
  const config = asObject(raw);
  if (!config) fail("provider_config must be a JSON object");

  const logLevel = stringField(config, "log_level");
  if (logLevel !== null && !LOG_LEVELS.has(logLevel)) {
    fail(`provider_config.log_level must be one of ${[...LOG_LEVELS].join(", ")}`);
  }

  const startup = numberField(config, "startup_timeout_seconds") ?? DEFAULT_STARTUP_TIMEOUT_SECONDS;
  if (startup < 5 || startup > 600) {
    fail("provider_config.startup_timeout_seconds must be between 5 and 600");
  }

  const workspace = stringField(config, "workspace");

  return {
    command: stringField(config, "command") ?? DEFAULT_COMMAND,
    stateRoot: expandPath(stringField(config, "state_root") ?? DEFAULT_STATE_ROOT),
    workspace: workspace === null ? null : expandPath(workspace),
    startupTimeoutSeconds: startup,
    logLevel,
  };
}

/**
 * The JSON Schema the desktop renders into a form.
 *
 * Only `title`, `description`, `default` (string prefill) and `required` are
 * honoured by the UI; `type` is used solely to coerce the submitted value.
 * Everything richer would be decoration, so it is left out.
 */
export function configSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      command: {
        type: "string",
        title: "Agent command",
        description:
          "Name or absolute path of the autogent-nostr binary. A bare name is resolved against PATH, augmented with the usual install locations.",
        default: DEFAULT_COMMAND,
      },
      state_root: {
        type: "string",
        title: "Instance root",
        description:
          "Directory holding each agent's identity, database, workspace and log. Also the deployment scope: one live instance per agent key per root.",
        default: DEFAULT_STATE_ROOT,
      },
      workspace: {
        type: "string",
        title: "Workspace directory",
        description:
          "Working directory for the agent's tools. Leave empty to use a per-agent directory inside the instance root.",
      },
      startup_timeout_seconds: {
        type: "number",
        title: "Startup timeout (seconds)",
        description:
          "How long Start waits for the agent to report itself online before returning an error. It never causes anything to be deleted.",
        default: String(DEFAULT_STARTUP_TIMEOUT_SECONDS),
      },
      log_level: {
        type: "string",
        title: "Log level",
        description: "error | warn | info | debug. Written to the instance log file.",
        default: "info",
      },
    },
    required: [],
  };
}
