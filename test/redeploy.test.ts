/**
 * Owner-side redeploy (`autogent` CLI → Redeploy action): the deploy payload
 * is reconstructed from the cluster's bootstrap Secret, verified against the
 * profile's bound identity, and handed to the standard deploy sequence.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../src/backend/wire.js";
import type { K8sDeployInput } from "../src/backend-k8s/deploy.js";
import { podName, secretName } from "../src/backend-k8s/names.js";
import {
  bootstrapFromSecret,
  passthroughEnvFromPod,
  redeployProfile,
} from "../src/backend-k8s/redeploy.js";
import { DEFAULT_AGENT_SETTINGS, getProfile, type DeployProfile } from "../src/registry/profiles.js";
import { mintAgent, type MintedAgent } from "./helpers/backend-request.js";

const TAGGED_IMAGE = "ghcr.io/wierdbytes/autogent:latest";

function profile(minted: MintedAgent, overrides: Partial<DeployProfile> = {}): DeployProfile {
  return {
    name: "my-agent",
    createdAt: 1000,
    kubeContext: "k3s-agents",
    namespace: "autogent",
    image: TAGGED_IMAGE,
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
          env: [
            { name: "AUTOGENT_REMOTE_CONFIG", value: "1" },
            { name: "AUTOGENT_RELAY_ID", value: "prod" },
            { name: "AUTOGENT_PROFILE_NAME", value: "Prod Agent" },
          ],
          envFrom: [{ secretRef: { name: secret } }],
        },
      ],
    },
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autogent-redeploy-"));
  process.env["AUTOGENT_AUTH_ROOT"] = root;
});

afterEach(() => {
  delete process.env["AUTOGENT_AUTH_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

describe("bootstrapFromSecret", () => {
  it("decodes the base64 triple", () => {
    const minted = mintAgent();
    const triple = bootstrapFromSecret(secretObject(minted, "s"));
    expect(triple).toEqual({
      nsec: minted.nsec,
      relayUrl: "ws://localhost:3000",
      authTagJson: minted.authTag,
    });
  });

  it("refuses a Secret missing part of the triple", () => {
    const minted = mintAgent();
    const secret = secretObject(minted, "s");
    delete (secret["data"] as Record<string, unknown>)["AUTOGENT_NSEC"];
    expect(() => bootstrapFromSecret(secret)).toThrow(/bootstrap triple/);
  });
});

describe("passthroughEnvFromPod", () => {
  it("keeps only the passthrough keys and tolerates a missing Pod", () => {
    const minted = mintAgent();
    expect(passthroughEnvFromPod(podObject(minted, "s"))).toEqual({
      AUTOGENT_RELAY_ID: "prod",
      AUTOGENT_PROFILE_NAME: "Prod Agent",
    });
    expect(passthroughEnvFromPod(null)).toEqual({});
  });
});

describe("redeployProfile", () => {
  it("reconstructs the payload from the Pod-referenced Secret and deploys", async () => {
    const minted = mintAgent();
    const secret = secretName(minted.agentPubkey, "g1");
    const objects: Record<string, Record<string, unknown>> = {
      [`pod/${podName(minted.agentPubkey)}`]: podObject(minted, secret),
      [`secret/${secret}`]: secretObject(minted, secret),
    };

    let seen: K8sDeployInput | null = null;
    const outcome = await redeployProfile({
      profile: profile(minted),
      getJson: async (kind, name) => objects[`${kind}/${name}`] ?? null,
      listJson: async () => {
        throw new Error("must not list when the Pod references its Secret");
      },
      deploy: async (input) => {
        seen = input;
        return { agentId: `autogent/${podName(minted.agentPubkey)}`, generation: "g2" };
      },
    });

    expect(outcome.generation).toBe("g2");
    const input = seen! as K8sDeployInput;
    expect(input.payload.agentPubkey).toBe(minted.agentPubkey);
    expect(input.payload.relayUrl).toBe("ws://localhost:3000");
    expect(input.payload.envVars).toEqual({
      AUTOGENT_RELAY_ID: "prod",
      AUTOGENT_PROFILE_NAME: "Prod Agent",
    });
    expect(input.nsec).toBe(minted.nsec);
    // The profile's mutable tag goes in untouched — deployToK8s resolves it
    // to the registry's *current* digest, which is what picks up a moved tag.
    expect(input.config.image).toBe(TAGGED_IMAGE);
    expect(input.profile?.name).toBe("my-agent");
    // Best-effort bookkeeping stamped the registry.
    expect((await getProfile("my-agent"))).toBeNull(); // profile was never saved — no crash
  });

  it("falls back to the newest labelled Secret when the Pod is gone", async () => {
    const minted = mintAgent();
    const old = secretObject(minted, secretName(minted.agentPubkey, "g1"));
    (old["metadata"] as Record<string, unknown>)["creationTimestamp"] = "2025-01-01T00:00:00Z";
    const current = secretObject(minted, secretName(minted.agentPubkey, "g2"));

    let deployed = false;
    await redeployProfile({
      profile: profile(minted),
      getJson: async () => null,
      listJson: async () => [old, current],
      deploy: async () => {
        deployed = true;
        return { agentId: "a", generation: "g3" };
      },
    });
    expect(deployed).toBe(true);
  });

  it("refuses a never-deployed profile", async () => {
    const minted = mintAgent();
    await expect(
      redeployProfile({ profile: profile(minted, { agentPubkey: null }) }),
    ).rejects.toThrow(ProviderError);
  });

  it("refuses when the cluster has no bootstrap Secret at all", async () => {
    const minted = mintAgent();
    await expect(
      redeployProfile({
        profile: profile(minted),
        getJson: async () => null,
        listJson: async () => [],
        deploy: async () => {
          throw new Error("must not deploy");
        },
      }),
    ).rejects.toThrow(/no bootstrap Secret/);
  });

  it("refuses a Secret whose key belongs to a different agent", async () => {
    const minted = mintAgent();
    const other = mintAgent();
    const secret = secretName(other.agentPubkey, "g1");
    await expect(
      redeployProfile({
        profile: profile(minted),
        getJson: async (kind, name) =>
          `${kind}/${name}` === `secret/${secret}` ? secretObject(other, secret) : null,
        listJson: async () => [secretObject(other, secret)],
        deploy: async () => {
          throw new Error("must not deploy");
        },
      }),
    ).rejects.toThrow(/mismatched identity/);
  });
});
