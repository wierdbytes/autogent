/**
 * Log redaction (plan §10.1, §13.6).
 *
 * Decrypted telemetry, chat bodies and key material must never reach a normal
 * log line. Everything logged goes through {@link redact} first.
 */

const HEX64 = /\b[0-9a-f]{64}\b/gi;
const NSEC = /\bnsec1[02-9ac-hj-np-z]{20,}\b/gi;
const NCRYPTSEC = /\bncryptsec1[02-9ac-hj-np-z]{20,}\b/gi;

/** Field names whose values are dropped wholesale, regardless of shape. */
const SENSITIVE_KEYS = new Set([
  "secret",
  "secretkey",
  "privatekey",
  "privkey",
  "nsec",
  "seed",
  "mnemonic",
  "password",
  "token",
  "apikey",
  "authorization",
  "plaintext",
  "content",
  "text",
  "prompt",
  "payload",
]);

/** Truncated so a pubkey stays recognisable in logs without being copy-pasteable. */
export function shortPubkey(pubkey: string): string {
  return pubkey.length <= 16 ? pubkey : `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

function redactString(value: string): string {
  return value
    .replace(NSEC, "[nsec-redacted]")
    .replace(NCRYPTSEC, "[ncryptsec-redacted]")
    .replace(HEX64, (match) => shortPubkey(match.toLowerCase()));
}

/**
 * Deep-redacts a value for logging.
 *
 * Sensitive keys collapse to a marker with the original length, which keeps the
 * diagnostic signal ("the body was 4kB") without leaking the body.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((item) => redact(item, depth + 1));
    return value.length > 20 ? [...head, `[+${value.length - 20} more]`] : head;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        const size = typeof item === "string" ? item.length : JSON.stringify(item ?? null).length;
        out[key] = `[redacted ${size}B]`;
        continue;
      }
      out[key] = redact(item, depth + 1);
    }
    return out;
  }
  return "[unserialisable]";
}
