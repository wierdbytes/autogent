/**
 * Turn persistence (plan §5.4, §9.1).
 *
 * A turn row is the durable half of `TurnContext`: it fixes the reply target of
 * every output the turn will ever produce, so a restart can rebuild routing
 * without trusting anything the model said.
 */

import type { Database as Sqlite, Statement } from "better-sqlite3";
import type { TurnRecord, TurnRepository, TurnState } from "../runtime/ports.js";
import type { TurnInputRole } from "../runtime/turn-context.js";

export interface TurnInputRecord {
  eventId: string;
  role: TurnInputRole;
  ordinal: number;
  deliveredAt: number | null;
}

/** States a turn can still leave on its own; anything else is history. */
const LIVE_STATES_SQL = "('created', 'running', 'settling', 'settled')";

/** States that close a turn and therefore stamp `settled_at`. */
const TERMINAL_STATES: ReadonlySet<TurnState> = new Set<TurnState>([
  "settled",
  "interrupted",
  "failed",
  "completed",
]);

interface TurnRow {
  turn_id: string;
  channel_id: string;
  thread_root_id: string;
  primary_trigger_event_id: string;
  primary_author_pubkey: string;
  state: TurnState;
  started_at: number;
  settled_at: number | null;
  stop_reason: string | null;
}

interface TurnInputRow {
  event_id: string;
  role: TurnInputRole;
  ordinal: number;
  delivered_at: number | null;
}

export class SqliteTurnRepository implements TurnRepository {
  readonly #insert: Statement<[TurnRow]>;
  readonly #get: Statement<[string], TurnRow>;
  readonly #setState: Statement<
    [{ turn_id: string; state: TurnState; settled_at: number | null; stop_reason: string | null }]
  >;
  readonly #setStateKeepReason: Statement<
    [{ turn_id: string; state: TurnState; settled_at: number | null }]
  >;
  readonly #addInput: Statement<
    [{ turn_id: string; event_id: string; role: TurnInputRole; ordinal: number }]
  >;
  readonly #markDelivered: Statement<[{ turn_id: string; event_id: string; delivered_at: number }]>;
  readonly #inputs: Statement<[string], TurnInputRow>;
  readonly #unfinished: Statement<[], TurnRow>;
  readonly #now: () => number;

  constructor(db: Sqlite, now: () => number) {
    this.#now = now;
    this.#insert = db.prepare<TurnRow>(
      `INSERT INTO turns (
         turn_id, channel_id, thread_root_id, primary_trigger_event_id, primary_author_pubkey,
         state, started_at, settled_at, stop_reason
       ) VALUES (
         @turn_id, @channel_id, @thread_root_id, @primary_trigger_event_id, @primary_author_pubkey,
         @state, @started_at, @settled_at, @stop_reason
       )`,
    );
    this.#get = db.prepare<[string], TurnRow>(`SELECT * FROM turns WHERE turn_id = ?`);
    // `settled_at` is stamped once: the first close wins, so a later bookkeeping
    // transition cannot rewrite when the turn actually stopped.
    this.#setState = db.prepare<{
      turn_id: string;
      state: TurnState;
      settled_at: number | null;
      stop_reason: string | null;
    }>(
      `UPDATE turns
          SET state = @state,
              stop_reason = @stop_reason,
              settled_at = COALESCE(settled_at, @settled_at)
        WHERE turn_id = @turn_id`,
    );
    this.#setStateKeepReason = db.prepare<{
      turn_id: string;
      state: TurnState;
      settled_at: number | null;
    }>(
      `UPDATE turns
          SET state = @state,
              settled_at = COALESCE(settled_at, @settled_at)
        WHERE turn_id = @turn_id`,
    );
    this.#addInput = db.prepare<{
      turn_id: string;
      event_id: string;
      role: TurnInputRole;
      ordinal: number;
    }>(
      `INSERT INTO turn_inputs (turn_id, event_id, role, ordinal, delivery_state, delivered_at)
       VALUES (@turn_id, @event_id, @role, @ordinal, 'pending', NULL)
       ON CONFLICT (turn_id, event_id) DO NOTHING`,
    );
    this.#markDelivered = db.prepare<{ turn_id: string; event_id: string; delivered_at: number }>(
      `UPDATE turn_inputs
          SET delivery_state = 'delivered', delivered_at = @delivered_at
        WHERE turn_id = @turn_id AND event_id = @event_id`,
    );
    this.#inputs = db.prepare<[string], TurnInputRow>(
      `SELECT event_id, role, ordinal, delivered_at FROM turn_inputs
        WHERE turn_id = ? ORDER BY ordinal ASC`,
    );
    this.#unfinished = db.prepare<[], TurnRow>(
      `SELECT * FROM turns WHERE state IN ${LIVE_STATES_SQL} ORDER BY started_at ASC, turn_id ASC`,
    );
  }

  create(record: TurnRecord): void {
    this.#insert.run({
      turn_id: record.turnId,
      channel_id: record.channelId,
      thread_root_id: record.threadRootId,
      primary_trigger_event_id: record.primaryTriggerEventId,
      primary_author_pubkey: record.primaryAuthorPubkey,
      state: record.state,
      started_at: record.startedAt,
      settled_at: record.settledAt,
      stop_reason: record.stopReason,
    });
  }

  get(turnId: string): TurnRecord | undefined {
    const row = this.#get.get(turnId);
    return row === undefined ? undefined : toRecord(row);
  }

  setState(turnId: string, state: TurnState, stopReason?: string | null): void {
    const settledAt = TERMINAL_STATES.has(state) ? this.#now() : null;
    if (stopReason === undefined) {
      this.#setStateKeepReason.run({ turn_id: turnId, state, settled_at: settledAt });
      return;
    }
    this.#setState.run({ turn_id: turnId, state, settled_at: settledAt, stop_reason: stopReason });
  }

  addInput(turnId: string, eventId: string, role: TurnInputRole, ordinal: number): void {
    this.#addInput.run({ turn_id: turnId, event_id: eventId, role, ordinal });
  }

  markInputDelivered(turnId: string, eventId: string, at: number): void {
    this.#markDelivered.run({ turn_id: turnId, event_id: eventId, delivered_at: at });
  }

  inputs(turnId: string): TurnInputRecord[] {
    return this.#inputs.all(turnId).map((row) => ({
      eventId: row.event_id,
      role: row.role,
      ordinal: row.ordinal,
      deliveredAt: row.delivered_at,
    }));
  }

  unfinished(): TurnRecord[] {
    return this.#unfinished.all().map(toRecord);
  }
}

function toRecord(row: TurnRow): TurnRecord {
  return {
    turnId: row.turn_id,
    channelId: row.channel_id,
    threadRootId: row.thread_root_id,
    primaryTriggerEventId: row.primary_trigger_event_id,
    primaryAuthorPubkey: row.primary_author_pubkey,
    state: row.state,
    startedAt: row.started_at,
    settledAt: row.settled_at,
    stopReason: row.stop_reason,
  };
}
