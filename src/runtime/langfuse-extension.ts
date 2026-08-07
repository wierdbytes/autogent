/**
 * pi-langfuse extension wiring.
 *
 * Langfuse tracing is delegated to the `pi-langfuse` Pi extension
 * (https://github.com/gooyoung/pi-langfuse) instead of an in-house exporter.
 * The runtime's only job is to decide *whether* the extension loads and to
 * hand it its parameters:
 *
 * - The extension source is appended to the session extension list when
 *   `telemetry.langfuse.enabled` is true. Pi's package manager resolves and
 *   installs the `git:` specifier at session start.
 * - Credentials and settings travel through the environment variables the
 *   extension reads at load time (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
 *   `LANGFUSE_BASE_URL`, `LANGFUSE_PRIVACY_PRESET`). The extension re-reads
 *   them per session, so env updates bind to the next session, and a saved
 *   `~/.pi/agent/pi-langfuse/config.json` — if the operator wrote one by hand —
 *   outranks whatever we set here (the extension's own precedence).
 *
 * Env mutation is an output channel only: effective credentials are resolved
 * from the record head or a boot-time env snapshot, never read back from the
 * variables this module wrote.
 */

import type { LangfuseConfig } from "../config.js";
import type { LangfuseCredentials } from "./provider-auth.js";

/**
 * The extension source handed to Pi's resource loader.
 *
 * Points at our fork rather than `npm:pi-langfuse`: upstream snapshots the
 * system prompt inside `before_agent_start`, before our inline shaper
 * extension (always appended last by the resource loader) trims it, so traces
 * showed the Guidelines / Pi documentation sections the model never received.
 * The fork captures the prompt at `agent_start`, after the final override.
 * Switch back to `npm:pi-langfuse` once the fix lands upstream
 * (https://github.com/gooyoung/pi-langfuse/pull/13).
 */
export const LANGFUSE_EXTENSION_SOURCE =
  "git:github.com/wierdbytes/pi-langfuse@fix/system-prompt-capture-after-extensions";

/**
 * Returns the effective extension list: the owner's extensions with the
 * pi-langfuse source appended when tracing is on, and stripped when it is off
 * (an owner listing it manually keeps it regardless — their word wins).
 */
export function withLangfuseExtension(extensions: string[] | undefined, active: boolean): string[] {
  const base = extensions ?? [];
  if (!active) return base;
  if (base.includes(LANGFUSE_EXTENSION_SOURCE)) return base;
  return [...base, LANGFUSE_EXTENSION_SOURCE];
}

/** The env variables pi-langfuse reads; owned by {@link setLangfuseEnv}. */
const MANAGED_ENV_KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PRIVACY_PRESET",
] as const;

/** Materialises credentials and settings into the extension's env surface. */
export function setLangfuseEnv(
  langfuse: Pick<LangfuseConfig, "host" | "privacy">,
  credentials: LangfuseCredentials,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env["LANGFUSE_PUBLIC_KEY"] = credentials.publicKey;
  env["LANGFUSE_SECRET_KEY"] = credentials.secretKey;
  env["LANGFUSE_BASE_URL"] = langfuse.host;
  env["LANGFUSE_PRIVACY_PRESET"] = langfuse.privacy;
}

/**
 * Removes the variables {@link setLangfuseEnv} owns. Callers must only invoke
 * this after having applied the env themselves — a local operator's own
 * `LANGFUSE_*` variables are not ours to delete otherwise.
 */
export function clearLangfuseEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of MANAGED_ENV_KEYS) delete env[key];
}
