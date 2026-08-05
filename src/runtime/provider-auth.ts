/**
 * Provider-credential materialisation and write-back (remote plan §3.2).
 *
 * The `mem/provider-auth` config record carries the byte content of a pi-compatible
 * `auth.json` (a `Record<providerId, Credential>`; multi-provider by
 * construction, resolving open question О-4). At boot the head is materialised
 * into `<stateDir>/pi-agent/auth.json` and the agent's Pi sessions are pointed
 * at that directory. When the pi SDK refreshes an OAuth token it rewrites the
 * file; a watcher picks the change up and republishes the record so a Pod
 * recreated with an empty PVC recovers the fresh token from the relay
 * (acceptance criterion 3; watcher answers open question О-3).
 *
 * Merge rule (the only one): the newer side wins by timestamp — the record
 * head's `created_at` versus the local file's recorded sync watermark — and
 * the agent immediately publishes the missing side.
 */

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./ports.js";
import { nullLogger } from "./logger.js";

/** Directory handed to the pi SDK as `agentDir`. Lives inside the sealed state dir. */
export const PI_AGENT_DIR_NAME = "pi-agent";
export const AUTH_FILE_NAME = "auth.json";
/** Sidecar recording which record head the local file corresponds to. */
const SYNC_META_FILE_NAME = "auth.record-sync.json";

export function piAgentDir(stateDir: string): string {
  return join(stateDir, PI_AGENT_DIR_NAME);
}

export function authFilePath(stateDir: string): string {
  return join(piAgentDir(stateDir), AUTH_FILE_NAME);
}

function syncMetaPath(stateDir: string): string {
  return join(piAgentDir(stateDir), SYNC_META_FILE_NAME);
}

async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, data, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

