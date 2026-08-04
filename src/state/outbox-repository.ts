/**
 * Output intent and outbox persistence (plan §9.3).
 *
 * The whole file exists to make chat publication effectively-once: an event is
 * signed exactly one time, its bytes are durable before the first network write,
 * and every retry replays those same bytes so the relay dedups by event id.
 */

import type { Database as Sqlite, Statement } from "better-sqlite3";
import type { NostrEvent } from "../nostr/types.js";
import type {
  OutboxRecord,
  OutboxRepository,
  OutboxState,
  OutputIntent,
  OutputIntentState,
} from "../runtime/ports.js";
import { parseJsonColumn } from "./json.js";

/**
 * Reads that recovery needs and the shared port does not expose.
 *
 * `duePublishes` answers "what may go out right now", which is the wrong question
 * after a crash: recovery has to see every unacknowledged row, including the ones
 * still inside a backoff window, and every intent that never reached the signer.
 */
export interface OutboxReads extends OutboxRepository {
  /** Signed rows the relay never acknowledged, ignoring backoff. */
  unpublished(): OutboxRecord[];
  /** Intents with no signed event yet; no event id exists, so re-signing is safe. */
  unsignedIntents(): OutputIntent[];
  /** When the turn last produced output, or null if it never spoke. */
  latestIntentAt(turnId: string): number | null;
}

interface IntentRow {
  logical_id: string;
  turn_id: string;
  pi_message_id: string;
  ordinal: number;
  content: string;
  channel_id: string;
  reply_event_id: string;
  root_event_id: string;
  participant_pubkeys_json: string;
  state: OutputIntentState;
}

interface OutboxRow {
  logical_id: string;
  event_id: string;
  kind: number;
  signed_event_json: string;
  state: OutboxState;
  attempts: number;
  next_retry_at: number | null;
  last_error: string | null;
}

/**
 * Unacknowledged rows, grouped so a turn's outputs stay in `(turn_id, ordinal)`
 * order while turns themselves go oldest-first.
 *
 * `@now` of NULL disables the backoff filter, which is how recovery enumerates
 * everything that is still owed to the relay.
 */
const DUE_QUERY = `
  WITH candidate AS (
    SELECT o.logical_id, o.event_id, o.kind, o.signed_event_json, o.state, o.attempts,
           o.next_retry_at, o.last_error, o.created_at,
           COALESCE(i.turn_id, o.logical_id) AS group_id,
           i.ordinal AS ordinal
      FROM outbox o
      LEFT JOIN output_intents i ON i.logical_id = o.logical_id
     WHERE o.state IN ('pending', 'failed')
       AND (@now IS NULL OR o.next_retry_at IS NULL OR o.next_retry_at <= @now)
  )
  SELECT c.*,
         (SELECT MIN(x.created_at) FROM candidate x WHERE x.group_id = c.group_id) AS group_at
    FROM candidate c
   ORDER BY group_at ASC, c.group_id ASC, c.ordinal ASC, c.created_at ASC, c.logical_id ASC
`;

export class SqliteOutboxRepository implements OutboxReads {
  readonly #putIntent: Statement<[IntentRow & { created_at: number }]>;
  readonly #intentsForTurn: Statement<[string], IntentRow>;
  readonly #setIntentState: Statement<[{ logical_id: string; state: OutputIntentState }]>;
  readonly #unsignedIntents: Statement<[], IntentRow>;
  readonly #latestIntentAt: Statement<[string], { latest: number | null }>;
  readonly #putSigned: Statement<[OutboxRow & { created_at: number }]>;
  readonly #markPublished: Statement<[string]>;
  readonly #markFailed: Statement<
    [{ logical_id: string; last_error: string; next_retry_at: number | null }]
  >;
  readonly #markDeadLetter: Statement<[{ logical_id: string; last_error: string }]>;
  readonly #due: Statement<[{ now: number | null }], OutboxRow>;
  readonly #db: Sqlite;
  readonly #now: () => number;

