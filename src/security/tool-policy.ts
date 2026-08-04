/**
 * Tool sandbox policy (plan §10.3, §7.6).
 *
 * A remote autonomous agent has no human at the keyboard, so Pi's interactive
 * permission prompt is not a security boundary — anything the model can reach is
 * something it will eventually run unattended. This module turns the declarative
 * {@link SecurityConfig} into the concrete limits the runtime enforces: which
 * tools exist at all, which paths they may touch, which shell commands are
 * refused outright, and how long/large a single execution may get.
 *
 * Pure logic: no filesystem access, no Pi import. The runtime feeds the result
 * into the session options and into its own bash wrapper.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { PiConfig, SecurityConfig } from "../config.js";

/** Pi's built-in tool names, per the SDK docs. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/**
 * Default profile for autonomous remote operation.
 *
 * Read and search are safe to leave on. `edit`/`write`/`bash` are the ones that
 * change the host, and they stay enabled because a coding agent that cannot code
 * is pointless — the containment comes from the roots and the command rules
 * below, not from removing the tools.
 */
export const DEFAULT_AUTONOMOUS_TOOLS: readonly BuiltinTool[] = BUILTIN_TOOLS;

/**
 * Tools disabled unconditionally.
 *
 * `ask_question` blocks forever with nobody to answer it, which would hang a
 * turn until the idle timeout fires.
 */
export const ALWAYS_EXCLUDED_TOOLS: readonly string[] = ["ask_question"];

export const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64_000;

export interface CommandRule {
  /** Stable id, used in decisions and telemetry. */
  id: string;
  pattern: RegExp;
  reason: string;
}

/**
 * Baseline shell rules.
 *
 * Aimed at the two things that actually hurt a headless agent: destroying or
 * escalating on the host, and exfiltrating the credentials it runs with. The
 * list is deliberately blunt — a denylist cannot be complete, so it is a
 * backstop behind the path roots, not the primary boundary.
 */
