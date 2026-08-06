/**
 * Resolves pubkeys to display names off kind 0 profiles, with a bounded cache.
 *
 * Prompts show authors as `@username`; the fallback (no profile, malformed
 * content, lookup failure) is handled by the formatter, which prints the npub
 * instead. Lookups are best-effort — a slow or dead relay yields `null`, never
 * an exception, and negative results are cached too so a nameless author does
 * not trigger a REQ per message.
 */

import { KIND, type NostrEvent } from "../nostr/types.js";
import type { Logger, RelayPort } from "./ports.js";

export interface ProfileNameResolverDeps {
  relay: RelayPort;
  logger: Logger;
  timeoutMs?: number;
  /** How long a cached name (or a cached miss) stays fresh. */
  ttlMs?: number;
  /** Cache cap; the whole cache is cleared on overflow, like the sibling map. */
  cacheCap?: number;
  now?(): number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_CAP = 512;

/** Extracts a display name from a kind 0 profile event. */
export function profileNameOf(profile: Pick<NostrEvent, "content">): string | null {
  try {
    const parsed: unknown = JSON.parse(profile.content);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    for (const key of ["display_name", "name", "username"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export class ProfileNameResolver {
  readonly #cache = new Map<string, { label: string | null; freshUntil: number }>();

  constructor(private readonly deps: ProfileNameResolverDeps) {}

  async resolve(pubkey: string): Promise<string | null> {
    const now = this.deps.now?.() ?? Date.now();
    const cached = this.#cache.get(pubkey);
    if (cached && cached.freshUntil > now) return cached.label;

    let label: string | null = null;
    try {
      const events = await this.deps.relay.query(
        [{ kinds: [KIND.METADATA], authors: [pubkey], limit: 1 }],
        this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const profile = events[0];
      label = profile ? profileNameOf(profile) : null;
    } catch (error) {
      this.deps.logger.debug("profile name lookup failed", { pubkey, error });
      // A transient failure keeps any stale cached label instead of erasing it.
      if (cached) return cached.label;
    }

    if (this.#cache.size >= (this.deps.cacheCap ?? DEFAULT_CACHE_CAP)) this.#cache.clear();
    this.#cache.set(pubkey, {
      label,
      freshUntil: now + (this.deps.ttlMs ?? DEFAULT_TTL_MS),
    });
    return label;
  }
}
