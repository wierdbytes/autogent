/**
 * Inbox persistence (plan §9.2).
 *
 * Every accepted inbound event lands here before anything else happens to it, so
 * a crash at any later point can still find the message and answer it.
 */

import type { Database as Sqlite, Statement } from "better-sqlite3";
import type { NostrEvent } from "../nostr/types.js";
import type { InboxDisposition, InboxRecord, InboxRepository } from "../runtime/ports.js";
import { parseJsonColumn } from "./json.js";

/**
 * Reads that recovery needs and the shared port does not expose.
 *
 * `InboxRepository` can only enumerate one channel at a time and only truly
 * undelivered rows; recovery has neither a channel list nor the luxury of
 * ignoring inputs that reached Pi but were never answered (plan §9.4).
 */
export interface InboxReads extends InboxRepository {
  /**
   * Moves a rejected steer handoff back into the queue (plan §9.2).
   *
   * Returns false when the row was not `steer_pending`, which makes a repeated
   * call after a successful transition a no-op rather than a second requeue.
   */
  releaseSteerPending(eventId: string): boolean;
  /** Channels holding at least one unanswered input. */
  unsettledChannels(): string[];
  /** Unanswered inputs of a channel, oldest first. */
  unsettledForChannel(channelId: string): InboxRecord[];
}

interface InboxRow {
  event_id: string;
  channel_id: string;
  thread_root_id: string;
  author_pubkey: string;
  created_at: number;
  received_at: number;
  disposition: InboxDisposition;
  turn_id: string | null;
  input_ordinal: number | null;
  raw_event_json: string;
}

/** NULLs sort first in SQLite, so unassigned rows are pushed to the end explicitly. */
const ROW_ORDER = "received_at ASC, input_ordinal IS NULL, input_ordinal ASC, event_id ASC";

/** Dispositions of an input that has not yet reached the Pi session. */
const UNDELIVERED_SQL = "('queued', 'steer_pending')";
/** Dispositions of an input that still owes its author an answer. */
const UNSETTLED_SQL = "('queued', 'prompted', 'steer_pending', 'steer_delivered')";
/** Dispositions of an input the Pi session has already seen. */
const DELIVERED_SQL = "('prompted', 'steer_delivered')";

export class SqliteInboxRepository implements InboxReads {
  readonly #insert: Statement<[InboxRow]>;
  readonly #get: Statement<[string], InboxRow>;
  readonly #setDisposition: Statement<[{ event_id: string; disposition: InboxDisposition }]>;
  readonly #setDispositionAndTurn: Statement<
    [{ event_id: string; disposition: InboxDisposition; turn_id: string | null }]
  >;
  readonly #assign: Statement<
    [{ event_id: string; turn_id: string; input_ordinal: number; disposition: InboxDisposition }]
  >;
  readonly #undeliveredForChannel: Statement<[string], InboxRow>;
  readonly #unsettledForChannel: Statement<[string], InboxRow>;
  readonly #unsettledChannels: Statement<[], { channel_id: string }>;
  readonly #completeTurnInputs: Statement<[string]>;
  readonly #releaseSteerPending: Statement<[string]>;
  readonly #dropTurnInput: Statement<[string, string]>;
  readonly #db: Sqlite;

