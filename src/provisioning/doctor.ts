/**
 * `autogent-nostr doctor` — pre-flight diagnosis (plan §4).
 *
 * Every check is independent and cannot throw out of the run: an operator with a
 * half-provisioned host needs the *whole* list of problems, not the first one.
 * All host access goes through {@link DoctorFacade} so the check logic can be
 * driven from a fixture without a real state directory.
 */

import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../config.js";
import { validateConfig } from "../config.js";
import { kindsNotCovered, verifyAttestation } from "../nostr/nip-oa.js";
import { AGENT_PUBLISHED_KINDS } from "../nostr/types.js";
import type { IdentityRecord, IdentityStore } from "./identity-store.js";
import { SECRET_FILE_MODE, STATE_DIR_MODE } from "./identity-store.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Metadata a permission check needs, normalised away from `fs.Stats`. */
export interface PathFacts {
  exists: boolean;
  isDirectory: boolean;
  /** POSIX permission bits only, i.e. `mode & 0o777`. */
  mode: number;
}

export interface DoctorFacade {
  stateDir: string;
  /** Null when the backend has no filesystem presence (keychain, broker). */
  secretPath: string | null;
  secretBackendDescription: string;
  recordPath: string;
  /** `win32` disables POSIX mode assertions. */
  platform: string;
  now(): number;
  statPath(path: string): Promise<PathFacts>;
  readRecord(): Promise<IdentityRecord | null>;
  /** Resolves to the agent pubkey, proving the sealed secret is loadable. */
  loadAgentPubkey(): Promise<string>;
  probePiSdk(): Promise<{ ok: boolean; detail: string }>;
  probePiAuth(): Promise<{ ok: boolean; detail: string }>;
}

/* -------------------------------------------------------------------------- */
/* Real facade                                                                */
/* -------------------------------------------------------------------------- */

async function statPathReal(path: string): Promise<PathFacts> {
  try {
    const facts = await stat(path);
    return { exists: true, isDirectory: facts.isDirectory(), mode: facts.mode & 0o777 };
  } catch {
    return { exists: false, isDirectory: false, mode: 0 };
  }
}

export interface DoctorFacadeOptions {
  store: IdentityStore;
  /** Pi's agent directory; defaults to `PiConfig.agentDir` or `~/.pi/agent`. */
  agentDir?: string;
}

