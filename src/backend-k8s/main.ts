/**
 * `buzz-backend-autogent-k8s` — deploys `autogent-nostr` to a Kubernetes
 * substrate (k3s on a VM first, AKS by switching kubeconfig context).
 *
 * Same wire discipline as the local provider: one JSON request on stdin, one
 * JSON response on stdout, exit 0 even for handled failures. Operations are
 * `info` and `deploy` — the full set Buzz Desktop sends (verified against
 * `buzz-backend-kubernetes/tests/fixtures/provider-wire/`, closing О-1).
 * Stop is `!shutdown` over the relay; delete orphans substrate objects until
 * the next deploy GCs them.
 */

import { parseDeployPayload } from "../backend/payload.js";
import { redactSecrets, secretsFromRequest } from "../backend/redact.js";
import {
  errorResponse,
  parseRequest,
  PROTOCOL_VERSION,
  type ProviderResponse,
} from "../backend/wire.js";
import { k8sConfigSchema, parseK8sProviderConfig } from "./config.js";
import { deployToK8s } from "./deploy.js";

export const K8S_PROVIDER_ID = "autogent-k8s";

/** Baked in at bundle time; the version reported by `info`. */
declare const __AUTOGENT_VERSION__: string;

function providerVersion(): string {
  return typeof __AUTOGENT_VERSION__ === "string" ? __AUTOGENT_VERSION__ : "0.0.0-dev";
}

function rawNsec(agent: unknown): string {
  // parseDeployPayload has already validated this; the raw string is re-read
  // here only because the Secret carries the operator-facing encoding.
  const value = (agent as Record<string, unknown>)["private_key_nsec"];
  return typeof value === "string" ? value : "";
}

export async function handleRequest(input: string): Promise<ProviderResponse> {
  const request = parseRequest(input);

  if (request.op === "info") {
    // Closed key allowlist on the desktop side — no extra fields, ever.
    return {
      ok: true,
      name: K8S_PROVIDER_ID,
      version: providerVersion(),
      protocol_version: PROTOCOL_VERSION,
      description: "Runs the agent as a Pod on a Kubernetes cluster (ambient kubeconfig)",
      config_schema: k8sConfigSchema(),
    };
  }

  const payload = parseDeployPayload(request.agent);
  const config = parseK8sProviderConfig(request.provider_config);
  const outcome = await deployToK8s({ payload, config, nsec: rawNsec(request.agent) });
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
    const message = error instanceof Error ? error.message : String(error);
    response = errorResponse(redactSecrets(message, secrets));
  }

  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 0;
}