  constructor(db: Sqlite) {
    this.#db = db;
    this.#insert = db.prepare<InboxRow>(
      `INSERT OR IGNORE INTO inbox (
         event_id, channel_id, thread_root_id, author_pubkey, created_at, received_at,
         disposition, turn_id, input_ordinal, raw_event_json
       ) VALUES (
         @event_id, @channel_id, @thread_root_id, @author_pubkey, @created_at, @received_at,
         @disposition, @turn_id, @input_ordinal, @raw_event_json
       )`,
    );
    this.#get = db.prepare<[string], InboxRow>(`SELECT * FROM inbox WHERE event_id = ?`);
    this.#setDisposition = db.prepare<{ event_id: string; disposition: InboxDisposition }>(
      `UPDATE inbox SET disposition = @disposition WHERE event_id = @event_id`,
    );
    // Clearing the ordinal alongside the turn keeps "ordinal is meaningful only
    // inside a turn" true, so replay ordering never sees a stale position.
    this.#setDispositionAndTurn = db.prepare<{
      event_id: string;
      disposition: InboxDisposition;
      turn_id: string | null;
    }>(
      `UPDATE inbox
          SET disposition = @disposition,
              turn_id = @turn_id,
              input_ordinal = CASE WHEN @turn_id IS NULL THEN NULL ELSE input_ordinal END
        WHERE event_id = @event_id`,
    );
    this.#assign = db.prepare<{
      event_id: string;
      turn_id: string;
      input_ordinal: number;
      disposition: InboxDisposition;
    }>(
      `UPDATE inbox
          SET turn_id = @turn_id, input_ordinal = @input_ordinal, disposition = @disposition
        WHERE event_id = @event_id`,
    );
    this.#undeliveredForChannel = db.prepare<[string], InboxRow>(
      `SELECT * FROM inbox
        WHERE channel_id = ? AND disposition IN ${UNDELIVERED_SQL}
        ORDER BY ${ROW_ORDER}`,
    );
    this.#unsettledForChannel = db.prepare<[string], InboxRow>(
      `SELECT * FROM inbox
        WHERE channel_id = ? AND disposition IN ${UNSETTLED_SQL}
        ORDER BY ${ROW_ORDER}`,
    );
    this.#unsettledChannels = db.prepare<[], { channel_id: string }>(
      `SELECT DISTINCT channel_id FROM inbox
        WHERE disposition IN ${UNSETTLED_SQL}
        ORDER BY channel_id ASC`,
    );
    this.#completeTurnInputs = db.prepare<[string]>(
      `UPDATE inbox SET disposition = 'completed'
        WHERE turn_id = ? AND disposition IN ${DELIVERED_SQL}`,
    );
    this.#releaseSteerPending = db.prepare<[string]>(
      `UPDATE inbox
          SET disposition = 'queued', turn_id = NULL, input_ordinal = NULL
        WHERE event_id = ? AND disposition = 'steer_pending'`,
    );
    this.#dropTurnInput = db.prepare<[string, string]>(
      `DELETE FROM turn_inputs WHERE turn_id = ? AND event_id = ?`,
    );
  }

  insertIfAbsent(record: InboxRecord): boolean {
    return this.#insert.run(toRow(record)).changes > 0;
  }

  get(eventId: string): InboxRecord | undefined {
    const row = this.#get.get(eventId);
    return row === undefined ? undefined : toRecord(row);
  }

  setDisposition(eventId: string, disposition: InboxDisposition, turnId?: string | null): void {
    if (turnId === undefined) {
      this.#setDisposition.run({ event_id: eventId, disposition });
      return;
    }
    this.#setDispositionAndTurn.run({ event_id: eventId, disposition, turn_id: turnId });
  }

  assignToTurn(eventId: string, turnId: string, ordinal: number, disposition: InboxDisposition): void {
    this.#assign.run({
      event_id: eventId,
      turn_id: turnId,
      input_ordinal: ordinal,
      disposition,
    });
  }

  pendingForChannel(channelId: string): InboxRecord[] {
    return this.#undeliveredForChannel.all(channelId).map(toRecord);
  }

  completeTurnInputs(turnId: string): void {
    this.#completeTurnInputs.run(turnId);
  }

  releaseSteerPending(eventId: string): boolean {
    return this.#db.transaction(() => {
      const turnId = this.#get.get(eventId)?.turn_id ?? null;
      const moved = this.#releaseSteerPending.run(eventId).changes > 0;
      // The turn input row goes with it: the steer never reached Pi, so leaving
      // the ordinal behind would block the next steer from claiming that slot.
      if (moved && turnId !== null) this.#dropTurnInput.run(turnId, eventId);
      return moved;
    })();
  }

  unsettledChannels(): string[] {
    return this.#unsettledChannels.all().map((row) => row.channel_id);
  }

  unsettledForChannel(channelId: string): InboxRecord[] {
    return this.#unsettledForChannel.all(channelId).map(toRecord);
  }
}

function toRow(record: InboxRecord): InboxRow {
  return {
    event_id: record.eventId,
    channel_id: record.channelId,
    thread_root_id: record.threadRootId,
    author_pubkey: record.authorPubkey,
    created_at: record.createdAt,
    received_at: record.receivedAt,
    disposition: record.disposition,
    turn_id: record.turnId,
    input_ordinal: record.inputOrdinal,
    raw_event_json: JSON.stringify(record.rawEvent),
  };
}

function toRecord(row: InboxRow): InboxRecord {
  return {
    eventId: row.event_id,
    channelId: row.channel_id,
    threadRootId: row.thread_root_id,
    authorPubkey: row.author_pubkey,
    createdAt: row.created_at,
    receivedAt: row.received_at,
    disposition: row.disposition,
    turnId: row.turn_id,
    inputOrdinal: row.input_ordinal,
    rawEvent: parseJsonColumn<NostrEvent>(row.raw_event_json, "inbox.raw_event_json", row.event_id),
  };
}
