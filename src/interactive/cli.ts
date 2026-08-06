#!/usr/bin/env node
/**
 * `autogent` — the interactive owner-side registry CLI.
 *
 * The redesigned creation flow: agents are configured *here* first — a wizard
 * collects every substrate parameter (kube context, namespace, image, storage,
 * inactivity bound) and runs the mandatory pi provider login (OAuth or API key) — and the
 * resulting deploy profile lands in the registry that Buzz Desktop's provider
 * form renders as a drop-down. The GUI keeps the minimal surface: it only
 * picks a profile; everything else is configured through this CLI.
 *
 * Identity is deliberately *not* created here: the Nostr keypair and the
 * NIP-OA attestation are minted by Buzz Desktop when the agent record is
 * added there (remote-agents.md). A profile shows as "deployed" once the
 * first deploy has bound that identity to it.
 */

import { realpathSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import type { LangfusePrivacyPreset, RespondToMode } from "../config.js";
import {
  DEFAULT_IMAGE,
  DEFAULT_INACTIVITY_SECONDS,
  DEFAULT_NAMESPACE,
  DEFAULT_STORAGE_SIZE,
  NAMESPACE_RE,
  QUANTITY_RE,
  providerConfigFromProfile,
} from "../backend-k8s/config.js";
import { podVerdict } from "../backend-k8s/deploy.js";
import { redeployProfile } from "../backend-k8s/redeploy.js";
import { deleteAndWait, getJson, kubectl } from "../backend-k8s/kubectl.js";
import { podName } from "../backend-k8s/names.js";
import { listAuthedCatalog, type AuthedProviderCatalog } from "../owner-auth/catalog.js";
import { listLoginChoices, runProviderLogin } from "../owner-auth/oauth.js";
import {
  DEFAULT_AGENT_SETTINGS,
  PROFILE_NAME_RE,
  ensureProfileAuthDir,
  profileAuthPath,
  readProfileLangfuseKeys,
  readProfiles,
  removeProfile,
  saveProfile,
  writeProfileLangfuseKeys,
  type AgentSettings,
  type DeployProfile,
} from "../registry/profiles.js";

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const LOG_TAIL_LINES = 200;

function cancelled(value: unknown): value is symbol {
  return p.isCancel(value);
}

async function hasLogin(profile: DeployProfile): Promise<boolean> {
  try {
    await access(profileAuthPath(profile.name));
    return true;
  } catch {
    return false;
  }
}

function deployedHint(profile: DeployProfile, loggedIn: boolean): string {
  const parts: string[] = [];
  if (profile.agentPubkey !== null) {
    const when =
      profile.lastDeployedAt !== null
        ? ` @ ${new Date(profile.lastDeployedAt).toISOString().slice(0, 16).replace("T", " ")}`
        : "";
    parts.push(`deployed ${profile.agentPubkey.slice(0, 12)}…${when}`);
  } else {
    parts.push("not deployed");
  }
  if (!loggedIn) parts.push("⚠ no login");
  return parts.join(" · ");
}

/** One line for the Langfuse axis: the settings plus whether keys are here. */
function langfuseSummary(profile: DeployProfile, keysStored: boolean): string {
  if (!profile.langfuseEnabled) return "disabled";
  const settings = [
    profile.langfusePrivacy ?? "conversations (default)",
    profile.langfuseHost ?? "cloud.langfuse.com",
    `sample ${profile.langfuseSampleRate ?? 1}`,
  ].join(" · ");
  // Missing keys are a warning, not an error: they may already be on the relay
  // from `autogent-nostr langfuse set`, and the agent degrades to no tracing.
  const keys = keysStored
    ? "keys stored"
    : "keys MISSING (set here or via autogent-nostr langfuse set)";
  return `${settings} · ${keys}`;
}

function profileDetails(
  profile: DeployProfile,
  loggedIn: boolean,
  langfuseKeysStored: boolean,
): string {
  const prompt =
    profile.systemPrompt === null
      ? "(none)"
      : profile.systemPrompt.length > 60
        ? `${profile.systemPrompt.slice(0, 57)}…`
        : profile.systemPrompt;
  const tools =
    profile.toolsInclude.length === 0 && profile.toolsExclude.length === 0
      ? "(pi default)"
      : [
          profile.toolsInclude.length > 0 ? `include: ${profile.toolsInclude.join(", ")}` : "",
          profile.toolsExclude.length > 0 ? `exclude: ${profile.toolsExclude.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
  return [
    `kube context:  ${profile.kubeContext ?? "(current)"}`,
    `namespace:     ${profile.namespace}`,
    `image:         ${profile.image}`,
    `storage:       ${profile.storageSize}${profile.storageClass ? ` (${profile.storageClass})` : " (default class)"}`,
    `extensions:    ${profile.extensions.length > 0 ? profile.extensions.join(", ") : "(none)"}`,
    `idle timeout:  ${profile.inactivitySeconds === 0 ? "unbounded" : `${profile.inactivitySeconds}s`}`,
    `model:         ${profile.model ?? "(pi default)"}`,
    `effort:        ${profile.thinking ?? "(model default)"}`,
    `system prompt: ${prompt}`,
    `respond to:    ${profile.respondTo}${profile.respondTo === "allowlist" ? ` (${profile.respondToAllowlist.length} pubkey(s))` : ""}`,
    `tools:         ${tools}`,
    `scheduler:     ${profile.maxConcurrentTurns ?? "default"} turn(s) · ${profile.contextMessageLimit ?? "default"} context msg(s)`,
    `langfuse:      ${langfuseSummary(profile, langfuseKeysStored)}`,
    `login:         ${loggedIn ? "OAuth credential stored" : "MISSING — deploy will refuse"}`,
    `identity:      ${profile.agentPubkey ?? "(bound at first deploy from Buzz)"}`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* kubectl probes                                                             */
/* -------------------------------------------------------------------------- */

async function listKubeContexts(): Promise<{ contexts: string[]; current: string | null }> {
  // `config` subcommands ignore --namespace; the wrapper adds it harmlessly
  // and brings the augmented PATH that finds Homebrew kubectl from a GUI shell.
  try {
    const list = await kubectl(["config", "get-contexts", "-o", "name"], {
      context: null,
      namespace: "default",
      timeoutMs: 10_000,
    });
    const contexts =
      list.code === 0
        ? list.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
    const current = await kubectl(["config", "current-context"], {
      context: null,
      namespace: "default",
      timeoutMs: 10_000,
    });
    return { contexts, current: current.code === 0 ? current.stdout.trim() || null : null };
  } catch {
    return { contexts: [], current: null };
  }
}

async function probeProfile(profile: DeployProfile): Promise<string> {
  if (profile.agentPubkey === null) return "not deployed";
  try {
    const pod = await getJson("pod", podName(profile.agentPubkey), {
      context: profile.kubeContext,
      namespace: profile.namespace,
      timeoutMs: 20_000,
    });
    if (pod === null) return "no Pod in the cluster (stopped or reaped)";
    const verdict = podVerdict(pod);
    if (verdict.state === "running") return "Pod running";
    if (verdict.state === "failed") return `Pod failed: ${verdict.reason}`;
    return `Pod pending${verdict.reason ? `: ${verdict.reason}` : ""}`;
  } catch (error) {
    return `probe failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Wizard                                                                     */
/* -------------------------------------------------------------------------- */

interface ProfileParams {
  kubeContext: string | null;
  namespace: string;
  image: string;
  storageClass: string | null;
  storageSize: string;
  inactivitySeconds: number;
  extensions: string[];
}

const DEFAULT_PARAMS: ProfileParams = {
  kubeContext: null,
  namespace: DEFAULT_NAMESPACE,
  image: DEFAULT_IMAGE,
  storageClass: null,
  storageSize: DEFAULT_STORAGE_SIZE,
  inactivitySeconds: DEFAULT_INACTIVITY_SECONDS,
  extensions: [],
};

/**
 * The substrate parameter steps, shared by create and edit. Every step
 * accepts Enter for the default; the kube context is a picker over the
 * ambient kubeconfig. Agent-behaviour settings (model, effort, prompt, …)
 * live in `promptAgentSettings` — they need the profile's provider login
 * first, because the model picker only offers authorised providers.
 */
async function promptParams(initial: ProfileParams): Promise<ProfileParams | null> {
  const spinner = p.spinner();
  spinner.start("Reading kubeconfig contexts");
  const { contexts, current } = await listKubeContexts();
  spinner.stop(
    contexts.length > 0
      ? `Found ${contexts.length} kubeconfig context(s)`
      : "No kubeconfig contexts found (kubectl missing or empty config)",
  );

  let kubeContext: string | null;
  if (contexts.length > 0) {
    const currentLabel = current !== null ? `Current context (${current})` : "Current context";
    const picked = await p.select({
      message: "Kubernetes context",
      initialValue: initial.kubeContext ?? "",
      options: [
        { value: "", label: currentLabel, hint: "default" },
        ...contexts.map((context) => ({ value: context, label: context })),
      ],
    });
    if (cancelled(picked)) return null;
    kubeContext = picked === "" ? null : picked;
  } else {
    const typed = await p.text({
      message: "Kubernetes context (empty = current context)",
      initialValue: initial.kubeContext ?? "",
    });
    if (cancelled(typed)) return null;
    kubeContext = typed.trim() === "" ? null : typed.trim();
  }

  const namespace = await p.text({
    message: "Namespace",
    placeholder: initial.namespace,
    defaultValue: initial.namespace,
    validate: (value) =>
      !value || NAMESPACE_RE.test(value) ? undefined : "not a valid k8s namespace name",
  });
  if (cancelled(namespace)) return null;

  const image = await p.text({
    message: "Agent image (tag or name@sha256:…)",
    placeholder: initial.image,
    defaultValue: initial.image,
  });
  if (cancelled(image)) return null;

  const extensions = await p.text({
    message: "Pi extensions, comma-separated (npm:… / git:… / path; empty = none)",
    placeholder: "npm:@wierdbytes/pi-anthropic",
    initialValue: initial.extensions.join(", "),
  });
  if (cancelled(extensions)) return null;

  const storageClass = await p.text({
    message: "StorageClass for the agent PVC",
    placeholder: initial.storageClass ?? "cluster default",
    initialValue: initial.storageClass ?? "",
  });
  if (cancelled(storageClass)) return null;

  const storageSize = await p.text({
    message: "PVC size",
    placeholder: initial.storageSize,
    defaultValue: initial.storageSize,
    validate: (value) =>
      !value || QUANTITY_RE.test(value) ? undefined : "must look like 2Gi / 512Mi",
  });
  if (cancelled(storageSize)) return null;

  const inactivity = await p.text({
    message: "Idle timeout in seconds (0 = run indefinitely)",
    placeholder: String(initial.inactivitySeconds),
    defaultValue: String(initial.inactivitySeconds),
    validate: (value) => {
      if (!value) return undefined;
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= 0 ? undefined : "non-negative integer required";
    },
  });
  if (cancelled(inactivity)) return null;

  return {
    kubeContext,
    namespace: namespace.trim(),
    image: image.trim(),
    storageClass: storageClass.trim() === "" ? null : storageClass.trim(),
    storageSize: storageSize.trim(),
    inactivitySeconds: Number(inactivity),
    extensions: extensions
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  };
}

const RESPOND_TO_OPTIONS: readonly { value: RespondToMode; label: string; hint: string }[] = [
  { value: "owner-only", label: "Owner only", hint: "default" },
  { value: "allowlist", label: "Allowlist", hint: "owner + listed pubkeys" },
  { value: "anyone", label: "Anyone", hint: "any relay member" },
  { value: "nobody", label: "Nobody", hint: "mute the agent" },
];

const PUBKEY_RE = /^[0-9a-f]{64}$/;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Optional positive integer: empty = runtime default. */
async function promptCount(
  message: string,
  initial: number | null,
): Promise<number | null | undefined> {
  const typed = await p.text({
    message,
    placeholder: "runtime default",
    initialValue: initial === null ? "" : String(initial),
    validate: (value) => {
      if (!value || value.trim() === "") return undefined;
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= 1 ? undefined : "positive integer or empty";
    },
  });
  if (cancelled(typed)) return undefined;
  return typed.trim() === "" ? null : Number(typed);
}

/**
 * The agent-behaviour steps: model and effort first — offered *only* for
 * providers whose login is stored in this profile's auth.json, because those
 * are the only credentials the deployed Pod will ever hold — then prompt,
 * respond gate, tools and scheduler ceilings. These fields used to live in
 * Buzz Desktop's agent form; the profile is their sole source now.
 */
async function promptAgentSettings(
  name: string,
  initial: AgentSettings,
): Promise<AgentSettings | null> {
  const spinner = p.spinner();
  spinner.start("Loading models for the authorised provider(s)");
  let catalogs: AuthedProviderCatalog[];
  try {
    catalogs = await listAuthedCatalog(profileAuthPath(name));
  } catch (error) {
    spinner.stop(`model catalog failed: ${error instanceof Error ? error.message : String(error)}`);
    catalogs = [];
  }
  const models = catalogs.flatMap((catalog) =>
    catalog.models.map((model) => ({ catalog, model })),
  );
  spinner.stop(
    models.length > 0
      ? `${models.length} model(s) from ${catalogs.length} authorised provider(s)`
      : "No models available — no authorised provider credentials found",
  );

  let model = initial.model;
  let thinking = initial.thinking;
  if (models.length > 0) {
    const picked = await p.select({
      message: "Model",
      initialValue: initial.model ?? "",
      options: [
        { value: "", label: "Pi default", hint: "let the runtime pick" },
        ...models.map(({ catalog, model: entry }) => ({
          value: entry.ref,
          label: `${catalog.providerName} · ${entry.name}`,
          hint: entry.reasoning ? "reasoning" : undefined,
        })),
      ],
    });
    if (cancelled(picked)) return null;
    model = picked === "" ? null : picked;

    const chosen = models.find(({ model: entry }) => entry.ref === model)?.model;
    if (chosen && chosen.reasoning && chosen.thinkingLevels.length > 0) {
      const effort = await p.select({
        message: "Reasoning effort",
        initialValue:
          initial.thinking !== null && chosen.thinkingLevels.includes(initial.thinking as never)
            ? initial.thinking
            : "",
        options: [
          { value: "", label: "Model default" },
          ...chosen.thinkingLevels.map((level) => ({ value: level, label: level })),
        ],
      });
      if (cancelled(effort)) return null;
      thinking = effort === "" ? null : effort;
    } else {
      thinking = null;
    }
  } else {
    p.log.warn(
      "Keeping the stored model setting — run the login step to pick from authorised providers",
    );
  }

  const systemPrompt = await p.text({
    message: "Extra system prompt (empty = none)",
    initialValue: initial.systemPrompt ?? "",
  });
  if (cancelled(systemPrompt)) return null;

  const respondTo = await p.select({
    message: "Respond to",
    initialValue: initial.respondTo,
    options: [...RESPOND_TO_OPTIONS],
  });
  if (cancelled(respondTo)) return null;

  let respondToAllowlist = initial.respondToAllowlist;
  if (respondTo === "allowlist") {
    const allowlist = await p.text({
      message: "Allowlist — comma-separated hex pubkeys",
      initialValue: initial.respondToAllowlist.join(", "),
      validate: (value) => {
        const bad = splitList(value ?? "").find((item) => !PUBKEY_RE.test(item));
        return bad === undefined ? undefined : `${bad.slice(0, 16)}… is not a 64-hex pubkey`;
      },
    });
    if (cancelled(allowlist)) return null;
    respondToAllowlist = splitList(allowlist);
  }

  const toolsInclude = await p.text({
    message: "Tool allowlist, comma-separated (empty = pi default set)",
    initialValue: initial.toolsInclude.join(", "),
  });
  if (cancelled(toolsInclude)) return null;

  const toolsExclude = await p.text({
    message: "Tool denylist, comma-separated (empty = none)",
    initialValue: initial.toolsExclude.join(", "),
  });
  if (cancelled(toolsExclude)) return null;

  const maxConcurrentTurns = await promptCount("Max concurrent turns", initial.maxConcurrentTurns);
  if (maxConcurrentTurns === undefined) return null;

  const contextMessageLimit = await promptCount(
    "Context messages fetched per turn",
    initial.contextMessageLimit,
  );
  if (contextMessageLimit === undefined) return null;

  const base = {
    model,
    thinking,
    systemPrompt: systemPrompt.trim() === "" ? null : systemPrompt,
    respondTo,
    respondToAllowlist,
    toolsInclude: splitList(toolsInclude),
    toolsExclude: splitList(toolsExclude),
    maxConcurrentTurns,
    contextMessageLimit,
  };

  const langfuse = await promptLangfuse(name, initial);
  if (langfuse === null) return null;

  return { ...base, ...langfuse };
}

const LANGFUSE_PRIVACY_OPTIONS: readonly { value: string; label: string; hint: string }[] = [
  {
    value: "metadata-only",
    label: "metadata-only",
    hint: "usage, cost, timings, tool names only",
  },
  { value: "conversations", label: "conversations", hint: "+ prompts and reply text (default)" },
  { value: "full", label: "full", hint: "+ thinking, tool I/O, system prompt" },
];

type LangfuseSettings = Pick<
  AgentSettings,
  "langfuseEnabled" | "langfuseHost" | "langfusePrivacy" | "langfuseSampleRate"
>;

/**
 * The Langfuse steps (tracing plan §5.3, §6). The settings travel in the core
 * config record; the API keys do not — they are stored next to the profile's
 * `auth.json` and published as their own record at deploy, which is why this
 * step writes them as a side effect instead of returning them.
 */
async function promptLangfuse(
  name: string,
  initial: AgentSettings,
): Promise<LangfuseSettings | null> {
  const enabled = await p.confirm({
    message: "Send traces to Langfuse?",
    initialValue: initial.langfuseEnabled,
  });
  if (cancelled(enabled)) return null;
  // Turning tracing off keeps host/privacy/sample as they were: re-enabling it
  // later should not start from scratch.
  if (!enabled) {
    return {
      langfuseEnabled: false,
      langfuseHost: initial.langfuseHost,
      langfusePrivacy: initial.langfusePrivacy,
      langfuseSampleRate: initial.langfuseSampleRate,
    };
  }

  const host = await p.text({
    message: "Langfuse host (empty = Langfuse Cloud)",
    placeholder: "https://cloud.langfuse.com",
    initialValue: initial.langfuseHost ?? "",
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (trimmed === "") return undefined;
      return /^https?:\/\/\S+$/.test(trimmed) ? undefined : "must be an http(s):// URL";
    },
  });
  if (cancelled(host)) return null;

  const privacy = await p.select({
    message: "Trace privacy preset",
    initialValue: initial.langfusePrivacy ?? "",
    options: [
      { value: "", label: "Runtime default", hint: "conversations" },
      ...LANGFUSE_PRIVACY_OPTIONS,
    ],
  });
  if (cancelled(privacy)) return null;

  const sample = await p.text({
    message: "Turn sampling rate 0..1 (empty = 1, trace everything)",
    placeholder: "1",
    initialValue: initial.langfuseSampleRate === null ? "" : String(initial.langfuseSampleRate),
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (trimmed === "") return undefined;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
        ? undefined
        : "a number between 0 and 1, or empty";
    },
  });
  if (cancelled(sample)) return null;

  if (!(await promptLangfuseKeys(name))) return null;

  return {
    langfuseEnabled: true,
    langfuseHost: host.trim() === "" ? null : host.trim(),
    langfusePrivacy: privacy === "" ? null : (privacy as LangfusePrivacyPreset),
    langfuseSampleRate: sample.trim() === "" ? null : Number(sample.trim()),
  };
}

/** Captures/keeps the profile's Langfuse API keys. False = cancelled. */
async function promptLangfuseKeys(name: string): Promise<boolean> {
  const existing = await readProfileLangfuseKeys(name);
  if (existing !== null) {
    const replace = await p.confirm({
      message: "Replace stored Langfuse API keys?",
      initialValue: false,
    });
    if (cancelled(replace)) return false;
    if (!replace) return true;
  }

  const publicKey = await p.text({
    message: "Langfuse public key",
    placeholder: "pk-lf-…",
    validate: (value) => ((value ?? "").trim() === "" ? "required (usually pk-lf-…)" : undefined),
  });
  if (cancelled(publicKey)) return false;

  const secretKey = await p.password({
    message: "Langfuse secret key",
    validate: (value) => ((value ?? "").trim() === "" ? "required (usually sk-lf-…)" : undefined),
  });
  if (cancelled(secretKey)) return false;

  await writeProfileLangfuseKeys(name, {
    publicKey: publicKey.trim(),
    secretKey: secretKey.trim(),
  });
  p.log.success("Langfuse keys stored for this profile");
  return true;
}

/**
 * Runs the mandatory provider-login step: pick any provider pi supports
 * (OAuth or API key), then run its interactive flow. Returns false when it
 * did not complete.
 */
async function loginStep(name: string): Promise<boolean> {
  p.log.step("Sign in to a model provider — this credential powers the agent's model access");
  const authPath = await ensureProfileAuthDir(name);
  try {
    const choices = await listLoginChoices(authPath);
    const choice = await p.select({
      message: "Model provider",
      options: choices.map((item) => ({
        value: item,
        label: item.label,
        hint: item.type === "oauth" ? "OAuth" : "API key",
      })),
    });
    if (cancelled(choice)) return false;
    await runProviderLogin(authPath, choice.providerId, choice.type);
    p.log.success("Login complete — credential stored for this profile");
    return true;
  } catch (error) {
    p.log.error(`login failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function createWizard(existing: DeployProfile[]): Promise<void> {
  const taken = new Set(existing.map((profile) => profile.name));
  const name = await p.text({
    message: "Agent profile name",
    placeholder: "my-agent",
    validate: (value) => {
      if (!value || !PROFILE_NAME_RE.test(value)) {
        return "lowercase letters, digits and dashes (max 40)";
      }
      if (taken.has(value)) return "a profile with this name already exists";
      return undefined;
    },
  });
  if (cancelled(name)) return;

  const params = await promptParams(DEFAULT_PARAMS);
  if (params === null) return;

  const substrate = {
    name,
    createdAt: Date.now(),
    ...params,
    ...DEFAULT_AGENT_SETTINGS,
    agentPubkey: null,
    lastDeployedAt: null,
  } satisfies DeployProfile;

  // Validate the substrate through the deploy-time parser before login, so
  // a bad image reference fails here and not after the OAuth dance.
  try {
    providerConfigFromProfile(substrate);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return;
  }

  // Login is strictly mandatory — and it runs *before* the agent settings,
  // because the model/effort pickers only offer authorised providers.
  if (!(await loginStep(name))) {
    p.log.warn("Profile was NOT created — the login step is mandatory");
    return;
  }

  const settings = await promptAgentSettings(name, DEFAULT_AGENT_SETTINGS);
  if (settings === null) {
    // Do not orphan the freshly captured credential of an unsaved profile.
    await rm(dirname(profileAuthPath(name)), { recursive: true, force: true });
    p.log.warn("Profile was NOT created — agent settings were not completed");
    return;
  }

  await saveProfile({ ...substrate, ...settings });
  p.note(
    `In Buzz Desktop, add an agent with the 'autogent-k8s' backend provider\n` +
      `and pick the profile '${name}' — that is the only provider setting left there.\n` +
      `Model, effort and the rest of the agent settings live in this profile.`,
    `Profile '${name}' created`,
  );
}

/* -------------------------------------------------------------------------- */
/* Per-profile menu                                                           */
/* -------------------------------------------------------------------------- */

async function profileMenu(name: string): Promise<void> {
  for (;;) {
    const profile = (await readProfiles()).find((candidate) => candidate.name === name);
    if (!profile) return;
    const loggedIn = await hasLogin(profile);
    const langfuseKeys = (await readProfileLangfuseKeys(profile.name)) !== null;
    p.note(profileDetails(profile, loggedIn, langfuseKeys), `Profile '${profile.name}'`);

    const action = await p.select({
      message: "Action",
      options: [
        ...(profile.agentPubkey !== null
          ? [
              { value: "status", label: "Check live status in the cluster (kubectl)" },
              { value: "logs", label: "Show pod logs" },
              {
                value: "redeploy",
                label: "Redeploy (publish config to relay, roll out a new Pod)",
              },
              { value: "kill", label: "Kill Pod (stop the agent; Redeploy brings it back)" },
            ]
          : []),
        { value: "edit", label: "Edit substrate parameters (cluster, image, storage)" },
        { value: "agent", label: "Edit agent settings (model, effort, prompt, …)" },
        { value: "login", label: loggedIn ? "Re-run OAuth login" : "Run OAuth login (missing!)" },
        { value: "delete", label: "Delete profile" },
        { value: "back", label: "Back" },
      ],
    });
    if (cancelled(action) || action === "back") return;

    if (action === "status") {
      const spinner = p.spinner();
      spinner.start("Probing the cluster");
      const status = await probeProfile(profile);
      spinner.stop(status);
      continue;
    }

    if (action === "logs") {
      const spinner = p.spinner();
      spinner.start("Fetching pod logs");
      try {
        const result = await kubectl(
          ["logs", podName(profile.agentPubkey!), `--tail=${LOG_TAIL_LINES}`],
          { context: profile.kubeContext, namespace: profile.namespace, timeoutMs: 30_000 },
        );
        if (result.code !== 0) {
          spinner.stop(`kubectl logs failed: ${result.stderr.split("\n", 1)[0]?.trim() ?? "unknown error"}`);
          continue;
        }
        spinner.stop(`Pod logs (last ${LOG_TAIL_LINES} lines)`);
        const text = result.stdout.trimEnd();
        p.note(text.length > 0 ? text : "(no log output)", `kubectl logs ${podName(profile.agentPubkey!)}`);
      } catch (error) {
        spinner.stop(`log fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    if (action === "kill") {
      const pod = podName(profile.agentPubkey!);
      const sure = await p.confirm({
        message:
          `Kill Pod '${pod}' now? The agent stops; the profile, its config records ` +
          `and credentials are kept, so 'Redeploy' (or a deploy from Buzz) starts it again.`,
        initialValue: false,
      });
      if (cancelled(sure) || !sure) continue;
      const spinner = p.spinner();
      spinner.start("Deleting the Pod");
      try {
        await deleteAndWait("pod", pod, {
          context: profile.kubeContext,
          namespace: profile.namespace,
        });
        spinner.stop(`Pod '${pod}' deleted — the agent is stopped`);
      } catch (error) {
        spinner.stop(`kill failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    if (action === "redeploy") {
      const sure = await p.confirm({
        message:
          "Redeploy now? The config records are republished and the running Pod is " +
          "replaced — a moved image tag is re-resolved to its current digest.",
        initialValue: true,
      });
      if (cancelled(sure) || !sure) continue;
      const spinner = p.spinner();
      spinner.start("Redeploying");
      try {
        const outcome = await redeployProfile({
          profile,
          report: (message) => spinner.message(message),
        });
        spinner.stop(`Redeployed — Pod running (generation ${outcome.generation})`);
      } catch (error) {
        spinner.stop(
          `redeploy failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    if (action === "edit") {
      const params = await promptParams(profile);
      if (params === null) continue;
      try {
        providerConfigFromProfile({ ...profile, ...params });
      } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        continue;
      }
      await saveProfile({ ...profile, ...params });
      p.log.success(
        profile.agentPubkey !== null
          ? "Saved — takes effect on the next deploy from Buzz"
          : "Saved",
      );
      continue;
    }

    if (action === "agent") {
      if (!loggedIn) {
        p.log.warn("Run the login step first — the model picker only offers authorised providers");
        continue;
      }
      const settings = await promptAgentSettings(profile.name, profile);
      if (settings === null) continue;
      await saveProfile({ ...profile, ...settings });
      p.log.success(
        profile.agentPubkey !== null
          ? "Saved — takes effect on the next deploy from Buzz"
          : "Saved",
      );
      continue;
    }

    if (action === "login") {
      await loginStep(profile.name);
      continue;
    }

    if (action === "delete") {
      const sure = await p.confirm({
        message:
          profile.agentPubkey !== null
            ? `Delete '${profile.name}'? A running Pod is NOT stopped (use !shutdown over the relay).`
            : `Delete '${profile.name}'?`,
        initialValue: false,
      });
      if (cancelled(sure) || !sure) continue;
      await removeProfile(profile.name);
      p.log.success(`Profile '${profile.name}' deleted`);
      return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

async function refreshStatuses(profiles: DeployProfile[]): Promise<void> {
  const spinner = p.spinner();
  spinner.start("Probing the cluster(s)");
  const lines: string[] = [];
  for (const profile of profiles) {
    lines.push(`${profile.name.padEnd(20)} ${await probeProfile(profile)}`);
  }
  spinner.stop("Live status");
  p.note(lines.join("\n"), "Cluster status");
}

async function mainMenu(): Promise<void> {
  p.intro("autogent — agent registry");
  for (;;) {
    const profiles = await readProfiles();
    const logins = await Promise.all(profiles.map((profile) => hasLogin(profile)));

    const choice = await p.select({
      message:
        profiles.length > 0 ? "Agents in the registry" : "The registry is empty — create an agent",
      options: [
        ...profiles.map((profile, index) => ({
          value: `profile:${profile.name}`,
          label: profile.name,
          hint: deployedHint(profile, logins[index] ?? false),
        })),
        { value: "create", label: "➕ Create a new agent" },
        ...(profiles.some((profile) => profile.agentPubkey !== null)
          ? [{ value: "refresh", label: "↻ Check live status (kubectl)" }]
          : []),
        { value: "quit", label: "Quit" },
      ],
    });
    if (cancelled(choice) || choice === "quit") break;
    if (choice === "create") await createWizard(profiles);
    else if (choice === "refresh") await refreshStatuses(profiles);
    else await profileMenu(choice.slice("profile:".length));
  }
  p.outro("done");
}

async function printList(): Promise<number> {
  const profiles = await readProfiles();
  if (profiles.length === 0) {
    process.stdout.write("registry is empty — run `autogent` interactively to create an agent\n");
    return 0;
  }
  for (const profile of profiles) {
    const loggedIn = await hasLogin(profile);
    process.stdout.write(`${profile.name}\t${deployedHint(profile, loggedIn)}\n`);
  }
  return 0;
}

const USAGE = `autogent — interactive agent registry for the Buzz autogent-k8s provider

Usage:
  autogent          interactive mode: list agents, create/edit/delete profiles
  autogent list     print the registry non-interactively
  autogent --help   this text

Agents are configured here — the substrate (kube context, namespace, image,
pi extensions, storage, idle timeout), the mandatory pi provider login and
the agent settings (model, reasoning effort, system prompt, respond gate,
tools, scheduler ceilings, Langfuse tracing with its privacy preset and API
keys; model/effort offer only providers with a stored login) — and then
selected in Buzz Desktop's provider form, which exposes only the profile
drop-down.
`;

export async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === "list") return printList();
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command !== undefined) {
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("not a TTY — interactive mode needs a terminal; try `autogent list`\n");
    return 2;
  }
  await mainMenu();
  return 0;
}

function invokedDirectly(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