  constructor(db: Sqlite, now: () => number) {
    this.#db = db;
    this.#now = now;
    this.#putIntent = db.prepare<IntentRow & { created_at: number }>(
      `INSERT INTO output_intents (
         logical_id, turn_id, pi_message_id, ordinal, content, channel_id,
         reply_event_id, root_event_id, participant_pubkeys_json, state, created_at
       ) VALUES (
         @logical_id, @turn_id, @pi_message_id, @ordinal, @content, @channel_id,
         @reply_event_id, @root_event_id, @participant_pubkeys_json, @state, @created_at
       )
       ON CONFLICT (logical_id) DO NOTHING`,
    );
    this.#intentsForTurn = db.prepare<[string], IntentRow>(
      `SELECT * FROM output_intents WHERE turn_id = ? ORDER BY ordinal ASC, logical_id ASC`,
    );
    this.#setIntentState = db.prepare<{ logical_id: string; state: OutputIntentState }>(
      `UPDATE output_intents SET state = @state WHERE logical_id = @logical_id`,
    );
    this.#unsignedIntents = db.prepare<[], IntentRow>(
      `SELECT i.* FROM output_intents i
         LEFT JOIN outbox o ON o.logical_id = i.logical_id
        WHERE i.state = 'pending' AND o.logical_id IS NULL
        ORDER BY i.turn_id ASC, i.ordinal ASC, i.logical_id ASC`,
    );
    this.#latestIntentAt = db.prepare<[string], { latest: number | null }>(
      `SELECT MAX(created_at) AS latest FROM output_intents WHERE turn_id = ?`,
    );
    this.#putSigned = db.prepare<OutboxRow & { created_at: number }>(
      `INSERT INTO outbox (
         logical_id, event_id, kind, signed_event_json, state, attempts,
         next_retry_at, last_error, created_at
       ) VALUES (
         @logical_id, @event_id, @kind, @signed_event_json, @state, @attempts,
         @next_retry_at, @last_error, @created_at
       )
       ON CONFLICT (logical_id) DO NOTHING`,
    );
    this.#markPublished = db.prepare<[string]>(
      `UPDATE outbox SET state = 'published', next_retry_at = NULL WHERE logical_id = ?`,
    );
    this.#markFailed = db.prepare<{
      logical_id: string;
      last_error: string;
      next_retry_at: number | null;
    }>(
      `UPDATE outbox
          SET state = 'failed',
              attempts = attempts + 1,
              next_retry_at = @next_retry_at,
              last_error = @last_error
        WHERE logical_id = @logical_id AND state != 'published'`,
    );
    this.#markDeadLetter = db.prepare<{ logical_id: string; last_error: string }>(
      `UPDATE outbox
          SET state = 'dead_letter', next_retry_at = NULL, last_error = @last_error
        WHERE logical_id = @logical_id AND state != 'published'`,
    );
    this.#due = db.prepare<{ now: number | null }, OutboxRow>(DUE_QUERY);
  }

  putIntent(intent: OutputIntent): boolean {
    return (
      this.#putIntent.run({
        logical_id: intent.logicalId,
        turn_id: intent.turnId,
        pi_message_id: intent.piMessageId,
        ordinal: intent.ordinal,
        content: intent.content,
        channel_id: intent.channelId,
        reply_event_id: intent.replyEventId,
        root_event_id: intent.rootEventId,
        participant_pubkeys_json: JSON.stringify(intent.participantPubkeys),
        state: intent.state,
        created_at: this.#now(),
      }).changes > 0
    );
  }

  intentsForTurn(turnId: string): OutputIntent[] {
    return this.#intentsForTurn.all(turnId).map(toIntent);
  }

  setIntentState(logicalId: string, state: OutputIntentState): void {
    this.#setIntentState.run({ logical_id: logicalId, state });
  }

  putSigned(record: OutboxRecord): void {
    // Row and intent flip together: a window where the event is signed but the
    // intent still looks unsigned would let recovery sign it a second time and
    // publish the same reply under a second event id.
    this.#db.transaction(() => {
      this.#putSigned.run({
        logical_id: record.logicalId,
        event_id: record.eventId,
        kind: record.kind,
        signed_event_json: JSON.stringify(record.signedEvent),
        state: record.state,
        attempts: record.attempts,
        next_retry_at: record.nextRetryAt,
        last_error: record.lastError,
        created_at: this.#now(),
      });
      this.#setIntentState.run({ logical_id: record.logicalId, state: "signed" });
    })();
  }

  markPublished(logicalId: string): void {
    this.#db.transaction(() => {
      this.#markPublished.run(logicalId);
      this.#setIntentState.run({ logical_id: logicalId, state: "published" });
    })();
  }

  markFailed(logicalId: string, error: string, nextRetryAt: number | null): void {
    this.#markFailed.run({ logical_id: logicalId, last_error: error, next_retry_at: nextRetryAt });
  }

  markDeadLetter(logicalId: string, error: string): void {
    this.#db.transaction(() => {
      this.#markDeadLetter.run({ logical_id: logicalId, last_error: error });
      this.#setIntentState.run({ logical_id: logicalId, state: "abandoned" });
    })();
  }

  duePublishes(now: number): OutboxRecord[] {
    return this.#due.all({ now }).map(toOutbox);
  }

  unpublished(): OutboxRecord[] {
    return this.#due.all({ now: null }).map(toOutbox);
  }

  unsignedIntents(): OutputIntent[] {
    return this.#unsignedIntents.all().map(toIntent);
  }

  latestIntentAt(turnId: string): number | null {
    return this.#latestIntentAt.get(turnId)?.latest ?? null;
  }
}

function toIntent(row: IntentRow): OutputIntent {
  return {
    logicalId: row.logical_id,
    turnId: row.turn_id,
    piMessageId: row.pi_message_id,
    ordinal: row.ordinal,
    content: row.content,
    channelId: row.channel_id,
    replyEventId: row.reply_event_id,
    rootEventId: row.root_event_id,
    participantPubkeys: parseJsonColumn<string[]>(
      row.participant_pubkeys_json,
      "output_intents.participant_pubkeys_json",
      row.logical_id,
    ),
    state: row.state,
  };
}

function toOutbox(row: OutboxRow): OutboxRecord {
  return {
    logicalId: row.logical_id,
    eventId: row.event_id,
    kind: row.kind,
    signedEvent: parseJsonColumn<NostrEvent>(
      row.signed_event_json,
      "outbox.signed_event_json",
      row.logical_id,
    ),
    state: row.state,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
  };
}
