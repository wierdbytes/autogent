/**
 * Membership discovery and the dynamic channel lifecycle (plan §6.3).
 *
 * The agent never guesses which channels it belongs to: kind 39002 with a `#p`
 * tag on the agent is the source of truth, kind 39000 supplies name and type,
 * and relay-signed kinds 44100/44101 keep the set current at runtime.
 */

import type { SubscribeMode } from "../config.js";
import { nullLogger } from "../runtime/logger.js";
import type { Logger, RelayPort, Subscription } from "../runtime/ports.js";
import {
  INBOUND_MESSAGE_KINDS,
  KIND,
  type NostrEvent,
  type NostrFilter,
  channelIdOf,
  tagValue,
  tagValues,
} from "./types.js";

export type ChannelType = "stream" | "private" | "dm";

export const CHANNEL_SUB_PREFIX = "ch-";
export const MEMBERSHIP_SUB_ID = "membership-notif";
export const CONTROL_SUB_ID = "agent-observer-control";

export interface ChannelInfo {
  channelId: string;
  name: string | null;
  type: ChannelType;
  archived: boolean;
  /** False when kind 39000 could not be fetched and `type` is the safe guess. */
  metadataKnown: boolean;
}

/**
 * The channel a message belongs to when its metadata is unavailable.
 *
 * Treating an unknown channel as a DM is the fail-closed choice: DM rules are
 * the strictest, so a misclassified public channel loses reach while a
 * misclassified private one would leak (plan §6.4).
 */
export const UNKNOWN_CHANNEL_TYPE: ChannelType = "dm";

function unknownChannel(channelId: string): ChannelInfo {
  return {
    channelId,
    name: null,
    type: UNKNOWN_CHANNEL_TYPE,
    archived: false,
    metadataKnown: false,
  };
}

/**
 * Reads a kind 39000 event.
 *
 * Detection order matters: Buzz marks DM channels with `hidden` and only some
 * builds also emit `["t","dm"]`, so the strictest marker is checked first and
 * anything unmarked falls through to `stream`.
 */
export function parseChannelMetadata(event: NostrEvent): ChannelInfo | null {
  if (event.kind !== KIND.CHANNEL_METADATA) return null;
  const channelId = tagValue(event, "d");
  if (channelId === undefined || channelId === "") return null;

  const names = new Set(event.tags.map((tag) => tag[0]));
  const topics = new Set(tagValues(event, "t"));
  const type: ChannelType =
    names.has("hidden") || topics.has("dm")
      ? "dm"
      : names.has("private") || topics.has("private")
        ? "private"
        : "stream";

  return {
    channelId,
    name: tagValue(event, "name") ?? null,
    type,
    archived: tagValue(event, "archived") === "true",
    metadataKnown: true,
  };
}

/** The per-channel message filter. `#p` narrows to mentions when configured. */
export function channelFilter(
  channelId: string,
  agentPubkey: string,
  mode: SubscribeMode,
): NostrFilter {
  const filter: NostrFilter = {
    kinds: [...INBOUND_MESSAGE_KINDS],
    "#h": [channelId],
  };
  if (mode === "mentions") filter["#p"] = [agentPubkey];
  return filter;
}

export function channelSubscriptionId(channelId: string): string {
  return `${CHANNEL_SUB_PREFIX}${channelId}`;
}

export interface MembershipManagerOptions {
  relay: RelayPort;
  agentPubkey: string;
  subscribeMode: SubscribeMode;
  /** When non-empty, only these channels are joined. */
  channelAllowlist?: readonly string[];
  logger?: Logger;
  onMessage(event: NostrEvent, channel: ChannelInfo): void;
  onControl(event: NostrEvent): void;
  onChannelAdded?(channel: ChannelInfo): void;
  onChannelRemoved?(channelId: string): void;
  /** Query timeout for discovery round-trips. */
  queryTimeoutMs?: number;
}

export class MembershipManager {
  readonly #relay: RelayPort;
  readonly #agentPubkey: string;
  readonly #mode: SubscribeMode;
  readonly #allowlist: ReadonlySet<string>;
  readonly #logger: Logger;
  readonly #options: MembershipManagerOptions;
  readonly #channels = new Map<string, ChannelInfo>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #globals: Subscription[] = [];
  #stopped = false;

  constructor(options: MembershipManagerOptions) {
    this.#relay = options.relay;
    this.#agentPubkey = options.agentPubkey;
    this.#mode = options.subscribeMode;
    this.#allowlist = new Set(options.channelAllowlist ?? []);
    this.#logger = options.logger ?? nullLogger;
    this.#options = options;
  }

