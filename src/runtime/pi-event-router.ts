/**
 * Normalises `AgentSessionEvent` from the Pi SDK into our closed {@link PiEvent}
 * union.
 *
 * Two reasons this exists rather than matching on the SDK union directly:
 * the SDK surface is wider and less stable than what we consume, and the
 * scheduler/telemetry tests need to synthesise events without importing the SDK.
 *
 * Visible-message extraction (plan §7.5) also lives here: it is the single place
 * that decides what counts as publishable chat text, so thinking and tool calls
 * cannot leak into a channel by accident.
 */

import type { PiEvent, PiUsage } from "./ports.js";

/** Structural view of an SDK message, kept loose because the SDK type is wide. */
interface RawMessage {
  role?: unknown;
  id?: unknown;
  content?: unknown;
  usage?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Concatenates the visible text blocks of an assistant message, in order.
 *
 * Thinking blocks and tool calls are excluded by construction: only blocks whose
 * `type` is `text` (or a bare string) contribute. A tool-only message therefore
 * yields `""` and produces no chat output.
 */
export function extractVisibleText(message: unknown): string {
  const record = asRecord(message);
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const blockRecord = asRecord(block);
    if (blockRecord.type !== "text") continue;
    const text = asString(blockRecord.text);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("");
}

/** Pulls provider usage off an assistant message, tolerating missing fields. */
export function extractUsage(message: unknown): PiUsage | null {
  const usage = asRecord(asRecord(message).usage);
  if (Object.keys(usage).length === 0) return null;
  const cost = asRecord(usage.cost);
  return {
    input: asNumber(usage.input),
    output: asNumber(usage.output),
    total: asNumber(usage.totalTokens),
    cacheRead: asNumber(usage.cacheRead),
    cacheWrite: asNumber(usage.cacheWrite),
    costUsd: asNumber(cost.total),
  };
}

/**
 * Stable identifier for a streaming message.
 *
 * Desktop concatenates chunks that share a `messageId`, so this must be constant
 * for the lifetime of one assistant message and distinct across messages. The
 * SDK does not always expose an id on partial messages, hence the counter
 * fallback held by the router instance.
 */
function messageIdOf(message: unknown, fallback: string): string {
  return asString(asRecord(message).id) ?? fallback;
}

function toolResultText(result: unknown): string {
  const record = asRecord(result);
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      const blockRecord = asRecord(block);
      return asString(blockRecord.text) ?? "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Translates SDK events one-to-one (or to nothing).
 *
 * Instances are per session because streaming message ids are synthesised from a
 * per-session counter when the SDK omits them.
 */
export class PiEventRouter {
  #messageSeq = 0;
  #currentMessageId: string | null = null;

  /** Returns the normalised events for one SDK event; may be empty. */
  translate(event: unknown): PiEvent[] {
    const record = asRecord(event);
    const type = asString(record.type);
    if (type === undefined) return [];

    switch (type) {
      case "agent_start":
        return [{ type: "agent_start", willCompact: record.willCompact === true }];

      case "turn_start":
        return [{ type: "turn_start" }];

      case "message_start": {
        this.#currentMessageId = messageIdOf(record.message, `msg-${++this.#messageSeq}`);
        return [];
      }

      case "message_update": {
        const inner = asRecord(record.assistantMessageEvent);
        const innerType = asString(inner.type);
        const messageId =
          this.#currentMessageId ?? messageIdOf(record.message, `msg-${++this.#messageSeq}`);
        this.#currentMessageId = messageId;
        const delta = asString(inner.delta) ?? "";
        if (innerType === "text_delta") return [{ type: "text_delta", messageId, delta }];
        if (innerType === "thinking_delta") return [{ type: "thinking_delta", messageId, delta }];
        // `tool_call` deltas are covered by the tool_execution_* events, which
        // carry the resolved input rather than a partial argument stream.
        return [];
      }

      case "message_end": {
        const message = record.message as RawMessage;
        const messageId = messageIdOf(message, this.#currentMessageId ?? `msg-${++this.#messageSeq}`);
        this.#currentMessageId = null;
        return [
          {
            type: "message_end",
            messageId,
            role: asString(message.role) ?? "unknown",
            text: extractVisibleText(message),
            usage: extractUsage(message),
          },
        ];
      }

      case "tool_execution_start":
        return [
          {
            type: "tool_start",
            toolCallId: asString(record.toolCallId) ?? "unknown",
            toolName: asString(record.toolName) ?? "tool",
            input: asRecord(record.input),
          },
        ];

      case "tool_execution_update":
        return [
          {
            type: "tool_update",
            toolCallId: asString(record.toolCallId) ?? "unknown",
            delta: asString(record.delta) ?? "",
          },
        ];

      case "tool_execution_end":
        return [
          {
            type: "tool_end",
            toolCallId: asString(record.toolCallId) ?? "unknown",
            isError: record.isError === true,
            output: toolResultText(record.result),
          },
        ];

      case "auto_retry_start":
        return [
          {
            type: "retry",
            attempt: asNumber(record.attempt) ?? 0,
            maxAttempts: asNumber(record.maxAttempts) ?? 0,
            errorMessage: asString(record.errorMessage) ?? "",
          },
        ];

      case "compaction_start":
        return [{ type: "compaction", phase: "start", reason: asString(record.reason) ?? "unknown" }];

      case "compaction_end":
        return [{ type: "compaction", phase: "end", reason: asString(record.reason) ?? "unknown" }];

      case "agent_end":
        return [{ type: "agent_end", willRetry: record.willRetry === true }];

      case "agent_settled":
        return [{ type: "agent_settled" }];

      // Everything else is diagnostic only. Forwarding it as a bounded frame
      // keeps the owner-visible transcript honest without teaching the rest of
      // the runtime about SDK internals.
      default:
        return [{ type: "diagnostic", source: type, detail: record }];
    }
  }
}
