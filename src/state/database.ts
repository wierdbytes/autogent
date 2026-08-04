/**
 * SQLite-backed `StatePort` (plan §9).
 *
 * WAL is the point of the pragma block: readers (recovery, diagnostics) never
 * block the writer that is recording an inbound message, and `synchronous=NORMAL`
 * keeps the per-message fsync cost low while still surviving a process crash,
 * which is the failure this layer is designed around.
 */

import Database from "better-sqlite3";
import type { Database as Sqlite } from "better-sqlite3";
import type {
  ChannelRepository,
  SessionStateRepository,
  StatePort,
  TurnRepository,
} from "../runtime/ports.js";
import { SqliteChannelRepository, SqliteSessionStateRepository } from "./channel-repository.js";
import { SqliteInboxRepository, type InboxReads } from "./inbox-repository.js";
import { applyMigrations } from "./migrations.js";
import { SqliteOutboxRepository, type OutboxReads } from "./outbox-repository.js";
import { SqliteTurnRepository } from "./turn-repository.js";

/**
 * `StatePort` plus the reads recovery needs.
 *
 * Kept as a widening of the shared port so runtime code can keep depending on
 * `StatePort` alone while `planRecovery` gets the queries it cannot express
 * through it (see `InboxReads` and `OutboxReads`).
 */
export interface AgentState extends StatePort {
  readonly inbox: InboxReads;
  readonly outbox: OutboxReads;
}

export interface OpenOptions {
  /** Wall clock for timestamps the store stamps itself. Injectable for tests. */
  now?: () => number;
  /** How long a blocked writer waits for the lock before failing. */
  busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export function openDatabase(path: string, options: OpenOptions = {}): AgentState {
  return open(path, options);
}

/** Private, per-connection database. Used by tests and by `--dry-run` boots. */
export function openInMemoryDatabase(options: OpenOptions = {}): AgentState {
  return open(":memory:", options);
}

function open(filename: string, options: OpenOptions): AgentState {
  const db = new Database(filename);
  configure(db, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  applyMigrations(db);
  return new SqliteState(db, options.now ?? Date.now);
}

function configure(db: Sqlite, busyTimeoutMs: number): void {
  // Foreign keys are per-connection and cannot be toggled inside a transaction,
  // so this has to happen before the first migration opens one.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
}

class SqliteState implements AgentState {
  readonly inbox: InboxReads;
  readonly turns: TurnRepository;
  readonly outbox: OutboxReads;
  readonly channels: ChannelRepository;
  readonly sessions: SessionStateRepository;
  readonly #db: Sqlite;

  constructor(db: Sqlite, now: () => number) {
    this.#db = db;
    this.inbox = new SqliteInboxRepository(db);
    this.turns = new SqliteTurnRepository(db, now);
    this.outbox = new SqliteOutboxRepository(db, now);
    this.channels = new SqliteChannelRepository(db);
    this.sessions = new SqliteSessionStateRepository(db);
  }

  transaction<T>(fn: () => T): T {
    // better-sqlite3 nests via savepoints, so callers may compose transactions.
    return this.#db.transaction(fn)();
  }

  close(): void {
    this.#db.close();
  }
}
