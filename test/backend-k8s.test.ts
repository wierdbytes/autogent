/**
 * `buzz-backend-autogent-k8s`: provider_config validation, manifest shapes,
 * engram-config derivation and the pre-mutation refusal order (plan §4).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDeployPayload } from "../src/backend/payload.js";
import { ProviderError } from "../src/backend/wire.js";
import { k8sConfigSchema, parseK8sProviderConfig } from "../src/backend-k8s/config.js";
import { buildCoreConfig, buildPodEnv } from "../src/backend-k8s/engrams.js";
import { deployToK8s, podVerdict } from "../src/backend-k8s/deploy.js";
import { handleRequest } from "../src/backend-k8s/main.js";
import { podObject, pvcObject, secretObject, type AgentObjectsInput } from "../src/backend-k8s/manifests.js";
import { agentSelector, podName, pvcName, secretName } from "../src/backend-k8s/names.js";
import { mintAgent } from "./helpers/backend-request.js";

const IMAGE = `ghcr.io/wierdbytes/autogent@sha256:${"a".repeat(64)}`;

function config(overrides: Record<string, unknown> = {}) {
  return parseK8sProviderConfig({ image: IMAGE, ...overrides });
}

describe("provider_config", () => {
  it("parses defaults around a digest-pinned image", () => {
    const parsed = config();
    expect(parsed).toMatchObject({
      namespace: "autogent",
      image: IMAGE,
      storageSize: "2Gi",
      inactivitySeconds: 7200,
      kubeContext: null,
      storageClass: null,
    });
  });

  it("refuses a mutable tag image (this object runs with the agent's key)", () => {
    expect(() => config({ image: "ghcr.io/wierdbytes/autogent:latest" })).toThrow(
      /not digest-pinned/,
    );
  });

  it("requires the image", () => {
    expect(() => parseK8sProviderConfig({})).toThrow(/image is required/);
  });

  it("accepts 0 as the legal indefinite lifetime", () => {
    expect(config({ inactivity_seconds: 0 }).inactivitySeconds).toBe(0);
  });

  it("rejects malformed namespace, size and inactivity values", () => {
    expect(() => config({ namespace: "Bad_NS" })).toThrow(/namespace/);
    expect(() => config({ storage_size: "two gigs" })).toThrow(/storage_size/);
    expect(() => config({ inactivity_seconds: -5 })).toThrow(/inactivity_seconds/);
  });

  it("keeps the schema free of secret-shaped field names (I2)", () => {
    const schema = k8sConfigSchema();
    const names = Object.keys((schema["properties"] ?? {}) as Record<string, unknown>);
    for (const name of names) {
      expect(name).not.toMatch(/secret|password|token|key(?!_)|credential/i);
      // `kube_context` word-splits to kube + context; `key` must not appear as a word.
      expect(name.split(/[_\-.]/)).not.toContain("key");
    }
  });
});

describe("manifests", () => {
  const minted = mintAgent();

  function objects(overrides: Partial<AgentObjectsInput> = {}): AgentObjectsInput {
    return {
      agentPubkey: minted.agentPubkey,
      generation: "g1abc",
      config: config(),
      nsec: minted.nsec,
      relayUrl: "wss://relay.example",
      authTagJson: minted.authTag,
      extraEnv: { AUTOGENT_RELAY_ID: "prod" },
      ...overrides,
    };
  }

  it("puts the bootstrap triple — and nothing else — into the Secret", () => {
    const secret = secretObject(objects());
    const data = (secret["stringData"] ?? {}) as Record<string, string>;
    expect(Object.keys(data).sort()).toEqual([
      "AUTOGENT_AUTH_TAG",
      "AUTOGENT_NSEC",
      "AUTOGENT_RELAY_URL",
    ]);
    expect(data["AUTOGENT_NSEC"]).toBe(minted.nsec);
  });

  it("names objects deterministically from the pubkey", () => {
    expect(podName(minted.agentPubkey)).toBe(`autogent-${minted.agentPubkey.slice(0, 12)}`);
    expect(pvcName(minted.agentPubkey)).toContain(minted.agentPubkey.slice(0, 12));
    expect(secretName(minted.agentPubkey, "g1")).toContain("-g1");
    expect(agentSelector(minted.agentPubkey)).toContain(minted.agentPubkey.slice(0, 32));
  });

  it("derives restartPolicy from the lifetime rule", () => {
    const bounded = podObject(objects()) as { spec: Record<string, unknown> };
    expect(bounded.spec["restartPolicy"]).toBe("Never");

    const indefinite = podObject(
      objects({ config: config({ inactivity_seconds: 0 }) }),
    ) as { spec: Record<string, unknown> };
    expect(indefinite.spec["restartPolicy"]).toBe("OnFailure");
  });

  it("gives the container no probes, the PVC mount and the grace budget", () => {
    const pod = podObject(objects()) as {
      spec: {
        terminationGracePeriodSeconds: number;
        containers: Array<Record<string, unknown>>;
        volumes: Array<Record<string, unknown>>;
      };
    };
    expect(pod.spec.terminationGracePeriodSeconds).toBe(60);
    const container = pod.spec.containers[0] as Record<string, unknown>;
    expect(container["livenessProbe"]).toBeUndefined();
    expect(container["readinessProbe"]).toBeUndefined();
    expect(container["envFrom"]).toEqual([
      { secretRef: { name: secretName(minted.agentPubkey, "g1abc") } },
    ]);
    const env = container["env"] as Array<{ name: string; value: string }>;
    const names = env.map((entry) => entry.name);
    expect(names).toContain("AUTOGENT_ENGRAM_CONFIG");
    expect(names).toContain("AUTOGENT_INACTIVITY_EXIT");
    expect(names).toContain("AUTOGENT_RELAY_ID");
    // The nsec travels only via envFrom→Secret, never as a literal.
    expect(env.some((entry) => entry.value === minted.nsec)).toBe(false);
  });

  it("requests storage of the configured class and size", () => {
    const pvc = pvcObject(objects({ config: config({ storage_class: "local-path" }) })) as {
      spec: Record<string, unknown>;
    };
    expect(pvc.spec["storageClassName"]).toBe("local-path");
    expect((pvc.spec["resources"] as Record<string, unknown>)["requests"]).toEqual({
      storage: "2Gi",
    });
  });
});

describe("core-engram derivation from the payload", () => {
  it("projects model, prompt, gate and ceilings into the config", () => {
    const minted = mintAgent({
      model: "anthropic/claude-sonnet-4-5",
      system_prompt: "be helpful",
      respond_to: "allowlist",
      respond_to_allowlist: ["a".repeat(64)],
    });
    const payload = parseDeployPayload(minted.agent);
    const core = buildCoreConfig(payload, 3600);
    expect(core).toMatchObject({
      v: 1,
      model: "anthropic/claude-sonnet-4-5",
      system_prompt: "be helpful",
      respond_to: "allowlist",
      respond_to_allowlist: ["a".repeat(64)],
      inactivity_exit_sec: 3600,
    });
  });

  it("lets launch.env override, translating buzz-acp policy keys", () => {
    const minted = mintAgent({ model: "anthropic/base" });
    const launch = minted.agent["launch"] as Record<string, unknown>;
    launch["policy_env"] = { BUZZ_ACP_MODEL: "anthropic/policy", BUZZ_ACP_AGENTS: "2" };
    launch["env"] = { AUTOGENT_THINKING: "high", AUTOGENT_CONTEXT_MESSAGE_LIMIT: "6" };
    const payload = parseDeployPayload(minted.agent);
    const core = buildCoreConfig(payload, 0);
    expect(core.model).toBe("anthropic/policy");
    expect(core.thinking).toBe("high");
    expect(core.scheduler).toEqual({ max_concurrent_turns: 2, context_message_limit: 6 });
    expect(core.inactivity_exit_sec).toBe(0);
  });

  it("passes only the non-secret allowlist into the Pod env", () => {
    const minted = mintAgent();
    const launch = minted.agent["launch"] as Record<string, unknown>;
    launch["env"] = {
      AUTOGENT_RELAY_ID: "prod",
      AUTOGENT_LOG_LEVEL: "debug",
      SOME_USER_SECRET: "must-not-travel",
      AUTOGENT_MODEL: "goes-via-engram-not-env",
    };
    const payload = parseDeployPayload(minted.agent);
    const env = buildPodEnv(payload);
    expect(env["AUTOGENT_RELAY_ID"]).toBe("prod");
    expect(env["AUTOGENT_LOG_LEVEL"]).toBe("debug");
    expect(env["SOME_USER_SECRET"]).toBeUndefined();
    expect(env["AUTOGENT_MODEL"]).toBeUndefined();
    expect(env["AUTOGENT_PROFILE_NAME"]).toBe("Test Agent");
  });
});

describe("deploy refusal order", () => {
  let authRoot: string;

  beforeEach(() => {
    authRoot = mkdtempSync(join(tmpdir(), "autogent-k8s-auth-"));
    process.env["AUTOGENT_AUTH_ROOT"] = authRoot;
  });

  afterEach(() => {
    delete process.env["AUTOGENT_AUTH_ROOT"];
    rmSync(authRoot, { recursive: true, force: true });
  });

  it("refuses deploy before touching relay or cluster when no account is bound", async () => {
    const minted = mintAgent();
    const payload = parseDeployPayload(minted.agent);
    await expect(
      deployToK8s({ payload, config: config(), nsec: minted.nsec }),
    ).rejects.toThrow(/no provider credentials .* auth login/s);
  });

  it("speaks the provider wire: info has the closed key set", async () => {
    const response = await handleRequest(JSON.stringify({ op: "info", request_id: "req-1" }));
    expect(Object.keys(response).sort()).toEqual([
      "config_schema",
      "description",
      "name",
      "ok",
      "protocol_version",
      "version",
    ]);
    expect(response).toMatchObject({ ok: true, name: "autogent-k8s", protocol_version: 1 });
  });

  // handleRequest throws ProviderError; main() converts it to the in-band
  // `{ok:false}` envelope with exit 0 — same split as the local provider.
  it("refuses relay-mesh agents (fixture parity)", async () => {
    const minted = mintAgent({ provider: "relay-mesh" });
    await expect(
      handleRequest(
        JSON.stringify({ op: "deploy", agent: minted.agent, provider_config: { image: IMAGE } }),
      ),
    ).rejects.toThrow(/relay-mesh|shared compute/);
  });

  it("refuses a tag-pinned image (fixture parity)", async () => {
    const minted = mintAgent();
    await expect(
      handleRequest(
        JSON.stringify({
          op: "deploy",
          agent: minted.agent,
          provider_config: { image: "ghcr.io/wierdbytes/autogent:latest" },
        }),
      ),
    ).rejects.toThrow(/digest-pinned/);
  });
});

describe("podVerdict", () => {
  it("treats an invisible pod as pending", () => {
    expect(podVerdict(null)).toEqual({ state: "pending", reason: "pod not visible yet" });
  });

  it("recognises a running container", () => {
    expect(
      podVerdict({ status: { phase: "Running", containerStatuses: [{ state: { running: {} } }] } }),
    ).toEqual({ state: "running" });
  });

  it("fails fast on pull errors instead of burning the whole timeout", () => {
    const verdict = podVerdict({
      status: {
        phase: "Pending",
        containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }],
      },
    });
    expect(verdict).toEqual({ state: "failed", reason: "ImagePullBackOff" });
  });

  it("reports a crashed container's exit code", () => {
    const verdict = podVerdict({
      status: {
        phase: "Running",
        containerStatuses: [{ state: { terminated: { exitCode: 1 } } }],
      },
    });
    expect(verdict).toEqual({ state: "failed", reason: "container exited 1" });
  });

  it("propagates ProviderError for in-band reporting", () => {
    expect(new ProviderError("x")).toBeInstanceOf(Error);
  });
});