export const DEFAULT_COMMAND_RULES: readonly CommandRule[] = [
  {
    id: "privilege-escalation",
    pattern: /(^|[\s;&|(])(sudo|doas|su|pkexec)(\s|$)/,
    reason: "privilege escalation would take the agent outside its sandbox",
  },
  {
    id: "recursive-root-delete",
    pattern: /\brm\s+(-\S+\s+)*-\S*[rR]\S*\s+(-\S+\s+)*(\/|~|\$HOME)(\/?\*)?\s*($|[;&|])/,
    reason: "recursive delete of a home or filesystem root",
  },
  {
    id: "disk-write",
    pattern: /(^|[\s;&|(])(mkfs(\.\w+)?|fdisk|diskutil|dd)(\s|$)/,
    reason: "raw disk or filesystem manipulation",
  },
  {
    id: "host-power",
    pattern: /(^|[\s;&|(])(shutdown|reboot|halt|poweroff)(\s|$)/,
    reason: "the agent must not power-cycle its host",
  },
  {
    id: "remote-code-execution",
    pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
    reason: "piping a downloaded script straight into a shell executes unreviewed code",
  },
  {
    id: "fork-bomb",
    pattern: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;/,
    reason: "fork bomb",
  },
  {
    id: "credential-dump",
    pattern: /(^|[\s;&|(])(printenv(\s|$)|env\s*($|[|;>&]))/,
    reason: "dumping the environment would surface any credential the process holds",
  },
  {
    id: "world-writable",
    pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*(777|a\+rwx|o\+w)\b/,
    reason: "making files world-writable defeats the 0600/0700 sealing of agent state",
  },
];

export interface ToolPolicy {
  /** Allowlist handed to Pi's `tools` option. */
  tools: string[];
  /** Names disabled after the allowlist, handed to Pi's `excludeTools`. */
  excludeTools: string[];
  /** Absolute roots the tools may read. Always contains `cwd`. */
  readRoots: string[];
  /** Absolute roots the tools may write. Always contains `cwd`. */
  writeRoots: string[];
  /**
   * Absolute subtrees refused even when inside a read root — the sealed identity
   * lives here, and the model has no legitimate reason to read its own key.
   */
  denyRoots: string[];
  commandRules: CommandRule[];
  executionTimeoutMs: number;
  maxOutputBytes: number;
}

export interface ToolPolicyOptions {
  /** Working directory; the implicit read and write root. */
  cwd: string;
  /** Sealed state directory, added to {@link ToolPolicy.denyRoots}. */
  stateDir?: string;
  /** Narrows the tool set further; the intersection with the default wins. */
  pi?: Pick<PiConfig, "tools" | "excludeTools">;
  executionTimeoutMs?: number;
  maxOutputBytes?: number;
}

function normaliseRoots(roots: readonly string[], fallback: string): string[] {
  const resolved = roots.filter((root) => root.trim().length > 0).map((root) => resolve(root));
  return resolved.length > 0 ? unique([resolve(fallback), ...resolved]) : [resolve(fallback)];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Substrings from config become literal rules; operators do not write regexes. */
function literalRule(needle: string): CommandRule {
  return {
    id: `config:${needle}`,
    pattern: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    reason: `matches the configured command denylist entry '${needle}'`,
  };
}

export function resolveToolPolicy(
  security: SecurityConfig,
  options: ToolPolicyOptions,
): ToolPolicy {
  const requested = options.pi?.tools;
  const tools =
    requested && requested.length > 0
      ? DEFAULT_AUTONOMOUS_TOOLS.filter((tool) => requested.includes(tool))
      : [...DEFAULT_AUTONOMOUS_TOOLS];

  return {
    tools,
    excludeTools: unique([...ALWAYS_EXCLUDED_TOOLS, ...(options.pi?.excludeTools ?? [])]),
    readRoots: normaliseRoots(security.readRoots, options.cwd),
    writeRoots: normaliseRoots(security.writeRoots, options.cwd),
    denyRoots: options.stateDir ? [resolve(options.stateDir)] : [],
    commandRules: [...DEFAULT_COMMAND_RULES, ...security.commandDenylist.map(literalRule)],
    executionTimeoutMs: options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
}

/** The slice Pi's session options accept verbatim. */
export function toPiToolConfig(policy: ToolPolicy): { tools: string[]; excludeTools: string[] } {
  return { tools: [...policy.tools], excludeTools: [...policy.excludeTools] };
}

/* -------------------------------------------------------------------------- */
/* Decisions                                                                  */
/* -------------------------------------------------------------------------- */

export interface PolicyDecision {
  allowed: boolean;
  /** Stable id of the rule that fired; empty when allowed. */
  rule: string;
  /** Why, in a sentence the owner can act on. */
  reason: string;
}

const ALLOWED: PolicyDecision = { allowed: true, rule: "", reason: "" };

export function checkCommand(policy: ToolPolicy, command: string): PolicyDecision {
  for (const rule of policy.commandRules) {
    if (rule.pattern.test(command)) {
      return { allowed: false, rule: rule.id, reason: rule.reason };
    }
  }
  return ALLOWED;
}

function within(root: string, target: string): boolean {
  if (root === target) return true;
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function checkPath(
  policy: ToolPolicy,
  path: string,
  mode: "read" | "write",
): PolicyDecision {
  const target = resolve(path);

  for (const denied of policy.denyRoots) {
    if (within(denied, target)) {
      return {
        allowed: false,
        rule: "sealed-state",
        reason: `${denied} holds the sealed agent identity and is never readable by tools`,
      };
    }
  }

  const roots = mode === "write" ? policy.writeRoots : policy.readRoots;
  if (roots.some((root) => within(root, target))) return ALLOWED;

  return {
    allowed: false,
    rule: `outside-${mode}-roots`,
    reason: `${target} is outside the permitted ${mode} roots (${roots.join(", ")})`,
  };
}

/**
 * Renders a rejection for the operator.
 *
 * Returns null for an allowed decision so callers can `?? ` it into a log line
 * without branching.
 */
export function explainRejection(subject: string, decision: PolicyDecision): string | null {
  if (decision.allowed) return null;
  return `refused ${JSON.stringify(subject)}: ${decision.reason} [rule ${decision.rule}]`;
}

/** Human-readable summary of the effective sandbox, for `doctor` and startup logs. */
export function describeToolPolicy(policy: ToolPolicy): string {
  return [
    `tools: ${policy.tools.join(", ") || "(none)"}`,
    `excluded: ${policy.excludeTools.join(", ") || "(none)"}`,
    `read roots: ${policy.readRoots.join(", ")}`,
    `write roots: ${policy.writeRoots.join(", ")}`,
    `deny roots: ${policy.denyRoots.join(", ") || "(none)"}`,
    `command rules: ${policy.commandRules.length}`,
    `timeout: ${policy.executionTimeoutMs}ms, max output: ${policy.maxOutputBytes}B`,
  ].join("\n");
}
