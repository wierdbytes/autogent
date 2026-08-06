/**
 * Capture policy, redaction and shaping for the Langfuse exporter
 * (tracing plan §6).
 *
 * Kept apart from the publisher on purpose: "what may leave the process" is a
 * privacy decision the owner made in the agent profile, and it deserves to be
 * a pure, exhaustively testable function rather than a set of `if` branches
 * scattered through span construction.
 */

import type { LangfusePrivacyPreset } from "../config.js";

/**
 * What a preset allows through. Everything not listed here — Nostr metadata,
 * usage, cost, timings, tool names, error flags — is always captured: it is
 * shape, not content, and it is the whole point of tracing.
 */
export interface CapturePolicy {
  preset: LangfusePrivacyPreset;
  /** The turn's prompt and the assistant's reply text. */
  conversation: boolean;
  /** Model reasoning traces (`thinking_delta`). */
  thinking: boolean;
  /** Tool call arguments and tool output. */
  toolPayloads: boolean;
  /** The full effective system prompt of the session. */
  systemPrompt: boolean;
}

export function capturePolicy(preset: LangfusePrivacyPreset): CapturePolicy {
  switch (preset) {
    case "metadata-only":
      return { preset, conversation: false, thinking: false, toolPayloads: false, systemPrompt: false };
    case "conversations":
      return { preset, conversation: true, thinking: false, toolPayloads: false, systemPrompt: false };
    case "full":
      return { preset, conversation: true, thinking: true, toolPayloads: true, systemPrompt: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

export const REDACTED = "[REDACTED]";

/**
 * Known secret shapes. This is defence in depth, not a guarantee: the agent's
 * own nsec and `auth.json` never travel through the `PiEvent` stream in the
 * first place, but a tool that cats a `.env` or echoes an `Authorization`
 * header must not turn a trace into a credential leak.
 *
 * Order matters — the PEM block is matched before the line-oriented patterns
 * can nibble at its interior.
 */
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** `api_key: xyz`, `secret-key = xyz`, `access_token=xyz`, `"secret_key": "xyz"`. */
const KEYED_SECRET =
  /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b("?\s*[:=]\s*)("?)[^\s"',;]+\3/gi;
/** Provider-style key pairs: `sk-ant-…`, `sk-proj-…`, `pk-lf-…`, `sk-lf-…`. */
const PREFIXED_API_KEY = /\b[sp]k-[A-Za-z0-9](?:[A-Za-z0-9_-]{7,})\b/g;
/** Bech32 Nostr secrets. */
const NSEC = /\bnsec1[02-9ac-hj-np-z]{20,}\b/gi;
const NCRYPTSEC = /\bncryptsec1[02-9ac-hj-np-z]{20,}\b/gi;

/**
 * Masks known secret patterns. Deliberately conservative in both directions:
 * no claim of completeness, and no aggressive heuristics that would shred
 * ordinary prose into `[REDACTED]` soup.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    // The key name survives: knowing *which* credential appeared is useful and
    // is not itself a secret.
    .replace(KEYED_SECRET, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`)
    .replace(PREFIXED_API_KEY, REDACTED)
    .replace(NSEC, REDACTED)
    .replace(NCRYPTSEC, REDACTED);
}

/* -------------------------------------------------------------------------- */
/* Shaping                                                                    */
/* -------------------------------------------------------------------------- */

/** Budget for conversational strings (prompt, reply, thinking). */
export const MAX_STRING_BYTES = 16_384;
/** Budget for tool arguments and tool output, which are routinely larger. */
export const MAX_TOOL_PAYLOAD_BYTES = 24_576;

/**
 * Truncates to a UTF-8 byte budget, never mid-codepoint, and says how much was
 * dropped — an analyst reading the trace must be able to tell a short answer
 * from a clipped one. Budgets are module constants, not config: fewer knobs,
 * fewer ways to accidentally ship a 10 MB span.
 */
export function clampText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;

  let end = Math.max(0, maxBytes);
  // Walk back off continuation bytes (0b10xxxxxx) so the cut lands on a
  // codepoint boundary rather than producing a replacement character.
  while (end > 0 && ((buffer[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--;
  const dropped = buffer.byteLength - end;
  return `${buffer.toString("utf8", 0, end)}…[truncated ${dropped} bytes]`;
}

/**
 * The single funnel every captured string goes through: redact, then clamp.
 * Redaction runs at every preset — if content is present at all, it is
 * scrubbed.
 */
export function shapeContent(text: string, maxBytes: number = MAX_STRING_BYTES): string {
  return clampText(redactSecrets(text), maxBytes);
}
