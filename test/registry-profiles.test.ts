/**
 * The owner-side deploy-profile registry and its integration into the
 * `autogent-k8s` provider: the GUI surface shrinks to one `agent` field, the
 * substrate settings come from the profile, and the wizard-captured OAuth
 * credential is adopted for the identity on first deploy.
 */

import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDeployPayload } from "../src/backend/payload.js";
import {
  k8sConfigSchema,
  providerConfigFromProfile,
  requestedProfileName,
} from "../src/backend-k8s/config.js";
import { deployToK8s } from "../src/backend-k8s/deploy.js";
import { handleRequest } from "../src/backend-k8s/main.js";
import { agentAuthPath, readBindings } from "../src/owner-auth/store.js";
import {
  DEFAULT_AGENT_SETTINGS,
  PROFILE_NAME_RE,
  adoptProfileCredential,
  getProfile,
  markProfileDeployed,
  profileAuthPath,
  profileLangfusePath,
  readProfileAuth,
  readProfileLangfuseKeys,
  readProfiles,
  removeProfile,
  removeProfileLangfuseKeys,
  saveProfile,
  writeProfileLangfuseKeys,
  type DeployProfile,
} from "../src/registry/profiles.js";
import { mintAgent } from "./helpers/backend-request.js";

const IMAGE = `ghcr.io/wierdbytes/autogent@sha256:${"a".repeat(64)}`;

function profile(overrides: Partial<DeployProfile> = {}): DeployProfile {
  return {
    name: "my-agent",
    createdAt: 1000,
    kubeContext: "k3s-agents",
    namespace: "autogent",
    image: IMAGE,
    storageClass: null,
    storageSize: "2Gi",
    inactivitySeconds: 7200,
    extensions: [],
    ...DEFAULT_AGENT_SETTINGS,
    agentPubkey: null,
    lastDeployedAt: null,
    ...overrides,
  };
}

/** A plausible pi auth.json with an Anthropic refresh token. */
function authJson(refresh = "refresh-token-1"): string {
  return JSON.stringify({ anthropic: { type: "oauth", refresh, expires: 2_000_000_000_000 } });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autogent-registry-"));
  process.env["AUTOGENT_AUTH_ROOT"] = root;
});

