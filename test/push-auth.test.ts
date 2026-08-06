/**
 * Owner-side credential push (`autogent` CLI → re-login on a deployed
 * profile): bind under the 1:1 rule, rewrite the per-agent store, republish
 * the `autogent/auth` head — degrading to "local-only" whenever the cluster or
 * relay is unreachable, because the per-agent file already carries the truth.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeployPayload } from "../src/backend/payload.js";
import { pushProfileAuth } from "../src/backend-k8s/push-auth.js";
import { podName, secretName } from "../src/backend-k8s/names.js";
import { DEFAULT_AGENT_SETTINGS, type DeployProfile } from "../src/registry/profiles.js";
import {
  agentAuthPath,
  readAgentAuth,
  readBindings,
  writeBindings,
  credentialDigestsOf,
} from "../src/owner-auth/store.js";
import { mintAgent, type MintedAgent } from "./helpers/backend-request.js";

const AUTH_JSON = JSON.stringify({
  anthropic: { type: "oauth", refresh: "refresh-new", access: "a", expires: 1 },
});

function profile(minted: MintedAgent, overrides: Partial<DeployProfile> = {}): DeployProfile {
  return {
    name: "my-agent",
    createdAt: 1000,
    kubeContext: "k3s-agents",
    namespace: "autogent",
    image: "ghcr.io/wierdbytes/autogent:latest",
    storageClass: null,
    storageSize: "2Gi",
    inactivitySeconds: 7200,
    extensions: [],
    ...DEFAULT_AGENT_SETTINGS,
    agentPubkey: minted.agentPubkey,
    lastDeployedAt: 1000,
    ...overrides,
  };
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function secretObject(minted: MintedAgent, name: string): Record<string, unknown> {
  return {
    metadata: { name, creationTimestamp: "2026-01-01T00:00:00Z" },
    data: {
      AUTOGENT_NSEC: b64(minted.nsec),
      AUTOGENT_RELAY_URL: b64("ws://localhost:3000"),
      AUTOGENT_AUTH_TAG: b64(minted.authTag),
    },
  };
}

function podObject(minted: MintedAgent, secret: string): Record<string, unknown> {
  return {
    metadata: { name: podName(minted.agentPubkey) },
    spec: {
      containers: [
        {
          name: "agent",
          env: [{ name: "AUTOGENT_RELAY_ID", value: "prod" }],
          envFrom: [{ secretRef: { name: secret } }],
        },
      ],
    },
  };
}

/** A cluster that serves the Pod and its referenced bootstrap Secret. */
function liveCluster(minted: MintedAgent) {
  const secret = secretName(minted.agentPubkey, "g1");
  const objects: Record<string, Record<string, unknown>> = {
    [`pod/${podName(minted.agentPubkey)}`]: podObject(minted, secret),
    [`secret/${secret}`]: secretObject(minted, secret),
  };
  return {
    getJson: async (kind: string, name: string) => objects[`${kind}/${name}`] ?? null,
    listJson: async () => Object.values(objects),
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autogent-push-auth-"));
  process.env["AUTOGENT_AUTH_ROOT"] = root;
});

afterEach(() => {
  delete process.env["AUTOGENT_AUTH_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

describe("pushProfileAuth", () => {
  it("binds, rewrites the per-agent credential and republishes the head", async () => {
    const minted = mintAgent();
    const seen: Array<{ payload: DeployPayload; value: Record<string, unknown> }> = [];

    const outcome = await pushProfileAuth({
      profile: profile(minted),
      authJson: AUTH_JSON,
      ...liveCluster(minted),
      publishRecord: async (payload, value) => {
        seen.push({ payload, value });
      },
    });

    expect(outcome).toEqual({ state: "pushed" });
    expect(await readAgentAuth(minted.agentPubkey)).toBe(AUTH_JSON);
    expect(statSync(agentAuthPath(minted.agentPubkey, root)).mode & 0o777).toBe(0o600);

    const bindings = await readBindings();
    expect(bindings.bindings).toHaveLength(1);
    expect(bindings.bindings[0]!.agentPubkey).toBe(minted.agentPubkey);
    expect(bindings.bindings[0]!.refreshDigest).toBe(credentialDigestsOf(AUTH_JSON)[0]!.digest);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload.agentPubkey).toBe(minted.agentPubkey);
    expect(seen[0]!.payload.relayUrl).toBe("ws://localhost:3000");
    expect(seen[0]!.value).toEqual(JSON.parse(AUTH_JSON));
  });

  it("refuses a credential already bound to another agent, touching nothing", async () => {
    const minted = mintAgent();
    const other = mintAgent();
    await writeBindings({
      version: 1,
      bindings: [
        {
          agentPubkey: other.agentPubkey,
          providerId: "anthropic",
          refreshDigest: credentialDigestsOf(AUTH_JSON)[0]!.digest,
          createdAt: 1,
        },
      ],
    });

    let published = false;
    const outcome = await pushProfileAuth({
      profile: profile(minted),
      authJson: AUTH_JSON,
      ...liveCluster(minted),
      publishRecord: async () => {
        published = true;
      },
    });

    expect(outcome.state).toBe("conflict");
    if (outcome.state === "conflict") {
      expect(outcome.conflict.agentPubkey).toBe(other.agentPubkey);
    }
    expect(await readAgentAuth(minted.agentPubkey)).toBeNull();
    expect(published).toBe(false);
  });

  it("degrades to local-only when the cluster holds no bootstrap Secret", async () => {
    const minted = mintAgent();
    const outcome = await pushProfileAuth({
      profile: profile(minted),
      authJson: AUTH_JSON,
      getJson: async () => null,
      listJson: async () => [],
      publishRecord: async () => {
        throw new Error("must not publish");
      },
    });

    expect(outcome.state).toBe("local-only");
    if (outcome.state === "local-only") expect(outcome.reason).toMatch(/no bootstrap Secret/);
    // The credential is stored regardless — the next deploy publishes it.
    expect(await readAgentAuth(minted.agentPubkey)).toBe(AUTH_JSON);
  });

  it("degrades to local-only when the Secret holds a foreign identity", async () => {
    const minted = mintAgent();
    const other = mintAgent();
    const outcome = await pushProfileAuth({
      profile: profile(minted),
      authJson: AUTH_JSON,
      ...liveCluster(other),
      publishRecord: async () => {
        throw new Error("must not publish");
      },
    });

    expect(outcome.state).toBe("local-only");
    if (outcome.state === "local-only") expect(outcome.reason).toMatch(/mismatched identity/);
    expect(await readAgentAuth(minted.agentPubkey)).toBe(AUTH_JSON);
  });

  it("degrades to local-only when the relay refuses the head", async () => {
    const minted = mintAgent();
    const outcome = await pushProfileAuth({
      profile: profile(minted),
      authJson: AUTH_JSON,
      ...liveCluster(minted),
      publishRecord: async () => {
        throw new Error("relay said no");
      },
    });

    expect(outcome.state).toBe("local-only");
    if (outcome.state === "local-only") expect(outcome.reason).toMatch(/relay said no/);
    expect(await readAgentAuth(minted.agentPubkey)).toBe(AUTH_JSON);
  });
});
