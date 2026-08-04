/**
 * `buzz-backend-autogent` — a Buzz Desktop backend provider that runs
 * `autogent-nostr` as a detached process on this machine.
 *
 * Discovery is zero-registration: Buzz scans its own directory, every `PATH`
 * entry and `~/.local/bin` for executables named `buzz-backend-<id>`, and the
 * suffix becomes the provider id. Two operations exist, one process each —
 * `info` (10s) and `deploy` (600s) — and the desktop **copies this binary into
 * a temp directory and runs both operations from the copy**, so the file must
 * be self-contained: it is bundled, and it never resolves anything relative to
 * its own path.
 *
 * Output discipline, which the desktop enforces harshly:
 *
 * - exactly one JSON object on stdout, on one line, and nothing else ever;
 * - **exit 0 even for failures** — a non-zero status makes the desktop discard
 *   stdout entirely, so an in-band `{"ok": false, "error": …}` would be lost.
 *   Only an unreadable stdin, where no response can be composed, exits 1.
 */

import { parseProviderConfig, configSchema } from "./config.js";
import { parseDeployPayload } from "./payload.js";
import { deploy } from "./reconcile.js";
import { redactSecrets, secretsFromRequest } from "./redact.js";
import {
  errorResponse,
  parseRequest,
  PROTOCOL_VERSION,
  PROVIDER_ID,
  type ProviderResponse,
} from "./wire.js";

/** Baked in at bundle time; the version reported by `info`. */
declare const __AUTOGENT_VERSION__: string;

function providerVersion(): string {
  return typeof __AUTOGENT_VERSION__ === "string" ? __AUTOGENT_VERSION__ : "0.0.0-dev";
}

export async function handleRequest(input: string): Promise<ProviderResponse> {
  const request = parseRequest(input);

  if (request.op === "info") {
    // The desktop validates this against a *closed* allowlist of top-level
    // keys. An extra field here — even a helpful one — fails every deploy.
    return {
      ok: true,
      name: PROVIDER_ID,
      version: providerVersion(),
      protocol_version: PROTOCOL_VERSION,
      description: "Runs the agent as a detached process on this machine",
      config_schema: configSchema(),
    };
  }

  const payload = parseDeployPayload(request.agent);
  const config = parseProviderConfig(request.provider_config);
  const outcome = await deploy({ payload, config });
  return { ok: true, agent_id: outcome.agentId };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(): Promise<void> {
  let input: string;
  try {
    input = await readStdin();
  } catch (error) {
    // No request means no in-band channel: this is the one non-zero exit.
    process.stderr.write(`failed to read request: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const secrets = secretsFromRequest(input);
  let response: ProviderResponse;
  try {
    response = await handleRequest(input);
  } catch (error) {
    response = errorResponse(redactSecrets(describe(error), secrets));
  }

  // Redaction applies to the error *message*, never to the serialised
  // envelope, and serialisation happens last.
  //
  // The inverse order is a trap that looks like extra safety: the secrets
  // collected from a request include every env value of four characters or
  // more, and a real desktop payload sets `BUZZ_ACP_LAZY_POOL=true`. Scrubbing
  // the finished JSON therefore rewrote `{"ok":true,…}` into
  // `{"ok":[redacted],…}` — syntactically dead, on a deploy that had already
  // succeeded and left an agent running. Structure is not text; only the parts
  // that are genuinely free text may be treated as such.
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 0;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
