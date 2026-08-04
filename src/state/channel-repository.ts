/**
 * Channel and per-session bookkeeping (plan §9.1).
 *
 * Channels carry the binding between a Buzz channel and the Pi session file that
 * holds its transcript, which is what lets a restart resume a conversation
 * instead of starting a blank one.
 */

import type { Database as Sqlite, Statement } from "better-sqlite3";
import type { ChannelRecord, ChannelRepository, SessionStateRepository } from "../runtime/ports.js";
import { parseJsonColumn } from "./json.js";

interface ChannelRow {
  relay_id: string;
  channel_id: string;
  status: ChannelRecord["status"];
  name: string | null;
  channel_type: ChannelRecord["channelType"];
  pi_session_id: string | null;
  pi_session_path: string | null;
  last_seen_created_at: number | null;
}

export class SqliteChannelRepository implements ChannelRepository {
  readonly #upsert: Statement<[ChannelRow]>;
  readonly #get: Statement<[string, string], ChannelRow>;
  readonly #active: Statement<[string], ChannelRow>;
  readonly #setStatus: Statement<
    [{ relay_id: string; channel_id: string; status: ChannelRecord["status"] }]
  >;
  readonly #setSession: Statement<
    [{ relay_id: string; channel_id: string; pi_session_id: string; pi_session_path: string | null }]
  >;
  readonly #setLastSeen: Statement<
    [{ relay_id: string; channel_id: string; last_seen_created_at: number }]
  >;

  constructor(db: Sqlite) {
    // The Pi session binding is preserved on upsert: channel metadata is refreshed
    // from the relay on every reconnect and must not detach a live transcript.
    this.#upsert = db.prepare<ChannelRow>(
      `INSERT INTO channels (
         relay_id, channel_id, status, name, channel_type,
         pi_session_id, pi_session_path, last_seen_created_at
       ) VALUES (
         @relay_id, @channel_id, @status, @name, @channel_type,
         @pi_session_id, @pi_session_path, @last_seen_created_at
       )
       ON CONFLICT (relay_id, channel_id) DO UPDATE SET
         status = excluded.status,
         name = excluded.name,
         channel_type = excluded.channel_type,
         pi_session_id = COALESCE(excluded.pi_session_id, channels.pi_session_id),
         pi_session_path = COALESCE(excluded.pi_session_path, channels.pi_session_path),
         last_seen_created_at = NULLIF(MAX(
           COALESCE(excluded.last_seen_created_at, 0),
           COALESCE(channels.last_seen_created_at, 0)
         ), 0)`,
    );
    this.#get = db.prepare<[string, string], ChannelRow>(
      `SELECT * FROM channels WHERE relay_id = ? AND channel_id = ?`,
    );
    this.#active = db.prepare<[string], ChannelRow>(
      `SELECT * FROM channels WHERE relay_id = ? AND status = 'active' ORDER BY channel_id ASC`,
    );
    this.#setStatus = db.prepare<{
      relay_id: string;
      channel_id: string;
      status: ChannelRecord["status"];
    }>(
      `UPDATE channels SET status = @status
        WHERE relay_id = @relay_id AND channel_id = @channel_id`,
    );
    this.#setSession = db.prepare<{
      relay_id: string;
      channel_id: string;
      pi_session_id: string;
      pi_session_path: string | null;
    }>(
      `UPDATE channels SET pi_session_id = @pi_session_id, pi_session_path = @pi_session_path
        WHERE relay_id = @relay_id AND channel_id = @channel_id`,
    );
    // Monotonic: a replayed subscription must never rewind the watermark and let
    // already-answered events look new again.
    this.#setLastSeen = db.prepare<{
      relay_id: string;
      channel_id: string;
      last_seen_created_at: number;
    }>(
      `UPDATE channels
          SET last_seen_created_at = MAX(COALESCE(last_seen_created_at, 0), @last_seen_created_at)
        WHERE relay_id = @relay_id AND channel_id = @channel_id`,
    );
  }

  upsert(record: ChannelRecord): void {
    this.#upsert.run({
      relay_id: record.relayId,
      channel_id: record.channelId,
      status: record.status,
      name: record.name,
      channel_type: record.channelType,
      pi_session_id: record.piSessionId,
      pi_session_path: record.piSessionPath,
      last_seen_created_at: record.lastSeenCreatedAt,
    });
  }

  get(relayId: string, channelId: string): ChannelRecord | undefined {
    const row = this.#get.get(relayId, channelId);
    return row === undefined ? undefined : toRecord(row);
  }

  active(relayId: string): ChannelRecord[] {
    return this.#active.all(relayId).map(toRecord);
  }

  setStatus(relayId: string, channelId: string, status: ChannelRecord["status"]): void {
    this.#setStatus.run({ relay_id: relayId, channel_id: channelId, status });
  }

  setPiSession(relayId: string, channelId: string, sessionId: string, sessionPath: string | null): void {
    this.#setSession.run({
      relay_id: relayId,
      channel_id: channelId,
      pi_session_id: sessionId,
      pi_session_path: sessionPath,
    });
  }

  setLastSeen(relayId: string, channelId: string, createdAt: number): void {
    this.#setLastSeen.run({
      relay_id: relayId,
      channel_id: channelId,
      last_seen_created_at: createdAt,
    });
  }
}