afterEach(() => {
  delete process.env["AUTOGENT_AUTH_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

describe("profile registry", () => {
  it("round-trips profiles through registry.json (upsert by name)", async () => {
    await saveProfile(profile());
    await saveProfile(profile({ name: "other", namespace: "team-a" }));
    await saveProfile(profile({ inactivitySeconds: 0 })); // upsert my-agent
    const profiles = await readProfiles();
    expect(profiles.map((entry) => entry.name)).toEqual(["my-agent", "other"]);
    expect((await getProfile("my-agent"))?.inactivitySeconds).toBe(0);
  });

  it("normalizes profiles written before the extensions field existed", async () => {
    const legacy = profile() as unknown as Record<string, unknown>;
    delete legacy["extensions"];
    await writeFile(
      join(root, "registry.json"),
      JSON.stringify({ version: 1, profiles: [legacy] }),
    );
    expect((await getProfile("my-agent"))?.extensions).toEqual([]);
  });

  it("normalizes profiles written before the agent-settings fields existed", async () => {
    const legacy = profile() as unknown as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_AGENT_SETTINGS)) delete legacy[key];
    await writeFile(
      join(root, "registry.json"),
      JSON.stringify({ version: 1, profiles: [legacy] }),
    );
    expect(await getProfile("my-agent")).toMatchObject(DEFAULT_AGENT_SETTINGS);
  });

  it("round-trips agent settings and rejects malformed stored values", async () => {
    await saveProfile(
      profile({
        model: "anthropic/claude-sonnet-4-5",
        thinking: "high",
        respondTo: "allowlist",
        respondToAllowlist: ["a".repeat(64)],
        maxConcurrentTurns: 2,
      }),
    );
    expect(await getProfile("my-agent")).toMatchObject({
      model: "anthropic/claude-sonnet-4-5",
      thinking: "high",
      respondTo: "allowlist",
      respondToAllowlist: ["a".repeat(64)],
      maxConcurrentTurns: 2,
    });

    // A hand-edited registry with junk values falls back to the defaults.
    const mangled = profile() as unknown as Record<string, unknown>;
    mangled["respondTo"] = "everyone-please";
    mangled["maxConcurrentTurns"] = -3;
    mangled["model"] = 42;
    await writeFile(
      join(root, "registry.json"),
      JSON.stringify({ version: 1, profiles: [mangled] }),
    );
    expect(await getProfile("my-agent")).toMatchObject({
      respondTo: "owner-only",
      maxConcurrentTurns: null,
      model: null,
    });
  });

  it("round-trips the Langfuse settings and normalizes junk to the defaults", async () => {
    await saveProfile(
      profile({
        langfuseEnabled: true,
        langfuseHost: "https://langfuse.internal",
        langfusePrivacy: "full-debug",
      }),
    );
    expect(await getProfile("my-agent")).toMatchObject({
      langfuseEnabled: true,
      langfuseHost: "https://langfuse.internal",
      langfusePrivacy: "full-debug",
    });

    // A pre-extension registry file may still say `full`.
    const legacyPreset = profile({ langfuseEnabled: true }) as unknown as Record<string, unknown>;
    legacyPreset["langfusePrivacy"] = "full";
    await writeFile(
      join(root, "registry.json"),
      JSON.stringify({ version: 1, profiles: [legacyPreset] }),
    );
    expect(await getProfile("my-agent")).toMatchObject({ langfusePrivacy: "full-debug" });

    const mangled = profile({ langfuseEnabled: true }) as unknown as Record<string, unknown>;
    mangled["langfusePrivacy"] = "bogus";
    mangled["langfuseHost"] = "";
    await writeFile(
      join(root, "registry.json"),
      JSON.stringify({ version: 1, profiles: [mangled] }),
    );
    expect(await getProfile("my-agent")).toMatchObject({
      langfuseEnabled: true,
      langfuseHost: null,
      langfusePrivacy: null,
    });
  });

  it("defaults the Langfuse fields on profiles written before they existed", async () => {
    const legacy = profile() as unknown as Record<string, unknown>;
    for (const key of Object.keys(legacy)) {
      if (key.startsWith("langfuse")) delete legacy[key];
    }
    await writeFile(
      join(root, "registry.json"),
      JSON.stringify({ version: 1, profiles: [legacy] }),
    );
    expect(await getProfile("my-agent")).toMatchObject({
      langfuseEnabled: false,
      langfuseHost: null,
      langfusePrivacy: null,
    });
  });

  it("reads an empty list from a missing or corrupt registry", async () => {
    expect(await readProfiles()).toEqual([]);
    await writeFile(join(root, "registry.json"), "{not json");
    expect(await readProfiles()).toEqual([]);
  });

  it("marks the deployed axis (identity + timestamp — bookkeeping, not liveness)", async () => {
    await saveProfile(profile());
    await markProfileDeployed("my-agent", "f".repeat(64), root, () => 4242);
    const stored = await getProfile("my-agent");
    expect(stored?.agentPubkey).toBe("f".repeat(64));
    expect(stored?.lastDeployedAt).toBe(4242);
  });

  it("removes the profile together with its credential directory", async () => {
    await saveProfile(profile());
    await mkdir(join(root, "profiles", "my-agent"), { recursive: true });
    await writeFile(profileAuthPath("my-agent"), authJson());
    expect(await removeProfile("my-agent")).toBe(true);
    expect(await getProfile("my-agent")).toBeNull();
    await expect(access(profileAuthPath("my-agent"))).rejects.toThrow();
    expect(await removeProfile("my-agent")).toBe(false);
  });

  it("keeps profile names drop-down-safe (DNS-label shape)", () => {
    expect(PROFILE_NAME_RE.test("my-agent-2")).toBe(true);
    expect(PROFILE_NAME_RE.test("My Agent")).toBe(false);
    expect(PROFILE_NAME_RE.test("-lead")).toBe(false);
  });
});

describe("credential adoption on first deploy", () => {
  it("binds the profile credential to the revealed pubkey and copies it", async () => {
    await mkdir(join(root, "profiles", "my-agent"), { recursive: true });
    await writeFile(profileAuthPath("my-agent"), authJson());

    const pubkey = "a".repeat(64);
    const adoption = await adoptProfileCredential("my-agent", pubkey);
    expect(adoption.state).toBe("adopted");
    expect(await readFile(agentAuthPath(pubkey), "utf8")).toBe(authJson());
    const bindings = await readBindings();
    expect(bindings.bindings[0]).toMatchObject({ agentPubkey: pubkey, providerId: "anthropic" });
  });

  it("reports a missing credential and a 1:1 binding conflict distinctly", async () => {
    expect((await adoptProfileCredential("my-agent", "a".repeat(64))).state).toBe("none");

    await mkdir(join(root, "profiles", "my-agent"), { recursive: true });
    await writeFile(profileAuthPath("my-agent"), authJson("shared-refresh"));
    expect((await adoptProfileCredential("my-agent", "a".repeat(64))).state).toBe("adopted");
    const conflict = await adoptProfileCredential("my-agent", "b".repeat(64));
    expect(conflict.state).toBe("conflict");
  });

  it("stores Langfuse keys 0600 next to auth.json and reads them back", async () => {
    expect(await readProfileLangfuseKeys("my-agent")).toBeNull();
    await writeProfileLangfuseKeys("my-agent", { publicKey: "pk-lf-1", secretKey: "sk-lf-1" });
    expect(await readProfileLangfuseKeys("my-agent")).toEqual({
      publicKey: "pk-lf-1",
      secretKey: "sk-lf-1",
    });
    // Wire shape, so the deploy path can publish the value verbatim.
    expect(JSON.parse(await readFile(profileLangfusePath("my-agent"), "utf8"))).toEqual({
      public_key: "pk-lf-1",
      secret_key: "sk-lf-1",
    });
    expect((await stat(profileLangfusePath("my-agent"))).mode & 0o777).toBe(0o600);

    await removeProfileLangfuseKeys("my-agent");
    expect(await readProfileLangfuseKeys("my-agent")).toBeNull();
    // Removing twice is not an error.
    await removeProfileLangfuseKeys("my-agent");
  });

  it("treats a malformed or half-filled langfuse.json as no keys", async () => {
    await mkdir(join(root, "profiles", "my-agent"), { recursive: true });
    await writeFile(profileLangfusePath("my-agent"), "{not json");
    expect(await readProfileLangfuseKeys("my-agent")).toBeNull();
    await writeFile(profileLangfusePath("my-agent"), JSON.stringify({ public_key: "pk-lf-1" }));
    expect(await readProfileLangfuseKeys("my-agent")).toBeNull();
  });

  it("drops the Langfuse keys together with the profile directory", async () => {
    await saveProfile(profile());
    await writeProfileLangfuseKeys("my-agent", { publicKey: "pk-lf-1", secretKey: "sk-lf-1" });
    expect(await removeProfile("my-agent")).toBe(true);
    expect(await readProfileLangfuseKeys("my-agent")).toBeNull();
  });

  it("reads back the profile credential the wizard stored", async () => {
    expect(await readProfileAuth("my-agent")).toBeNull();
    await mkdir(join(root, "profiles", "my-agent"), { recursive: true });
    await writeFile(profileAuthPath("my-agent"), authJson());
    expect(await readProfileAuth("my-agent")).toBe(authJson());
  });
});

describe("GUI surface", () => {
  it("exposes exactly one field — the profile drop-down — and requires it", () => {
    const schema = k8sConfigSchema(["alpha", "beta"]);
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["agent"]);
    expect(properties["agent"]?.["enum"]).toEqual(["alpha", "beta"]);
    expect(properties["agent"]?.["default"]).toBe("alpha");
    expect(schema["required"]).toEqual(["agent"]);
  });

  it("renders an actionable empty state instead of an empty enum", () => {
    const schema = k8sConfigSchema([]);
    const agent = (schema["properties"] as Record<string, Record<string, unknown>>)["agent"];
    expect(agent?.["enum"]).toBeUndefined();
    expect(String(agent?.["description"])).toMatch(/autogent.*CLI/);
  });

  it("keeps the I2 lint honest on the reduced schema", () => {
    const names = Object.keys(k8sConfigSchema(["x"])["properties"] as Record<string, unknown>);
    for (const name of names) {
      expect(name).not.toMatch(/secret|password|token|key(?!_)|credential/i);
    }
  });

  it("requires provider_config.agent with a message pointing at the CLI", () => {
    expect(() => requestedProfileName({})).toThrow(/provider_config\.agent is required.*autogent/s);
    expect(requestedProfileName({ agent: "my-agent" })).toBe("my-agent");
  });
});

