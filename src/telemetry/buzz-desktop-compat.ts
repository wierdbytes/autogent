/**
 * ACP wire-compatibility mapper for the stock Buzz Desktop transcript viewer.
 *
 * Nothing in this service speaks ACP. Desktop's transcript reducer
 * (`desktop/src/features/agents/ui/agentSessionTranscript.ts`) was written
 * against a JSON-RPC harness, and we are not allowed to change it, so the Pi
 * event stream is serialised into the frames that reducer already understands.
 * Treat every literal in this file as load-bearing wire format.
 *
 * Everything here is pure: the publisher owns `seq`, `timestamp`, encryption
 * and transport, which keeps the format contract unit-testable on its own.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import type { ObserverFrameDraft, PiEvent } from "../runtime/ports.js";
import type { ObserverFrameKind } from "./observer-envelope.js";

/* -------------------------------------------------------------------------- */
/* Wire vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/** Desktop branches on `payload.method`; these three are the only ones we emit. */
export const SESSION_PROMPT_METHOD = "session/prompt";
export const SESSION_STEER_METHOD = "_goose/unstable/session/steer";
export const SESSION_UPDATE_METHOD = "session/update";

/** Statuses Desktop's `normalizeToolStatus` maps to itself unchanged. */
export type ToolStatus = "executing" | "completed" | "failed";

/** A frame body: the `kind`/`payload` pair, before routing and sequencing. */
export interface TelemetryFrameBody {
  kind: ObserverFrameKind;
  payload: unknown;
}

/** Identity fields the publisher stamps onto every frame of a turn. */
export interface FrameRoute {
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  startedAt?: string | null;
}

/** Combines a frame body with its routing into a draft the publisher accepts. */
export function frameDraft(body: TelemetryFrameBody, route: FrameRoute): ObserverFrameDraft {
  return {
    kind: body.kind,
    channelId: route.channelId,
    sessionId: route.sessionId,
    turnId: route.turnId,
    // `startedAt` is `skip_serializing_if` on the wire, so absent != null.
    ...(route.startedAt === undefined ? {} : { startedAt: route.startedAt }),
    payload: body.payload,
  };
}

function notification(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", method, params };
}

function sessionUpdate(update: Record<string, unknown>): Record<string, unknown> {
  return notification(SESSION_UPDATE_METHOD, { update });
}

/* -------------------------------------------------------------------------- */
/* Frame constructors                                                         */
/* -------------------------------------------------------------------------- */

export function sessionResolvedFrame(isNewSession: boolean): TelemetryFrameBody {
  return { kind: "session_resolved", payload: { isNewSession } };
}

/**
 * The primary user prompt.
 *
 * Desktop re-derives the author pubkey and event id from the prompt *text*, so
 * the text must follow the convention documented by {@link inspectPrompt}.
 */
export function promptFrame(text: string): TelemetryFrameBody {
  return {
    kind: "acp_write",
    payload: notification(SESSION_PROMPT_METHOD, { prompt: [{ type: "text", text }] }),
  };
}

/** A same-thread follow-up delivered into a running turn. */
export function steerFrame(text: string): TelemetryFrameBody {
  return {
    kind: "acp_write",
    payload: notification(SESSION_STEER_METHOD, { prompt: [{ type: "text", text }] }),
  };
}

/**
 * One slice of visible assistant text.
 *
 * Desktop concatenates every chunk sharing a `messageId` into a single bubble,
 * so a message's slices must all carry the same id and distinct messages must
 * not reuse one.
 */
export function assistantChunkFrame(messageId: string, text: string): TelemetryFrameBody {
  return {
    kind: "acp_read",
    payload: sessionUpdate({ sessionUpdate: "agent_message_chunk", messageId, content: text }),
  };
}

/** Reasoning text. Same concatenation rule as {@link assistantChunkFrame}. */
export function thinkingChunkFrame(messageId: string, text: string): TelemetryFrameBody {
  return {
    kind: "acp_read",
    payload: sessionUpdate({ sessionUpdate: "agent_thought_chunk", messageId, content: text }),
  };
}

