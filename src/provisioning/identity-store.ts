/**
 * The sealed local identity store (plan §4.1, §10.1).
 *
 * Everything the agent knows about *who it is* lives here: the secret key, the
 * pairing request it issued, the owner pubkey and the canonical NIP-OA `auth`
 * tag. The secret is reachable only as a {@link Signer}; no code path returns
 * the raw bytes, so a leaked config dump or a `JSON.stringify` of the store
 * cannot carry key material.
 *
 * ## Known limitation
 *
 * The file backend keeps the secret **at rest in a mode-0600 file**. That
 * protects it from other local users but not from anything running as the agent
 * user, and not from a host backup that copies the state directory. Plan §10.1
 * names OS keychain, an inherited sealed file descriptor, or a separate signer
 * broker as the production answer; {@link SecretBackend} exists so one of those
 * can be dropped in without touching the provisioning commands. Decoding also
 * passes through an immutable JS string that cannot be wiped, so the secret may
 * survive in the heap until GC.
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthTag } from "../nostr/nip-oa.js";
import type { Signer } from "../nostr/signer.js";
import { createSigner, decodeSecretKey, isPubkey } from "../nostr/signer.js";

/** Owner-only directory. Anything looser lets another local account read the key. */
export const STATE_DIR_MODE = 0o700;
/** Owner-only file. Doctor fails the host when the real mode is wider. */
export const SECRET_FILE_MODE = 0o600;
/** The pairing request carries no secrets and is meant to be copied to the owner. */
export const PUBLIC_ARTIFACT_MODE = 0o644;

export const SECRET_FILE_NAME = "agent.key";
export const IDENTITY_FILE_NAME = "identity.json";
export const PAIRING_REQUEST_FILE_NAME = "pairing-request.json";

export type ProvisioningErrorCode =
  | "identity-exists"
  | "identity-missing"
  | "secret-missing"
  | "secret-source"
  | "invalid-pairing-request"
  | "invalid-attestation"
  | "signature-invalid"
  | "pubkey-mismatch"
  | "self-attestation"
  | "nonce-mismatch"
  | "relay-mismatch"
  | "conditions-incomplete"
  | "invalid-args"
  | "publish-rejected";

/** Carries a stable `code` so the CLI can pick an exit status without regexing prose. */
export class ProvisioningError extends Error {
  readonly code: ProvisioningErrorCode;

  constructor(code: ProvisioningErrorCode, message: string) {
    super(message);
    this.name = "ProvisioningError";
    this.code = code;
  }
}

export interface AgentProfile {
  name: string;
  about: string;
  picture?: string;
}

/** The secret-free artifact handed to the owner (plan §4.1). */
export interface PairingRequest {
  version: 1;
  agentPubkey: string;
  relayUrl: string;
  profile: AgentProfile;
  nonce: string;
}

export interface IdentityRecord {
  version: 1;
  agentPubkey: string;
  createdAt: number;
  /**
   * The pairing request this host issued. Kept so `provision import` can prove
   * the attestation answers *our* request and not a replayed one.
   */
  pairing: PairingRequest;
  /** Null until `provision import` succeeds. */
  ownerPubkey: string | null;
  /** Canonical NIP-OA attestation, null until provisioned. */
  auth: AuthTag | null;
  provisionedAt: number | null;
}

/* -------------------------------------------------------------------------- */
/* Secret backends                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where the agent secret physically lives.
 *
 * The only operation that touches key material is {@link SecretBackend.loadSigner},
 * and it hands back a {@link Signer} rather than bytes. A keychain or remote
 * broker implementation satisfies the same contract without ever materialising
 * the key on disk.
 */
export interface SecretBackend {
  /** Stable id for diagnostics, e.g. `file`. */
  readonly id: string;
  /** One-line description for `doctor` output. */
  readonly description: string;
  /** Filesystem path when the backend has one, else null (keychain, broker). */
  readonly location: string | null;
  exists(): Promise<boolean>;
  /** Writes the secret. Refuses to clobber an existing one unless `replace`. */
  seal(secret: Uint8Array, replace?: boolean): Promise<void>;
  loadSigner(): Promise<Signer>;
}

