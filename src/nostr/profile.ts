/**
 * Profile publication and reconciliation (plan §4.4, §8.1).
 *
 * Two events are needed, not one. Kind 0 is what a generic Nostr client reads,
 * but Buzz Desktop's agent roster comes from `list_relay_agents`, which queries
 * `{"kinds":[10100]}` — publishing kind 0 alone leaves the agent invisible in
 * an unmodified Desktop.
 *
 * Republishing is drift-driven: a stable fingerprint over content plus the
 * NIP-OA tag decides, so restarts do not churn the relay with identical events.
 */

import { nullLogger } from "../runtime/logger.js";
import type { Logger, PublishResult, RelayPort } from "../runtime/ports.js";
import type { AgentEventBuilder } from "./event-builder.js";
import { extractAuthTag, verifyAttestation } from "./nip-oa.js";
import { sha256Utf8 } from "./signer.js";
import { KIND, type NostrEvent, type NostrTag } from "./types.js";

export interface ProfileDescriptor {
  name: string;
  about: string;
  picture?: string;
}

/** The mutable part of the kind 10100 roster entry. */
export interface AgentProfileSnapshot {
  status: string;
  capabilities: string[];
  /** Human-readable channel names, in Desktop display order. */
  channels: string[];
  channelIds: string[];
}

export interface ProfileReconcilerOptions {
  relay: RelayPort;
  builder: AgentEventBuilder;
  profile: ProfileDescriptor;
  logger?: Logger;
  queryTimeoutMs?: number;
}

export interface ReconcileOutcome {
  metadataPublished: boolean;
  agentProfilePublished: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function canonicalContent(content: string): unknown {
  try {
    return canonicalize(JSON.parse(content));
  } catch {
    return content;
  }
}

/**
 * Identity of a profile event, ignoring `created_at`, `id` and `sig`.
 *
 * Key order inside the JSON content and tag order are both normalised: a relay
 * or an older build may echo the same profile with different serialisation, and
 * that is not drift.
 */
export function profileFingerprint(event: {
  kind: number;
  content: string;
  tags: NostrTag[];
}): string {
  const tags = event.tags.map((tag) => [...tag]).sort((a, b) => {
    const left = a.join("\u0000");
    const right = b.join("\u0000");
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const payload = JSON.stringify({
    kind: event.kind,
    content: canonicalContent(event.content),
    tags,
  });
  return Buffer.from(sha256Utf8(payload)).toString("hex");
}

export function metadataContent(profile: ProfileDescriptor): string {
  return JSON.stringify(
    profile.picture === undefined
      ? { name: profile.name, about: profile.about }
      : { name: profile.name, about: profile.about, picture: profile.picture },
  );
}

export function agentProfileContent(
  profile: ProfileDescriptor,
  snapshot: AgentProfileSnapshot,
): string {
  return JSON.stringify({
    name: profile.name,
    display_name: profile.name,
    about: profile.about,
    ...(profile.picture === undefined ? {} : { picture: profile.picture }),
    agent_type: "agent",
    status: snapshot.status,
    capabilities: snapshot.capabilities,
    channels: snapshot.channels,
    channel_ids: snapshot.channelIds,
  });
}

export class ProfileReconciler {
  readonly #relay: RelayPort;
  readonly #builder: AgentEventBuilder;
  readonly #profile: ProfileDescriptor;
  readonly #logger: Logger;
  readonly #queryTimeoutMs: number | undefined;

  constructor(options: ProfileReconcilerOptions) {
    this.#relay = options.relay;
    this.#builder = options.builder;
    this.#profile = options.profile;
    this.#logger = options.logger ?? nullLogger;
    this.#queryTimeoutMs = options.queryTimeoutMs;
  }

  async reconcile(snapshot: AgentProfileSnapshot): Promise<ReconcileOutcome> {
    const metadataPublished = await this.#reconcileOne(
      KIND.METADATA,
      metadataContent(this.#profile),
    );
    const agentProfilePublished = await this.#reconcileOne(
      KIND.AGENT_PROFILE,
      agentProfileContent(this.#profile, snapshot),
    );
    return { metadataPublished, agentProfilePublished };
  }

  /**
   * Publishes the roster entry without asking the relay what it already holds.
   *
   * For the shutdown farewell the drift check is both pointless — the entry has
   * to change, the agent is stopping — and unaffordable: a 10s query round-trip
   * would sit in front of the drain.
   */
  async publishAgentProfile(snapshot: AgentProfileSnapshot): Promise<PublishResult> {
    return this.#relay.publish(
      this.#builder.build({
        kind: KIND.AGENT_PROFILE,
        tags: [],
        content: agentProfileContent(this.#profile, snapshot),
      }),
    );
  }

  async #reconcileOne(kind: number, content: string): Promise<boolean> {
    const desired = this.#builder.build({ kind, tags: [], content });
    const existing = await this.#newest(kind);

    if (existing !== null && this.#ownerProvenanceOk(existing)) {
      if (profileFingerprint(existing) === profileFingerprint(desired)) {
        this.#logger.debug("profile already current", { kind });
        return false;
      }
      this.#logger.info("profile drifted; republishing", { kind });
    } else {
      this.#logger.info("profile missing or unattested; publishing", { kind });
    }

    const result = await this.#relay.publish(desired);
    if (!result.ok) {
      throw new Error(`failed to publish kind ${kind} profile: ${result.message}`);
    }
    return true;
  }

  async #newest(kind: number): Promise<NostrEvent | null> {
    const events = await this.#relay.query(
      [{ kinds: [kind], authors: [this.#builder.agentPubkey], limit: 1 }],
      this.#queryTimeoutMs,
    );
    let newest: NostrEvent | null = null;
    for (const event of events) {
      // Never treat someone else's event as our profile, even if the relay
      // widened the filter: only the agent may author its own identity.
      if (event.kind !== kind || event.pubkey !== this.#builder.agentPubkey) continue;
      if (newest === null || event.created_at > newest.created_at) newest = event;
    }
    return newest;
  }

  #ownerProvenanceOk(event: NostrEvent): boolean {
    const auth = extractAuthTag(event.tags);
    if (auth === null) return false;
    if (auth.ownerPubkey !== this.#builder.ownerPubkey) return false;
    return verifyAttestation(auth, this.#builder.agentPubkey);
  }
}