export interface ToolCallFrameArgs {
  toolCallId: string;
  toolName: string;
  /** Human label. Desktop prefers this over `toolName` for the item heading. */
  title?: string;
  input: Record<string, unknown>;
}

export function toolCallFrame(args: ToolCallFrameArgs): TelemetryFrameBody {
  return {
    kind: "acp_read",
    payload: sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: args.toolCallId,
      title: args.title ?? args.toolName,
      toolName: args.toolName,
      status: "executing" satisfies ToolStatus,
      args: args.input,
    }),
  };
}

export interface ToolCallUpdateFrameArgs {
  toolCallId: string;
  status: ToolStatus;
  content: string;
  toolName?: string;
  title?: string;
  /** Present only when an oversized result was split; 1-based. */
  chunkIndex?: number;
  chunkCount?: number;
}

/**
 * Tool progress or completion.
 *
 * Desktop correlates purely on `toolCallId` and refuses to move a terminal
 * status back to `executing`, so a late progress frame is harmless — but we
 * still enforce the same rule upstream so the wire itself never lies.
 */
export function toolCallUpdateFrame(args: ToolCallUpdateFrameArgs): TelemetryFrameBody {
  const update: Record<string, unknown> = {
    sessionUpdate: "tool_call_update",
    toolCallId: args.toolCallId,
    status: args.status,
    content: args.content,
  };
  if (args.title !== undefined) update.title = args.title;
  if (args.toolName !== undefined) update.toolName = args.toolName;
  if (args.chunkIndex !== undefined) update.chunkIndex = args.chunkIndex;
  if (args.chunkCount !== undefined) update.chunkCount = args.chunkCount;
  return { kind: "acp_read", payload: sessionUpdate(update) };
}

export interface UsageUpdateFrameArgs {
  /** Context tokens consumed. Desktop renders nothing unless both are numbers. */
  used: number;
  size: number;
  costUsd: number;
}

export function usageUpdateFrame(args: UsageUpdateFrameArgs): TelemetryFrameBody {
  return {
    kind: "acp_read",
    payload: sessionUpdate({
      sessionUpdate: "usage_update",
      used: args.used,
      size: args.size,
      cost: { amount: args.costUsd, currency: "USD" },
    }),
  };
}

/**
 * Turn start.
 *
 * Desktop caches `triggeringEventIds` per `(channel, turn)` and, when exactly
 * one id is present, uses it to attribute the user bubble that the prompt frame
 * renders. Emit this before the prompt frame.
 */
export function turnStartedFrame(triggeringEventIds: readonly string[]): TelemetryFrameBody {
  return { kind: "turn_started", payload: { triggeringEventIds: [...triggeringEventIds] } };
}

/** Heartbeat that keeps Desktop's working indicator alive during a quiet turn. */
export function turnLivenessFrame(): TelemetryFrameBody {
  return { kind: "turn_liveness", payload: {} };
}

export function turnCompletedFrame(): TelemetryFrameBody {
  return { kind: "turn_completed", payload: {} };
}

export interface TurnErrorFrameArgs {
  outcome: string;
  error: string;
  code?: string | number;
}

export function turnErrorFrame(args: TurnErrorFrameArgs): TelemetryFrameBody {
  return {
    kind: "turn_error",
    payload: {
      outcome: args.outcome,
      error: args.error,
      ...(args.code === undefined ? {} : { code: args.code }),
    },
  };
}

/**
 * A visible status line.
 *
 * Desktop renders any method-less `acp_read` payload carrying `type`, `title`
 * and `text` as a lifecycle item in the main feed — the only way to surface a
 * producer-side diagnostic without touching Desktop.
 */
export function diagnosticFrame(args: {
  type: string;
  title: string;
  text: string;
}): TelemetryFrameBody {
  return { kind: "acp_read", payload: { type: args.type, title: args.title, text: args.text } };
}

/** Fallback for Pi events with no ACP analogue. Desktop titles it on `type`. */
export function rawJsonRpcFrame(event: PiEvent, maxStringBytes = 4_096): TelemetryFrameBody {
  return { kind: "raw_json_rpc", payload: boundValue(event, maxStringBytes) };
}