describe("deploy through a profile", () => {
  it("materialises the substrate config from the profile via the strict parser", () => {
    const config = providerConfigFromProfile(profile({ storageClass: "local-path" }));
    expect(config).toMatchObject({
      kubeContext: "k3s-agents",
      namespace: "autogent",
      image: IMAGE,
      storageClass: "local-path",
      inactivitySeconds: 7200,
    });
    expect(() => providerConfigFromProfile(profile({ namespace: "Bad_NS" }))).toThrow(/namespace/);
  });

  it("carries the profile's extension list through the flat-scalar parser", () => {
    const config = providerConfigFromProfile(
      profile({ extensions: ["npm:@wierdbytes/pi-anthropic", "npm:@acme/pi-extra"] }),
    );
    expect(config.extensions).toEqual(["npm:@wierdbytes/pi-anthropic", "npm:@acme/pi-extra"]);
    expect(providerConfigFromProfile(profile()).extensions).toEqual([]);
  });

  it("refuses an unknown profile before parsing anything substrate-shaped", async () => {
    const minted = mintAgent();
    await expect(
      handleRequest(
        JSON.stringify({ op: "deploy", agent: minted.agent, provider_config: { agent: "ghost" } }),
      ),
    ).rejects.toThrow(/unknown agent profile "ghost".*autogent/s);
  });

  it("fails closed when the profile has no stored login", async () => {
    await saveProfile(profile());
    const minted = mintAgent();
    const payload = parseDeployPayload(minted.agent);
    await expect(
      deployToK8s({
        payload,
        config: providerConfigFromProfile(profile()),
        nsec: minted.nsec,
        profile: profile(),
      }),
    ).rejects.toThrow(/no provider credentials.*'my-agent' has no stored login/s);
  });

  it("surfaces the 1:1 conflict when the profile account already drives another agent", async () => {
    await saveProfile(profile());
    await mkdir(join(root, "profiles", "my-agent"), { recursive: true });
    await writeFile(profileAuthPath("my-agent"), authJson("one-account"));
    expect((await adoptProfileCredential("my-agent", "c".repeat(64))).state).toBe("adopted");

    const minted = mintAgent();
    const payload = parseDeployPayload(minted.agent);
    await expect(
      deployToK8s({
        payload,
        config: providerConfigFromProfile(profile()),
        nsec: minted.nsec,
        profile: profile(),
      }),
    ).rejects.toThrow(/already bound to agent.*different account/s);
  });

  it("lists the registry in the info response's enum", async () => {
    await saveProfile(profile({ name: "alpha" }));
    await saveProfile(profile({ name: "beta" }));
    const response = await handleRequest(JSON.stringify({ op: "info" }));
    expect(response.ok).toBe(true);
    const schema = (response as { config_schema: Record<string, unknown> }).config_schema;
    const agent = (schema["properties"] as Record<string, Record<string, unknown>>)["agent"];
    expect(agent?.["enum"]).toEqual(["alpha", "beta"]);
  });
});