export function createDoctorFacade(options: DoctorFacadeOptions): DoctorFacade {
  const { store } = options;
  const agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
  return {
    stateDir: store.stateDir,
    secretPath: store.backend.location,
    secretBackendDescription: store.backend.description,
    recordPath: store.recordPath,
    platform: process.platform,
    now: () => Date.now(),
    statPath: statPathReal,
    readRecord: () => store.readRecord(),
    loadAgentPubkey: async () => (await store.loadSigner()).publicKey,
    probePiSdk: async () => {
      try {
        await import("@earendil-works/pi-coding-agent");
        return { ok: true, detail: "@earendil-works/pi-coding-agent is importable" };
      } catch (error) {
        return { ok: false, detail: `cannot import the Pi SDK: ${(error as Error).message}` };
      }
    },
    probePiAuth: async () => {
      const authFile = join(agentDir, "auth.json");
      try {
        await access(authFile);
        return { ok: true, detail: `provider credentials found at ${authFile}` };
      } catch {
        return {
          ok: false,
          detail: `no ${authFile} — run 'pi' once to authenticate, or set provider credentials`,
        };
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): CheckResult => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: "fail", detail });

const octal = (mode: number): string => `0${mode.toString(8).padStart(3, "0")}`;

async function checkStateDir(facade: DoctorFacade): Promise<CheckResult> {
  const name = "state-dir";
  const facts = await facade.statPath(facade.stateDir);
  if (!facts.exists) {
    return fail(name, `${facade.stateDir} does not exist — run 'autogent-nostr init'`);
  }
  if (!facts.isDirectory) return fail(name, `${facade.stateDir} is not a directory`);
  if (facade.platform === "win32") {
    return warn(name, `${facade.stateDir} exists; POSIX mode bits are not enforced on win32`);
  }
  if ((facts.mode & 0o077) !== 0) {
    return fail(
      name,
      `${facade.stateDir} is mode ${octal(facts.mode)}; it must be ${octal(STATE_DIR_MODE)} so no other local account can read the sealed secret`,
    );
  }
  return ok(name, `${facade.stateDir} is mode ${octal(facts.mode)}`);
}

async function checkSecretPermissions(facade: DoctorFacade): Promise<CheckResult> {
  const name = "secret-permissions";
  if (facade.secretPath === null) {
    return ok(name, `secret held by an external backend: ${facade.secretBackendDescription}`);
  }
  const facts = await facade.statPath(facade.secretPath);
  if (!facts.exists) {
    return fail(name, `${facade.secretPath} is missing — run 'autogent-nostr init'`);
  }
  if (facade.platform === "win32") {
    return warn(name, `${facade.secretPath} exists; POSIX mode bits are not enforced on win32`);
  }
  if ((facts.mode & 0o077) !== 0) {
    return fail(
      name,
      `${facade.secretPath} is mode ${octal(facts.mode)} and readable beyond its owner; run chmod ${octal(SECRET_FILE_MODE)} and rotate the key, it must be assumed compromised`,
    );
  }
  if (facts.mode !== SECRET_FILE_MODE) {
    return warn(
      name,
      `${facade.secretPath} is mode ${octal(facts.mode)}; ${octal(SECRET_FILE_MODE)} is expected`,
    );
  }
  return ok(name, `${facade.secretPath} is mode ${octal(facts.mode)}`);
}

async function checkIdentity(facade: DoctorFacade): Promise<CheckResult> {
  const name = "identity";
  const record = await facade.readRecord();
  if (!record) return fail(name, `no identity record at ${facade.recordPath}`);
  const pubkey = await facade.loadAgentPubkey();
  if (pubkey !== record.agentPubkey) {
    return fail(
      name,
      `the sealed secret yields ${pubkey} but the record names ${record.agentPubkey} — the state directory is inconsistent`,
    );
  }
  return ok(name, `agent pubkey ${pubkey}`);
}

async function checkAttestation(facade: DoctorFacade): Promise<CheckResult> {
  const name = "attestation";
  const record = await facade.readRecord();
  if (!record) return fail(name, "no identity record; nothing to attest");
  if (!record.auth || !record.ownerPubkey) {
    return fail(name, "not provisioned — run 'autogent-nostr provision import <attestation.json>'");
  }
  if (record.auth.ownerPubkey !== record.ownerPubkey) {
    return fail(name, "the stored owner pubkey disagrees with the stored auth tag");
  }
  if (!verifyAttestation(record.auth, record.agentPubkey)) {
    return fail(name, "the stored NIP-OA signature does not verify against the agent pubkey");
  }
  return ok(name, `attested by owner ${record.ownerPubkey}`);
}

async function checkConditions(facade: DoctorFacade): Promise<CheckResult> {
  const name = "attestation-conditions";
  const record = await facade.readRecord();
  if (!record?.auth) return fail(name, "not provisioned; no conditions to evaluate");
  const uncovered = kindsNotCovered(
    record.auth.conditions,
    AGENT_PUBLISHED_KINDS,
    Math.floor(facade.now() / 1000),
  );
  if (uncovered.length > 0) {
    return fail(
      name,
      `conditions '${record.auth.conditions}' block kind(s) ${uncovered.join(", ")}; re-attest with empty conditions`,
    );
  }
  return ok(
    name,
    record.auth.conditions === ""
      ? "unconstrained conditions cover every published kind"
      : `conditions '${record.auth.conditions}' cover every published kind`,
  );
}

function checkConfig(config: AgentConfig): CheckResult {
  const name = "config";
  const problems = validateConfig(config);
  return problems.length === 0
    ? ok(name, "configuration is valid")
    : fail(name, problems.join("; "));
}

function checkRelayUrl(config: AgentConfig): CheckResult {
  const name = "relay-url";
  let url: URL;
  try {
    url = new URL(config.relayUrl);
  } catch {
    return fail(name, `${config.relayUrl} is not a parseable URL`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return fail(name, `${config.relayUrl} must use the ws:// or wss:// scheme`);
  }
  if (url.protocol === "ws:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return warn(
      name,
      `${config.relayUrl} is unencrypted; NIP-42 credentials and event traffic are readable in transit`,
    );
  }
  return ok(name, `${config.relayUrl} is well-formed`);
}

async function checkPiSdk(facade: DoctorFacade): Promise<CheckResult> {
  const probe = await facade.probePiSdk();
  return probe.ok ? ok("pi-sdk", probe.detail) : fail("pi-sdk", probe.detail);
}

async function checkPiAuth(facade: DoctorFacade): Promise<CheckResult> {
  const probe = await facade.probePiAuth();
  return probe.ok ? ok("pi-auth", probe.detail) : fail("pi-auth", probe.detail);
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs every check. A check that throws becomes a `fail` row rather than
 * aborting the run, so one broken file cannot hide the rest of the report.
 */
export async function runDoctor(
  config: AgentConfig,
  facade: DoctorFacade,
): Promise<CheckResult[]> {
  const checks: Array<[string, () => Promise<CheckResult> | CheckResult]> = [
    ["state-dir", () => checkStateDir(facade)],
    ["secret-permissions", () => checkSecretPermissions(facade)],
    ["identity", () => checkIdentity(facade)],
    ["attestation", () => checkAttestation(facade)],
    ["attestation-conditions", () => checkConditions(facade)],
    ["config", () => checkConfig(config)],
    ["relay-url", () => checkRelayUrl(config)],
    ["pi-sdk", () => checkPiSdk(facade)],
    ["pi-auth", () => checkPiAuth(facade)],
  ];

  const results: CheckResult[] = [];
  for (const [name, run] of checks) {
    try {
      results.push(await run());
    } catch (error) {
      results.push(fail(name, (error as Error).message));
    }
  }
  return results;
}

/** Non-zero when any check failed. Warnings alone keep the exit status clean. */
export function doctorExitCode(results: readonly CheckResult[]): number {
  return results.some((result) => result.status === "fail") ? 1 : 0;
}

export function formatDoctorReport(results: readonly CheckResult[]): string {
  const marker: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  return results.map((r) => `[${marker[r.status]}] ${r.name}: ${r.detail}`).join("\n");
}