/* -------------------------------------------------------------------------- */
/* Pi event mapping                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Maps a streaming Pi event to the frames Desktop should see.
 *
 * Lifecycle events return nothing: turn identity lives in the runtime's turn
 * context, not in the Pi stream, so `turn_started` / `turn_completed` /
 * `usage_update` are emitted by the caller that owns that context.
 */
export function mapPiEvent(event: PiEvent): TelemetryFrameBody[] {
  switch (event.type) {
    case "text_delta":
      return [assistantChunkFrame(event.messageId, event.delta)];
    case "thinking_delta":
      return [thinkingChunkFrame(event.messageId, event.delta)];
    case "tool_start":
      return [
        toolCallFrame({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        }),
      ];
    case "tool_update":
      return [
        toolCallUpdateFrame({
          toolCallId: event.toolCallId,
          status: "executing",
          content: describeToolOutput(event.delta).text,
        }),
      ];
    case "tool_end":
      return [
        toolCallUpdateFrame({
          toolCallId: event.toolCallId,
          status: event.isError ? "failed" : "completed",
          content: describeToolOutput(event.output).text,
        }),
      ];
    case "retry":
    case "compaction":
    case "diagnostic":
      return [rawJsonRpcFrame(event)];
    case "agent_start":
    case "turn_start":
    case "message_end":
    case "agent_end":
    case "agent_settled":
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Correlation helpers                                                        */
/* -------------------------------------------------------------------------- */

export function isTerminalToolStatus(status: ToolStatus): boolean {
  return status === "completed" || status === "failed";
}

/** Mirrors Desktop's `mergeToolStatus`: terminal wins over anything transient. */
export function mergeToolStatus(existing: ToolStatus, next: ToolStatus): ToolStatus {
  return isTerminalToolStatus(existing) && !isTerminalToolStatus(next) ? existing : next;
}

/** The tool a frame refers to, for producer-side status bookkeeping. */
export interface ToolFrameIdentity {
  toolCallId: string;
  status: ToolStatus;
}

export function readToolFrameIdentity(payload: unknown): ToolFrameIdentity | null {
  const update = readSessionUpdate(payload);
  if (!update) return null;
  const kind = update.sessionUpdate;
  if (kind !== "tool_call" && kind !== "tool_call_update") return null;
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : null;
  if (!toolCallId) return null;
  const status = update.status;
  if (status !== "executing" && status !== "completed" && status !== "failed") return null;
  return { toolCallId, status };
}

/** Rewrites a tool frame's status, used to repair a would-be terminal regression. */
export function withToolStatus(payload: unknown, status: ToolStatus): unknown {
  const update = readSessionUpdate(payload);
  if (!update) return payload;
  return sessionUpdate({ ...update, status });
}

/** A coalescable assistant/thinking chunk. */
export interface ChunkIdentity {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
  messageId: string;
  text: string;
}

export function readChunkIdentity(payload: unknown): ChunkIdentity | null {
  const update = readSessionUpdate(payload);
  if (!update) return null;
  const kind = update.sessionUpdate;
  if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return null;
  const messageId = typeof update.messageId === "string" ? update.messageId : null;
  const text = typeof update.content === "string" ? update.content : null;
  if (messageId === null || text === null) return null;
  return { sessionUpdate: kind, messageId, text };
}

export function chunkFrameOf(identity: ChunkIdentity): TelemetryFrameBody {
  return identity.sessionUpdate === "agent_message_chunk"
    ? assistantChunkFrame(identity.messageId, identity.text)
    : thinkingChunkFrame(identity.messageId, identity.text);
}

function readSessionUpdate(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.method !== SESSION_UPDATE_METHOD) return null;
  const params = record.params;
  if (typeof params !== "object" || params === null) return null;
  const update = (params as Record<string, unknown>).update;
  if (typeof update !== "object" || update === null) return null;
  return update as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Size handling                                                              */
/* -------------------------------------------------------------------------- */

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Splits on code-point boundaries so no part can contain half a character.
 * Sizes are measured in UTF-8 bytes because that is what the NIP-44 plaintext
 * budget counts.
 */
export function splitByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError("maxBytes must be an integer of at least 4 (one code point)");
  }
  if (utf8ByteLength(text) <= maxBytes) return [text];
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of text) {
    const size = utf8ByteLength(char);
    if (currentBytes + size > maxBytes) {
      parts.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * Splits a frame payload that does not fit the budget.
 *
 * Assistant and thinking chunks split losslessly: Desktop concatenates parts
 * sharing a `messageId`. Tool results split into ordered, labelled chunks —
 * Desktop keeps only the newest non-empty result per `toolCallId`, so the
 * label is what tells a reader the item is a tail; the full sequence still
 * reaches the owner as distinct frames. Anything else is elided in place with a
 * visible marker instead of being dropped.
 */
export function splitFramePayload(payload: unknown, budgetBytes: number): unknown[] {
  const encoded = JSON.stringify(payload) ?? "null";
  if (utf8ByteLength(encoded) <= budgetBytes) return [payload];

  const chunk = readChunkIdentity(payload);
  if (chunk) {
    const overhead = utf8ByteLength(encoded) - utf8ByteLength(chunk.text);
    return splitByUtf8Bytes(chunk.text, Math.max(4, budgetBytes - overhead)).map(
      (text) => chunkFrameOf({ ...chunk, text }).payload,
    );
  }

  const update = readSessionUpdate(payload);
  if (update?.sessionUpdate === "tool_call_update" && typeof update.content === "string") {
    const overhead = utf8ByteLength(encoded) - utf8ByteLength(update.content);
    // Reserve room for the `[result chunk i/n]` label and the chunk counters.
    const parts = splitByUtf8Bytes(update.content, Math.max(4, budgetBytes - overhead - 64));
    return parts.map((content, index) =>
      sessionUpdate({
        ...update,
        content: `[result chunk ${index + 1}/${parts.length}]\n${content}`,
        chunkIndex: index + 1,
        chunkCount: parts.length,
      }),
    );
  }

  return [
    diagnosticFrame({
      type: "observer_payload_elided",
      title: "Telemetry payload elided",
      text:
        `A ${utf8ByteLength(encoded)} byte frame exceeded the ` +
        `${budgetBytes} byte budget and could not be split.`,
    }).payload,
  ];
}

/** Recursively caps string lengths so a diagnostic frame cannot blow the budget. */
export function boundValue(value: unknown, maxStringBytes: number): unknown {
  if (typeof value === "string") {
    if (utf8ByteLength(value) <= maxStringBytes) return value;
    const head = splitByUtf8Bytes(value, maxStringBytes)[0] ?? "";
    return `${head}… [${utf8ByteLength(value)} bytes truncated]`;
  }
  if (Array.isArray(value)) return value.map((item) => boundValue(item, maxStringBytes));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = boundValue(item, maxStringBytes);
    }
    return out;
  }
  return value;
}