async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp`;
  // The explicit chmod defeats a permissive umask, which `writeFile`'s mode honours.
  await writeFile(temporary, data, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export class FileSecretBackend implements SecretBackend {
  readonly id = "file";
  readonly description = "sealed file (mode 0600) in the state directory";
  readonly location: string;

  constructor(path: string) {
    this.location = path;
  }

  async exists(): Promise<boolean> {
    try {
      await stat(this.location);
      return true;
    } catch {
      return false;
    }
  }

  async seal(secret: Uint8Array, replace = false): Promise<void> {
    if (secret.length !== 32) throw new Error("agent secret must be 32 bytes");
    if (!replace && (await this.exists())) {
      throw new ProvisioningError(
        "identity-exists",
        `refusing to overwrite the existing agent secret at ${this.location}`,
      );
    }
    const hex = Buffer.from(secret);
    try {
      await writeFileAtomic(this.location, `${hex.toString("hex")}\n`, SECRET_FILE_MODE);
    } finally {
      hex.fill(0);
    }
  }

  async loadSigner(): Promise<Signer> {
    let raw: Buffer;
    try {
      raw = await readFile(this.location);
    } catch {
      throw new ProvisioningError(
        "secret-missing",
        `no agent secret at ${this.location} — run 'autogent-nostr init' first`,
      );
    }
    try {
      // `createSigner` takes ownership of the decoded array; only the file bytes
      // are ours to wipe.
      return createSigner(decodeSecretKey(raw.toString("utf8")));
    } finally {
      raw.fill(0);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

export interface IdentityStoreOptions {
  stateDir: string;
  backend?: SecretBackend;
}

export class IdentityStore {
  readonly stateDir: string;
  readonly recordPath: string;
  readonly pairingRequestPath: string;
  readonly backend: SecretBackend;

  constructor(options: IdentityStoreOptions) {
    this.stateDir = options.stateDir;
    this.recordPath = join(options.stateDir, IDENTITY_FILE_NAME);
    this.pairingRequestPath = join(options.stateDir, PAIRING_REQUEST_FILE_NAME);
    this.backend = options.backend ?? new FileSecretBackend(join(options.stateDir, SECRET_FILE_NAME));
  }

  async ensureStateDir(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: STATE_DIR_MODE });
    await chmod(this.stateDir, STATE_DIR_MODE);
  }

  async hasSecret(): Promise<boolean> {
    return this.backend.exists();
  }

  async sealSecret(secret: Uint8Array, replace = false): Promise<void> {
    await this.ensureStateDir();
    await this.backend.seal(secret, replace);
  }

  /** The only way to reach the key. Never returns or retains the raw bytes. */
  async loadSigner(): Promise<Signer> {
    return this.backend.loadSigner();
  }

  async readRecord(): Promise<IdentityRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.recordPath, "utf8");
    } catch {
      return null;
    }
    return parseIdentityRecord(JSON.parse(raw) as unknown);
  }

  async requireRecord(): Promise<IdentityRecord> {
    const record = await this.readRecord();
    if (!record) {
      throw new ProvisioningError(
        "identity-missing",
        `no identity at ${this.recordPath} — run 'autogent-nostr init' first`,
      );
    }
    return record;
  }

  async writeRecord(record: IdentityRecord): Promise<void> {
    await this.ensureStateDir();
    await writeFileAtomic(this.recordPath, `${JSON.stringify(record, null, 2)}\n`, SECRET_FILE_MODE);
  }

  /** Persists the pairing request next to the identity so it can be re-sent. */
  async writePairingRequest(request: PairingRequest): Promise<string> {
    await this.ensureStateDir();
    await writeFileAtomic(
      this.pairingRequestPath,
      `${JSON.stringify(request, null, 2)}\n`,
      PUBLIC_ARTIFACT_MODE,
    );
    return this.pairingRequestPath;
  }

  /** Records a verified attestation. Callers must have run every import check first. */
  async recordProvisioning(ownerPubkey: string, auth: AuthTag, at: number): Promise<IdentityRecord> {
    const record = await this.requireRecord();
    const next: IdentityRecord = { ...record, ownerPubkey, auth, provisionedAt: at };
    await this.writeRecord(next);
    return next;
  }
}

export function createIdentityStore(options: IdentityStoreOptions): IdentityStore {
  return new IdentityStore(options);
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseProfile(value: unknown): AgentProfile | null {
  const object = asObject(value);
  if (!object) return null;
  const { name, about, picture } = object;
  if (typeof name !== "string" || typeof about !== "string") return null;
  if (picture !== undefined && typeof picture !== "string") return null;
  return picture === undefined ? { name, about } : { name, about, picture };
}

/** Throws {@link ProvisioningError} rather than returning null: callers act on it. */
export function parsePairingRequest(value: unknown): PairingRequest {
  const object = asObject(value);
  const reject = (why: string): never => {
    throw new ProvisioningError("invalid-pairing-request", `pairing request ${why}`);
  };
  if (!object) return reject("must be a JSON object");
  if (object["version"] !== 1) return reject("has an unsupported version");
  const agentPubkey = object["agentPubkey"];
  if (!isPubkey(agentPubkey)) return reject("agentPubkey must be 64-char lowercase hex");
  const relayUrl = object["relayUrl"];
  if (typeof relayUrl !== "string" || !/^wss?:\/\//.test(relayUrl)) {
    return reject("relayUrl must start with ws:// or wss://");
  }
  const nonce = object["nonce"];
  if (typeof nonce !== "string" || nonce.length < 16) {
    return reject("nonce must be at least 16 characters");
  }
  const profile = parseProfile(object["profile"]);
  if (!profile) return reject("profile must carry string name and about fields");
  return { version: 1, agentPubkey, relayUrl, profile, nonce };
}

function parseAuthRecord(value: unknown): AuthTag | null {
  const object = asObject(value);
  if (!object) return null;
  const { ownerPubkey, conditions, signature } = object;
  if (!isPubkey(ownerPubkey)) return null;
  if (typeof conditions !== "string" || typeof signature !== "string") return null;
  return { ownerPubkey, conditions, signature };
}

export function parseIdentityRecord(value: unknown): IdentityRecord {
  const object = asObject(value);
  const reject = (why: string): never => {
    throw new ProvisioningError("identity-missing", `identity record ${why}`);
  };
  if (!object) return reject("must be a JSON object");
  if (object["version"] !== 1) return reject("has an unsupported version");
  const agentPubkey = object["agentPubkey"];
  if (!isPubkey(agentPubkey)) return reject("agentPubkey must be 64-char lowercase hex");
  const createdAt = object["createdAt"];
  if (typeof createdAt !== "number") return reject("createdAt must be a number");
  const pairing = parsePairingRequest(object["pairing"]);
  const ownerPubkey = object["ownerPubkey"];
  if (ownerPubkey !== null && !isPubkey(ownerPubkey)) return reject("ownerPubkey is malformed");
  const auth = object["auth"] === null ? null : parseAuthRecord(object["auth"]);
  if (object["auth"] !== null && auth === null) return reject("auth tag is malformed");
  const provisionedAt = object["provisionedAt"];
  if (provisionedAt !== null && typeof provisionedAt !== "number") {
    return reject("provisionedAt must be a number or null");
  }
  return { version: 1, agentPubkey, createdAt, pairing, ownerPubkey, auth, provisionedAt };
}
