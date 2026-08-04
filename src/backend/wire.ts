/**
 * The desktop↔provider wire contract (`docs/remote-agents.md` §Provider Protocol).
 *
 * One process per operation: exactly one JSON object arrives on stdin, exactly
 * one JSON object leaves on stdout, and the process exits 0. The exit code
 * carries a single bit — non-zero makes Buzz Desktop discard our stdout
 * entirely — so *every* handled failure is in-band `{"ok": false, "error": …}`
 * with status 0. Only an unreadable stdin exits non-zero.
 */

export const PROTOCOL_VERSION = 1;

/** Provider id: the suffix of the `buzz-backend-autogent` filename. */
export const PROVIDER_ID = "autogent";

/**
 * Bumped when the on-disk instance layout changes shape.
 *
 * Recorded on every instance we create; the reconciler refuses to act
 * destructively on a record it cannot positively identify as its own output
 * (spec §Deploy State Machine, auto-repair fence).
 */
export const BINDING_VERSION = 1;

/** The management marker written into every instance record we author. */
export const MANAGED_BY = "buzz-backend-autogent";

export interface InfoRequest {
  op: "info";
  request_id?: string;
}

export interface DeployRequest {
  op: "deploy";
  request_id?: string;
  agent: unknown;
  provider_config?: unknown;
}

export type ProviderRequest = InfoRequest | DeployRequest;

/**
 * A failure the desktop should show verbatim.
 *
 * Everything that reaches the user goes through here so there is exactly one
 * place that decides "in-band error" versus "crash".
 */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export function fail(message: string): never {
  throw new ProviderError(message);
}

/**
 * The `info` response.
 *
 * The desktop validates this with a **closed** allowlist of top-level keys
 * (`backend.rs: validate_provider_info`): `ok`, `name`, `version`,
 * `protocol_version`, `description`, `config_schema`. Adding a field here —
 * even `request_id` — turns every deploy into a hard error, so the shape is
 * pinned by a test rather than left to good intentions.
 */
export interface InfoResponse {
  ok: true;
  name: string;
  version: string;
  protocol_version: number;
  description: string;
  config_schema: Record<string, unknown>;
}

export interface DeployResponse {
  ok: true;
  agent_id: string;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type ProviderResponse = InfoResponse | DeployResponse | ErrorResponse;

export function errorResponse(message: string): ErrorResponse {
  return { ok: false, error: message };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parses the request envelope.
 *
 * `request_id` is accepted and ignored: the desktop never echoes or checks it,
 * and one process serves one request, so there is nothing to correlate.
 */
export function parseRequest(input: string): ProviderRequest {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    fail(`request is not valid JSON: ${(error as Error).message}`);
  }
  const object = asObject(value);
  if (!object) fail("request must be a JSON object");

  const op = object["op"];
  if (op === "info") return { op: "info" };
  if (op === "deploy") {
    return {
      op: "deploy",
      agent: object["agent"],
      provider_config: object["provider_config"],
    };
  }
  fail(`unsupported op ${JSON.stringify(op)} — this provider speaks 'info' and 'deploy'`);
}