/** Result of screening tool output for content that must not go on the wire. */
export interface ToolOutputSummary {
  text: string;
  binary: boolean;
}

/**
 * Replaces non-textual tool output with metadata and a digest.
 *
 * A JS string carrying binary data typically contains NUL or unpaired
 * surrogates; both survive JSON but not NIP-44 plaintext round-tripping, and
 * neither is renderable. The digest is taken over the UTF-16 code units so a
 * lone surrogate still yields a stable, reproducible value.
 */
export function describeToolOutput(output: string): ToolOutputSummary {
  if (!isTextual(output)) {
    const bytes = new Uint8Array(Buffer.from(output, "utf16le"));
    const digest = Buffer.from(sha256(bytes)).toString("hex");
    return {
      binary: true,
      text: `[binary tool output elided]\nunits: ${output.length}\nsha256: ${digest}`,
    };
  }
  return { text: output, binary: false };
}

function isTextual(value: string): boolean {
  if (value.includes("\u0000")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Prompt text contract                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Desktop never reads structured prompt metadata — it text-scrapes the prompt.
 * These are the exact expressions from `agentSessionTranscriptHelpers.ts`;
 * the prompt formatter must produce text that satisfies all of them.
 */
export const PROMPT_SECTION_HEADER_RE = /^\[([^\]]+)]\s*$/;
export const PROMPT_AUTHOR_HEX_RE = /^From:.*\bhex:\s*([0-9a-fA-F]{64})/m;
export const PROMPT_EVENT_ID_RE = /^Event ID:\s*([0-9a-fA-F]{64})\b/m;
const PROMPT_CONTENT_RE = /^Content:\s?(.*)$/;
const PROMPT_FIELD_BOUNDARY_RE = /^(?:Event ID|Channel|Kind|From|Time|Tags|Parsed):\s*/;
const PROMPT_BLOCK_BOUNDARY_RE = /^--- Event \d+\b/;

/** Desktop matches the user-facing section by this case-insensitive prefix. */
export const BUZZ_EVENT_SECTION_PREFIX = "buzz event";

export interface PromptSection {
  title: string;
  body: string;
}

/** What Desktop will show for a given prompt text. */
export interface PromptCompatibility {
  sections: PromptSection[];
  /** Title of the section Desktop treats as the user message, if any. */
  buzzEventTitle: string | null;
  /** The bubble text Desktop renders for the user. */
  userText: string;
  authorPubkey: string | null;
  eventId: string | null;
}

/**
 * Re-implements Desktop's prompt scraping so the prompt formatter has an
 * executable contract instead of a prose one.
 *
 * A conforming prompt contains a `[Buzz event: <kind>]` section whose body has
 * `Event ID: <64 hex>`, a `From: … (hex: <64 hex>)` line, and a `Content:`
 * block terminated by the next field line or `--- Event N` separator.
 */
export function inspectPrompt(text: string): PromptCompatibility {
  const sections = parseSections(text).filter((section) => section.body.trim().length > 0);
  if (sections.length === 0) {
    return {
      sections: [],
      buzzEventTitle: null,
      userText: text.trim(),
      authorPubkey: null,
      eventId: null,
    };
  }
  const eventSection = sections.find((section) =>
    section.title.toLowerCase().startsWith(BUZZ_EVENT_SECTION_PREFIX),
  );
  if (!eventSection) {
    return { sections, buzzEventTitle: null, userText: "", authorPubkey: null, eventId: null };
  }
  return {
    sections,
    buzzEventTitle: eventSection.title,
    userText: extractEventContent(eventSection.body),
    authorPubkey: PROMPT_AUTHOR_HEX_RE.exec(eventSection.body)?.[1]?.toLowerCase() ?? null,
    eventId: PROMPT_EVENT_ID_RE.exec(eventSection.body)?.[1]?.toLowerCase() ?? null,
  };
}

function parseSections(text: string): PromptSection[] {
  const sections: PromptSection[] = [];
  let current: PromptSection | null = null;
  const preamble: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const header = PROMPT_SECTION_HEADER_RE.exec(line);
    if (header) {
      if (current) {
        sections.push({ title: current.title, body: current.body.trim() });
      } else if (preamble.join("\n").trim()) {
        sections.push({ title: "Prompt", body: preamble.join("\n").trim() });
      }
      current = { title: header[1] ?? "", body: "" };
      continue;
    }
    if (current) {
      current.body += current.body ? `\n${line}` : line;
    } else {
      preamble.push(line);
    }
  }

  if (current) {
    sections.push({ title: current.title, body: current.body.trim() });
  } else if (preamble.join("\n").trim()) {
    sections.push({ title: "Prompt", body: preamble.join("\n").trim() });
  }
  return sections;
}

function extractEventContent(body: string): string {
  const lines = body.split(/\r?\n/);
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = PROMPT_CONTENT_RE.exec(lines[index] ?? "");
    if (!match) continue;
    const contentLines = [match[1] ?? ""];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (PROMPT_FIELD_BOUNDARY_RE.test(line) || PROMPT_BLOCK_BOUNDARY_RE.test(line)) break;
      contentLines.push(line);
    }
    const content = contentLines.join("\n").trim();
    if (content) chunks.push(content);
  }
  return chunks.join("\n\n");
}