  async start(): Promise<void> {
    // Notification subscriptions come first so a membership granted during
    // discovery lands on an open stream instead of being missed.
    this.#globals.push(
      this.#relay.subscribe({
        id: MEMBERSHIP_SUB_ID,
        filters: [
          {
            kinds: [KIND.MEMBERSHIP_ADDED, KIND.MEMBERSHIP_REMOVED],
            "#p": [this.#agentPubkey],
          },
        ],
        onEvent: (event) => void this.#onMembershipNotification(event),
      }),
      this.#relay.subscribe({
        id: CONTROL_SUB_ID,
        filters: [{ kinds: [KIND.OBSERVER], "#p": [this.#agentPubkey] }],
        onEvent: (event) => this.#options.onControl(event),
      }),
    );

    const channelIds = await this.#discoverChannelIds();
    const metadata = await this.#fetchMetadata(channelIds);
    for (const channelId of channelIds) {
      this.#join(metadata.get(channelId) ?? unknownChannel(channelId));
    }
    this.#logger.info("memberships discovered", { channels: this.#subscriptions.size });
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const subscription of this.#subscriptions.values()) subscription.close();
    this.#subscriptions.clear();
    for (const subscription of this.#globals) subscription.close();
    this.#globals.length = 0;
  }

  channels(): ChannelInfo[] {
    return [...this.#channels.values()];
  }

  get(channelId: string): ChannelInfo | undefined {
    return this.#channels.get(channelId);
  }

  /**
   * The channel type to apply to one event.
   *
   * A cache miss triggers a metadata fetch; if that fails the answer is `dm`
   * for this event only. The guess is deliberately not cached, so a transient
   * relay hiccup cannot permanently downgrade a public channel.
   */
  async resolveType(channelId: string): Promise<ChannelType> {
    const known = this.#channels.get(channelId);
    if (known !== undefined && known.metadataKnown) return known.type;

    const fetched = (await this.#fetchMetadata([channelId])).get(channelId);
    if (fetched === undefined) return UNKNOWN_CHANNEL_TYPE;
    if (this.#channels.has(channelId)) this.#channels.set(channelId, fetched);
    return fetched.type;
  }

  async #discoverChannelIds(): Promise<string[]> {
    const events = await this.#relay.query(
      [{ kinds: [KIND.CHANNEL_MEMBER], "#p": [this.#agentPubkey] }],
      this.#options.queryTimeoutMs,
    );
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      const channelId = tagValue(event, "d");
      if (channelId === undefined || channelId === "" || seen.has(channelId)) continue;
      if (this.#allowlist.size > 0 && !this.#allowlist.has(channelId)) continue;
      seen.add(channelId);
      ids.push(channelId);
    }
    return ids;
  }

  async #fetchMetadata(channelIds: readonly string[]): Promise<Map<string, ChannelInfo>> {
    const found = new Map<string, ChannelInfo>();
    if (channelIds.length === 0) return found;
    const events = await this.#relay.query(
      [{ kinds: [KIND.CHANNEL_METADATA], "#d": [...channelIds] }],
      this.#options.queryTimeoutMs,
    );
    for (const event of events) {
      const info = parseChannelMetadata(event);
      if (info === null) continue;
      const previous = found.get(info.channelId);
      // Addressable events are replaceable; the newest one wins.
      if (previous === undefined) found.set(info.channelId, info);
    }
    return found;
  }

  #join(channel: ChannelInfo): void {
    if (this.#stopped) return;
    if (this.#allowlist.size > 0 && !this.#allowlist.has(channel.channelId)) return;
    this.#channels.set(channel.channelId, channel);
    if (channel.archived) {
      this.#logger.info("channel archived; not subscribing", { channelId: channel.channelId });
      return;
    }
    if (this.#subscriptions.has(channel.channelId)) return;

    const subscription = this.#relay.subscribe({
      id: channelSubscriptionId(channel.channelId),
      filters: [channelFilter(channel.channelId, this.#agentPubkey, this.#mode)],
      onEvent: (event) => {
        const current = this.#channels.get(channel.channelId) ?? channel;
        this.#options.onMessage(event, current);
      },
    });
    this.#subscriptions.set(channel.channelId, subscription);
    this.#options.onChannelAdded?.(channel);
  }

  #leave(channelId: string): void {
    const subscription = this.#subscriptions.get(channelId);
    if (subscription !== undefined) {
      subscription.close();
      this.#subscriptions.delete(channelId);
    }
    if (!this.#channels.delete(channelId) && subscription === undefined) return;
    this.#options.onChannelRemoved?.(channelId);
  }

  async #onMembershipNotification(event: NostrEvent): Promise<void> {
    const channelId = channelIdOf(event);
    if (channelId === undefined || channelId === "") {
      this.#logger.warn("membership notification without a channel", { eventId: event.id });
      return;
    }
    if (event.kind === KIND.MEMBERSHIP_REMOVED) {
      this.#logger.info("membership revoked", { channelId });
      this.#leave(channelId);
      return;
    }
    if (event.kind !== KIND.MEMBERSHIP_ADDED) return;
    if (this.#subscriptions.has(channelId)) return;

    const info = (await this.#fetchMetadata([channelId])).get(channelId) ?? unknownChannel(channelId);
    this.#logger.info("membership granted", { channelId, type: info.type });
    this.#join(info);
  }
}
