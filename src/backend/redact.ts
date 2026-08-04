/**
 * Output scrubbing — belt to the desktop's suspenders.
 *
 * Buzz Desktop already redacts everything a provider emits, on the stated
 * assumption that provider output is hostile: it strips every `env_vars` /
 * `launch.env` value of length ≥ 4 and every `nsec1…`-shaped token from our
 * stderr and our error strings before they reach a log or a persisted
 * `last_error`.
 *
 * We scrub anyway, for the case the desktop cannot cover: this provider is also
 * run by hand (`npm run backend`) and by tests, where nothing is between
 * its stdout and a terminal scrollback. A provider that only behaves when
 * somebody else is watching is not the property we want.
 */

const SECRET_TOKEN = /\b(nsec1[02-9ac-hj-np-z]{20,}|sprt_tok_[A-Za-z0-9_-]+)/gi;

export const REDACTED = "[redacted]";

/**
 * Values that are provably not secrets, however they were configured.
 *
 * A real deploy payload sets `BUZZ_ACP_LAZY_POOL=true` and
 * `BUZZ_ACP_RELAY_OBSERVER=true`, so the four-character string `true` arrives
 * as a "secret value" under the length rule. A JSON keyword carries no entropy
 * beyond the name of the key that holds it, so redacting it protects nothing
 * while corrupting every message that happens to contain the word.
 *
 * This is a noise filter, not the safety property: the reason a mangled value
 * can no longer break the wire response is that the response envelope is
 * serialised *after* redaction and never passed through it (`main.ts`).
 */
const NON_SECRET_LITERALS: ReadonlySet<string> = new Set(["true", "false", "null"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces known secret values and secret-shaped tokens.
 *
 * Longest-first, so a value that is a prefix of another does not leave the
 * remainder of the longer one exposed.
 */
export function redactSecrets(text: string, values: Iterable<string>): string {
  let out = text;
  const candidates = [...values]
    .filter((value) => value.length >= 4 && !NON_SECRET_LITERALS.has(value.toLowerCase()))
    .sort((left, right) => right.length - left.length);

  for (const value of candidates) {
    out = out.replace(new RegExp(escapeRegExp(value), "g"), REDACTED);
  }
  return out.replace(SECRET_TOKEN, REDACTED);
}

/**
 * Collects the literal values worth scrubbing out of a raw deploy request.
 *
 * Deliberately reads the *unparsed* request: a payload that failed validation
 * still carried an nsec, and its error message is exactly the place a naive
 * implementation echoes it.
 */
export function secretsFromRequest(input: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return [];
  }
  const request = value as Record<string, unknown> | null;
  const agent = request?.["agent"] as Record<string, unknown> | undefined;
  if (!agent) return [];

  const out: string[] = [];
  const push = (candidate: unknown): void => {
    if (typeof candidate === "string" && candidate.length >= 4) out.push(candidate);
  };

  push(agent["private_key_nsec"]);
  push(agent["auth_tag"]);

  const maps: unknown[] = [agent["env_vars"]];
  const launch = agent["launch"] as Record<string, unknown> | undefined;
  if (launch) maps.push(launch["env"], launch["policy_env"]);

  for (const map of maps) {
    if (typeof map !== "object" || map === null) continue;
    for (const entry of Object.values(map as Record<string, unknown>)) push(entry);
  }
  return out;
}