/** Rejects anything that is not a JSON object — pi would choke on it anyway. */
export function isPlausibleAuthJson(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export function digestOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface SyncMeta {
  /** `created_at` of the record head the local file was last synced with. */
  recordCreatedAt: number;
  /** SHA-256 of the synced content, to tell our own writes from pi's. */
  digest: string;
}

async function readSyncMeta(stateDir: string): Promise<SyncMeta | null> {
  try {
    const raw = JSON.parse(await readFile(syncMetaPath(stateDir), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const meta = raw as Record<string, unknown>;
    if (typeof meta["recordCreatedAt"] !== "number" || typeof meta["digest"] !== "string") return null;
    return { recordCreatedAt: meta["recordCreatedAt"], digest: meta["digest"] };
  } catch {
    return null;
  }
}

async function writeSyncMeta(stateDir: string, meta: SyncMeta): Promise<void> {
  await writeFileAtomic(syncMetaPath(stateDir), `${JSON.stringify(meta)}\n`, 0o600);
}

export async function readLocalAuth(stateDir: string): Promise<string | null> {
  try {
    return await readFile(authFilePath(stateDir), "utf8");
  } catch {
    return null;
  }
}

/** Writes `auth.json` (0600) and records the record-head watermark it came from. */
export async function materializeAuth(
  stateDir: string,
  content: string,
  recordCreatedAt: number,
): Promise<string> {
  const dir = piAgentDir(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = authFilePath(stateDir);
  await writeFileAtomic(path, content, 0o600);
  await writeSyncMeta(stateDir, { recordCreatedAt, digest: digestOf(content) });
  return path;
}

/** Records that the current local content is now represented by a record head. */
export async function recordAuthSynced(
  stateDir: string,
  content: string,
  recordCreatedAt: number,
): Promise<void> {
  await mkdir(piAgentDir(stateDir), { recursive: true, mode: 0o700 });
  await writeSyncMeta(stateDir, { recordCreatedAt, digest: digestOf(content) });
}

export type AuthReconcileResult =
  /** Local file is current; nothing to publish. */
  | { action: "none"; authPath: string }
  /** Record head written to disk. */
  | { action: "materialized"; authPath: string }
  /** Local file is newer than the head — caller must publish it. */
  | { action: "publish-local"; authPath: string; content: string }
  /** No credentials anywhere — degraded, fail-closed. */
  | { action: "missing" }
  /** Owner tombstoned the record — degraded, fail-closed. */
  | { action: "revoked" };

export interface AuthHeadView {
  /** Decrypted auth.json content, or null for a tombstone. */
  content: string | null;
  createdAt: number;
}

/**
 * Reconciles the record head with the local file at boot.
 *
 * Freshness of the local file is its mtime (seconds) when it diverges from the
 * recorded sync watermark — i.e. pi refreshed the token and we crashed before
 * write-back. A tombstoned head always wins: revocation is an owner decision
 * and a stale local token must not resurrect it.
 */
export async function reconcileProviderAuth(
  stateDir: string,
  head: AuthHeadView | null,
  logger: Logger = nullLogger,
): Promise<AuthReconcileResult> {
  const path = authFilePath(stateDir);
  const local = await readLocalAuth(stateDir);

  if (head?.content === null) return { action: "revoked" };

  if (!head) {
    if (local === null) return { action: "missing" };
    // PVC survived, relay lost the head (or never had it): republish ours.
    return { action: "publish-local", authPath: path, content: local };
  }

  if (local === null) {
    await materializeAuth(stateDir, head.content, head.createdAt);
    return { action: "materialized", authPath: path };
  }

  const meta = await readSyncMeta(stateDir);
  const localDigest = digestOf(local);
  if (meta && meta.digest === localDigest) {
    // Local is exactly what we last synced. The head decides.
    if (head.createdAt > meta.recordCreatedAt) {
      await materializeAuth(stateDir, head.content, head.createdAt);
      return { action: "materialized", authPath: path };
    }
    return { action: "none", authPath: path };
  }

  // Local diverged from the last sync — pi refreshed and we did not write back.
  let localMtimeSec = 0;
  try {
    localMtimeSec = Math.floor((await stat(path)).mtimeMs / 1000);
  } catch {
    // Race: the file vanished between read and stat. Treat the head as newer.
  }
  if (localMtimeSec > head.createdAt) {
    logger.info("local auth.json is newer than the record head; publishing write-back");
    return { action: "publish-local", authPath: path, content: local };
  }
  await materializeAuth(stateDir, head.content, head.createdAt);
  return { action: "materialized", authPath: path };
}

/* -------------------------------------------------------------------------- */
/* Refresh watcher                                                            */
/* -------------------------------------------------------------------------- */

export interface AuthWatcherOptions {
  stateDir: string;
  /** Called with the new file content after a debounce window. */
  onRefresh(content: string): void;
  logger?: Logger;
  debounceMs?: number;
}

/**
 * Watches `auth.json` for writes made by the pi SDK's OAuth refresh.
 *
 * Changes whose content digest matches the recorded sync watermark are our own
 * materialisations and are ignored, so a head update arriving from the relay
 * does not bounce straight back as a write-back.
 */
export function watchAuthFile(options: AuthWatcherOptions): () => void {
  const logger = options.logger ?? nullLogger;
  const debounceMs = options.debounceMs ?? 250;
  const dir = piAgentDir(options.stateDir);
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let closed = false;

  const fire = () => {
    timer = null;
    void (async () => {
      const content = await readLocalAuth(options.stateDir);
      if (content === null || !isPlausibleAuthJson(content)) return;
      const meta = await readSyncMeta(options.stateDir);
      if (meta && meta.digest === digestOf(content)) return;
      options.onRefresh(content);
    })().catch((error: unknown) => {
      logger.warn("auth watcher failed to read auth.json", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  try {
    // Watch the directory rather than the file: pi writes via lockfile and the
    // inode can change; a directory watch survives replacement.
    watcher = watch(dir, (eventType, filename) => {
      if (filename !== null && filename !== AUTH_FILE_NAME) return;
      if (timer) clearTimeout(timer);
      if (!closed) timer = setTimeout(fire, debounceMs);
    });
  } catch (error) {
    logger.warn("auth watcher could not start", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