export class SqliteSessionStateRepository implements SessionStateRepository {
  readonly #nextSeq: Statement<[string], { seq: number }>;
  readonly #getBaseline: Statement<[string], { turn_seq: number; counters_json: string }>;
  readonly #setBaseline: Statement<
    [{ session_id: string; turn_seq: number; counters_json: string }]
  >;

  constructor(db: Sqlite) {
    // Allocate and persist in one statement: two observer frames can never share a
    // sequence number, even if the process dies between the two.
    this.#nextSeq = db.prepare<[string], { seq: number }>(
      `INSERT INTO observer_state (session_id, next_seq) VALUES (?, 2)
       ON CONFLICT (session_id) DO UPDATE SET next_seq = next_seq + 1
       RETURNING next_seq - 1 AS seq`,
    );
    this.#getBaseline = db.prepare<[string], { turn_seq: number; counters_json: string }>(
      `SELECT turn_seq, counters_json FROM usage_baselines WHERE session_id = ?`,
    );
    this.#setBaseline = db.prepare<{ session_id: string; turn_seq: number; counters_json: string }>(
      `INSERT INTO usage_baselines (session_id, turn_seq, counters_json)
       VALUES (@session_id, @turn_seq, @counters_json)
       ON CONFLICT (session_id) DO UPDATE SET
         turn_seq = excluded.turn_seq,
         counters_json = excluded.counters_json`,
    );
  }

  nextObserverSeq(sessionId: string): number {
    const row = this.#nextSeq.get(sessionId);
    if (row === undefined) throw new Error(`failed to allocate observer seq for ${sessionId}`);
    return row.seq;
  }

  getUsageBaseline(sessionId: string): { turnSeq: number; counters: unknown } | undefined {
    const row = this.#getBaseline.get(sessionId);
    if (row === undefined) return undefined;
    return {
      turnSeq: row.turn_seq,
      counters: parseJsonColumn<unknown>(
        row.counters_json,
        "usage_baselines.counters_json",
        sessionId,
      ),
    };
  }

  setUsageBaseline(sessionId: string, turnSeq: number, counters: unknown): void {
    this.#setBaseline.run({
      session_id: sessionId,
      turn_seq: turnSeq,
      counters_json: JSON.stringify(counters ?? null),
    });
  }
}

function toRecord(row: ChannelRow): ChannelRecord {
  return {
    relayId: row.relay_id,
    channelId: row.channel_id,
    status: row.status,
    name: row.name,
    channelType: row.channel_type,
    piSessionId: row.pi_session_id,
    piSessionPath: row.pi_session_path,
    lastSeenCreatedAt: row.last_seen_created_at,
  };
}
