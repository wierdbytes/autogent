/**
 * Owns the set of live channel actors and the membership lifecycle (plan §6.3).
 *
 * Membership can change under us at any time. When the agent is removed from a
 * channel it must stop immediately and completely: no new events accepted, the
 * running turn cancelled, queued work dropped, its in-memory sessions
 * released. Re-adding feels continuous anyway: the next trigger reseeds the
 * conversation from the relay, which is the durable record of what was said.
 */

import type { NostrEvent } from "../nostr/types.js";
import type { FetchHistoryOptions, HistoryMessage } from "./history-fetcher.js";
import { sessionKeyFor } from "./session-registry.js";
import { ChannelActor, type AcceptedEvent, type ChannelActorDeps } from "./channel-actor.js";
import type { ChannelType } from "./prompt-formatter.js";
import type { TurnContext } from "./turn-context.js";
import type {
  Clock,
  Logger,
  PiUsage,
  SessionRegistryPort,
  StatePort,
  TelemetryPort,
} from "./ports.js";
import type { AcquireSessionOptions } from "./ports.js";
import type { OutputRouter } from "./output-router.js";
import type { Semaphore } from "./scheduler.js";

export interface ChannelDescriptor {
  channelId: string;
  name: string | null;
  channelType: ChannelType;
}

export interface ChannelRegistryDeps {
  relayId: string;
  state: StatePort;
  telemetry: TelemetryPort;
  output: OutputRouter;
  sessions: SessionRegistryPort;
  clock: Clock;
  logger: Logger;
  fetchHistory(
    event: NostrEvent,
    threadRootId: string,
    opts: FetchHistoryOptions,
  ): Promise<HistoryMessage[]>;
  /** Display name off a kind 0 profile, or null when unknown. */
  resolveAuthorLabel(pubkey: string): Promise<string | null>;
  /** The agent's own profile name, surfaced to the model as its username. */
  selfName: string;
  observeUsage(sessionId: string, turnId: string, usage: PiUsage): void;
  publishUsage(turn: TurnContext, sessionId: string | null, stopReason: string): void;
  newTurnId(): string;
  idleTimeoutMs: number;
  maxTurnDurationMs: number;
  /** Shared across every channel, which is what makes the limit global. */
  concurrency?: Semaphore;
}

export class ChannelRegistry {
  readonly #actors = new Map<string, ChannelActor>();
  readonly #descriptors = new Map<string, ChannelDescriptor>();

  constructor(private readonly deps: ChannelRegistryDeps) {}

  get channelIds(): string[] {
    return [...this.#actors.keys()];
  }

  /** Channels currently holding a running turn (inactivity monitor input). */
  get turnsInFlight(): number {
    let count = 0;
    for (const actor of this.#actors.values()) {
      if (actor.activeTurn !== null) count += 1;
    }
    return count;
  }

  has(channelId: string): boolean {
    return this.#actors.has(channelId);
  }

  descriptor(channelId: string): ChannelDescriptor | undefined {
    return this.#descriptors.get(channelId);
  }

  /** Adds a channel, or updates its metadata if already present. */
  add(descriptor: ChannelDescriptor): ChannelActor {
    this.#descriptors.set(descriptor.channelId, descriptor);
    const existing = this.#actors.get(descriptor.channelId);
    if (existing) return existing;

    this.deps.state.channels.upsert({
      relayId: this.deps.relayId,
      channelId: descriptor.channelId,
      status: "active",
      name: descriptor.name,
      channelType: descriptor.channelType,
      piSessionId: null,
      piSessionPath: null,
      lastSeenCreatedAt: null,
    });

    const actorDeps: ChannelActorDeps = {
      relayId: this.deps.relayId,
      channelId: descriptor.channelId,
      channelName: descriptor.name,
      channelType: descriptor.channelType,
      state: this.deps.state,
      telemetry: this.deps.telemetry,
      output: this.deps.output,
      clock: this.deps.clock,
      logger: this.deps.logger.child({ channelId: descriptor.channelId }),
      acquireSession: (threadRootId: string | null, options: AcquireSessionOptions) =>
        this.deps.sessions.acquire(sessionKeyFor(descriptor.channelId, threadRootId), options),
      releaseChannelSessions: () => this.deps.sessions.releaseForChannel(descriptor.channelId),
      fetchHistory: (event, threadRootId, opts) =>
        this.deps.fetchHistory(event, threadRootId, opts),
      resolveAuthorLabel: (pubkey) => this.deps.resolveAuthorLabel(pubkey),
      selfName: this.deps.selfName,
      observeUsage: (sessionId, turnId, usage) => this.deps.observeUsage(sessionId, turnId, usage),
      publishUsage: (turn, sessionId, stopReason) =>
        this.deps.publishUsage(turn, sessionId, stopReason),
      newTurnId: () => this.deps.newTurnId(),
      idleTimeoutMs: this.deps.idleTimeoutMs,
      maxTurnDurationMs: this.deps.maxTurnDurationMs,
      concurrency: this.deps.concurrency,
    };

    const actor = new ChannelActor(actorDeps);
    this.#actors.set(descriptor.channelId, actor);
    this.deps.logger.info("channel activated", { channelId: descriptor.channelId });
    return actor;
  }

  /** Routes an already-gated event to its channel. Unknown channels are dropped. */
  submit(channelId: string, accepted: AcceptedEvent): boolean {
    const actor = this.#actors.get(channelId);
    if (!actor) return false;
    actor.submit(accepted);
    return true;
  }

  async remove(channelId: string): Promise<void> {
    const actor = this.#actors.get(channelId);
    if (!actor) return;
    this.#actors.delete(channelId);
    this.#descriptors.delete(channelId);

    await actor.close();
    await this.deps.sessions.releaseForChannel(channelId);
    this.deps.state.channels.setStatus(this.deps.relayId, channelId, "removed");
    this.deps.logger.info("channel deactivated", { channelId });
  }

  cancel(channelId: string, reason: string): void {
    this.#actors.get(channelId)?.cancel(reason);
  }

  cancelAll(reason: string): void {
    for (const actor of this.#actors.values()) actor.cancel(reason);
  }

  rotate(channelId: string): void {
    this.#actors.get(channelId)?.rotate();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#actors.values()].map((actor) => actor.close()));
    this.#actors.clear();
    this.#descriptors.clear();
  }
}
