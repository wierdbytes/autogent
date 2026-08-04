/**
 * Schema migrations (plan §9.1).
 *
 * Versions are tracked in `PRAGMA user_version` rather than a bookkeeping table:
 * SQLite maintains it atomically with the rest of the transaction, so a crash
 * mid-migration can never leave the header claiming a version that was not fully
 * applied.
 *
 * Migrations are append-only. Never edit a shipped entry — released databases
 * have already run it.
 */

import type { Database as Sqlite } from "better-sqlite3";

export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

const INITIAL_SCHEMA: readonly string[] = [
  `CREATE TABLE identity_metadata (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     agent_pubkey TEXT NOT NULL,
     owner_pubkey TEXT NOT NULL,
     auth_tag_hash TEXT NOT NULL,
     profile_hash TEXT
   )`,

  `CREATE TABLE channels (
     relay_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
     name TEXT,
     channel_type TEXT NOT NULL CHECK (channel_type IN ('stream', 'private', 'dm')),
     pi_session_id TEXT,
     pi_session_path TEXT,
     last_seen_created_at INTEGER,
     PRIMARY KEY (relay_id, channel_id)
   )`,
  `CREATE INDEX channels_by_status ON channels (relay_id, status)`,

  // `event_id` is the Nostr event id, which is a hash of the event: making it the
  // primary key is what makes inbox dedup a single atomic INSERT OR IGNORE.
  `CREATE TABLE inbox (
     event_id TEXT PRIMARY KEY,
     channel_id TEXT NOT NULL,
     thread_root_id TEXT NOT NULL,
     author_pubkey TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     received_at INTEGER NOT NULL,
     disposition TEXT NOT NULL CHECK (disposition IN (
       'queued', 'prompted', 'steer_pending', 'steer_delivered',
       'completed', 'rejected', 'dead_letter'
     )),
     turn_id TEXT,
     input_ordinal INTEGER,
     raw_event_json TEXT NOT NULL
   ) WITHOUT ROWID`,
  `CREATE INDEX inbox_by_channel_disposition ON inbox (channel_id, disposition, received_at)`,
  // Partial: only rows still attached to a turn are ever looked up this way.
  `CREATE INDEX inbox_by_turn ON inbox (turn_id) WHERE turn_id IS NOT NULL`,

  `CREATE TABLE turns (
     turn_id TEXT PRIMARY KEY,
     channel_id TEXT NOT NULL,
     thread_root_id TEXT NOT NULL,
     primary_trigger_event_id TEXT NOT NULL,
     primary_author_pubkey TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN (
       'created', 'running', 'settling', 'settled',
       'interrupted', 'failed', 'completed'
     )),
     started_at INTEGER NOT NULL,
     settled_at INTEGER,
     stop_reason TEXT
   )`,
  `CREATE INDEX turns_by_state ON turns (state, started_at)`,
  `CREATE INDEX turns_by_channel ON turns (channel_id, started_at)`,

  // The unique ordinal is deliberate: recovery replays inputs in `ordinal` order,
  // and a duplicate ordinal would make that replay order ambiguous.
  `CREATE TABLE turn_inputs (
     turn_id TEXT NOT NULL REFERENCES turns (turn_id) ON DELETE CASCADE,
     event_id TEXT NOT NULL REFERENCES inbox (event_id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('primary', 'steer')),
     ordinal INTEGER NOT NULL,
     delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivered')),
     delivered_at INTEGER,
     PRIMARY KEY (turn_id, event_id)
   )`,
  `CREATE UNIQUE INDEX turn_inputs_by_ordinal ON turn_inputs (turn_id, ordinal)`,

  `CREATE TABLE output_intents (
     logical_id TEXT PRIMARY KEY,
     turn_id TEXT NOT NULL REFERENCES turns (turn_id) ON DELETE CASCADE,
     pi_message_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     content TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     reply_event_id TEXT NOT NULL,
     root_event_id TEXT NOT NULL,
     participant_pubkeys_json TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'signed', 'published', 'abandoned')),
     created_at INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE INDEX output_intents_by_turn ON output_intents (turn_id, ordinal)`,
  `CREATE INDEX output_intents_unsigned ON output_intents (state) WHERE state = 'pending'`,

  // No foreign key to `output_intents`: the outbox also carries events that are not
  // turn outputs (usage metrics), which have no intent row.
  `CREATE TABLE outbox (
     logical_id TEXT PRIMARY KEY,
     event_id TEXT NOT NULL,
     kind INTEGER NOT NULL,
     signed_event_json TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'failed', 'dead_letter')),
     attempts INTEGER NOT NULL DEFAULT 0,
     next_retry_at INTEGER,
     last_error TEXT,
     created_at INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE INDEX outbox_by_state_retry ON outbox (state, next_retry_at)`,
  // Not unique: two identical replies published in the same second hash to the same
  // event id, and the relay collapsing them is the correct outcome, not an error.
  `CREATE INDEX outbox_by_event_id ON outbox (event_id)`,

  `CREATE TABLE observer_state (
     session_id TEXT PRIMARY KEY,
     next_seq INTEGER NOT NULL
   ) WITHOUT ROWID`,

  `CREATE TABLE usage_baselines (
     session_id TEXT PRIMARY KEY,
     turn_seq INTEGER NOT NULL,
     counters_json TEXT NOT NULL
   ) WITHOUT ROWID`,
];

export const MIGRATIONS: readonly Migration[] = [{ version: 1, statements: INITIAL_SCHEMA }];

export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** Applies every migration newer than the database's `user_version`. */
export function applyMigrations(db: Sqlite): number {
  let version = schemaVersionOf(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.pragma(`user_version = ${migration.version}`);
    })();
    version = migration.version;
  }
  return version;
}

export function schemaVersionOf(db: Sqlite): number {
  const value = db.pragma("user_version", { simple: true });
  return typeof value === "number" ? value : Number(value);
}
