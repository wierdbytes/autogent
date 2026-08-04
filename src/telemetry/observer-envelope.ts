/**
 * NIP-AO observability contracts (kind 24200).
 *
 * Field names here are load-bearing: Buzz Desktop deserialises this envelope
 * verbatim (`desktop/src/features/agents/ui/agentSessionTypes.ts`) and the Rust
 * producer uses `#[serde(rename_all = "camelCase")]` on `ObserverEvent`
 * (`crates/buzz-acp/src/observer.rs`). Do not rename anything without checking
 * both sides.
 */

/**
 * Frame kinds Buzz Desktop understands.
 *
 * `acp_read` / `acp_write` carry JSON-RPC-shaped ACP frames. We are not an ACP
 * runtime — these are a *wire compatibility* representation so the stock viewer
 * can render a Pi SDK transcript. See src/telemetry/buzz-desktop-compat.ts.
 */
export type ObserverFrameKind =
  | "session_resolved"
  | "acp_read"
  | "acp_write"
  | "acp_parse_error"
  | "turn_started"
  | "turn_liveness"
  | "turn_completed"
  | "turn_error"
  | "raw_json_rpc"
  | "agent_panic";

/** The decrypted body of a `frame=telemetry` kind 24200 event. */
export interface ObserverEvent {
  /** Monotonic per persisted session. Desktop dedups on `(seq, timestamp)`. */
  seq: number;
  /** RFC 3339 UTC with millisecond precision, e.g. `2026-08-03T12:00:00.123Z`. */
  timestamp: string;
  kind: ObserverFrameKind;
  /** Pool slot index. Always 0 for this single-process service. */
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  /** Omitted (not null) when unknown, matching `skip_serializing_if` in Rust. */
  startedAt?: string | null;
  payload: unknown;
}

/** Recommended relay ceiling: 100 frames/sec per agent pubkey (NIP-AO). */
export const OBSERVER_MAX_FRAMES_PER_SECOND = 100;

/** Hard NIP-44 plaintext ceiling for a single frame. */
export const OBSERVER_MAX_PLAINTEXT_BYTES = 65_535;

/**
 * Working budget for one frame's plaintext.
 *
 * Kept well under {@link OBSERVER_MAX_PLAINTEXT_BYTES} so envelope overhead and
 * multi-byte UTF-8 expansion cannot push a frame over the relay limit.
 */
export const OBSERVER_FRAME_BUDGET_BYTES = 48_000;

/** Desktop prunes a turn after ~25s without frames; we heartbeat well inside that. */
export const TURN_LIVENESS_INTERVAL_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* Control frames (owner -> agent, frame=control)                             */
/* -------------------------------------------------------------------------- */

/** Cancel the in-flight turn of one channel. The only control type in NIP-AO. */
export interface CancelTurnControl {
  type: "cancel_turn";
  channelId: string;
}

/**
 * Compatibility extension (plan §6.9). Not part of NIP-AO; ignored by relays and
 * by Desktop. Unknown control types must be dropped silently by any receiver,
 * which makes adding this safe.
 */
export interface SwitchModelControl {
  type: "switch_model";
  channelId?: string | null;
  model: string;
}

export type ControlFrame = CancelTurnControl | SwitchModelControl;

/** Reply to a control frame, sent back as a `frame=telemetry` raw_json_rpc payload. */
export interface ControlResult {
  type: "control_result";
  /** Echo of the request `type`. */
  request: string;
  ok: boolean;
  channelId?: string | null;
  detail?: string;
}

/** Narrows an unknown decrypted control payload. Returns null if unrecognised. */
export function parseControlFrame(value: unknown): ControlFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "cancel_turn":
      return typeof record.channelId === "string"
        ? { type: "cancel_turn", channelId: record.channelId }
        : null;
    case "switch_model":
      return typeof record.model === "string"
        ? {
            type: "switch_model",
            model: record.model,
            channelId: typeof record.channelId === "string" ? record.channelId : null,
          }
        : null;
    default:
      return null;
  }
}

/** RFC 3339 UTC with milliseconds — the format Desktop parses with `Date.parse`. */
export function observerTimestamp(atMs: number): string {
  return new Date(atMs).toISOString();
}
