/**
 * Process lifecycle and wiring (plan §5.1).
 *
 * Boot is ordered so the agent is never partially live: identity and
 * provisioning are proven before a socket opens, the outbox is recovered before
 * presence goes online, and `online` is published only once the agent can
 * actually answer. Shutdown reverses it — stop accepting, drain, go offline.
 */

import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../config.js";
import { createEventBuilder, type AgentEventBuilder } from "../nostr/event-builder.js";
import { MembershipManager, type ChannelInfo } from "../nostr/memberships.js";
import { PresencePublisher } from "../nostr/presence.js";
import { ProfileReconciler, type AgentProfileSnapshot } from "../nostr/profile.js";
import { OutboxPublisher } from "../nostr/publisher.js";
import { RelaySupervisor } from "../nostr/relay-supervisor.js";
import { verifyNostrEvent, type Signer } from "../nostr/signer.js";
import type { AuthTag } from "../nostr/nip-oa.js";
import { KIND, channelIdOf, type NostrEvent } from "../nostr/types.js";
import { AuthorGate, type ChannelType as GateChannelType } from "../security/author-gate.js";
import { parseControlCommand } from "../security/control-commands.js";
import { resolveToolPolicy, toPiToolConfig } from "../security/tool-policy.js";
import { openDatabase } from "../state/database.js";
import type { AgentState } from "../state/database.js";
import { applyRecovery, planRecovery } from "../state/recovery.js";
import { ObserverPublisher } from "../telemetry/observer-publisher.js";
import { UsagePublisher } from "../telemetry/usage-publisher.js";
import { UsageTracker } from "../telemetry/usage-tracker.js";
import { parseControlFrame } from "../telemetry/observer-envelope.js";
import { ChannelRegistry } from "./channel-registry.js";
import { ContextFetcher } from "./context-fetcher.js";
import { systemClock } from "./clock.js";
import { canonicalThreadRoot } from "./conversation-key.js";
import { OutputRouter } from "./output-router.js";
import type { Clock, Logger, RelayPort, SessionRegistryPort } from "./ports.js";
import { Semaphore } from "./scheduler.js";
import { SessionRegistry } from "./session-registry.js";
import type { TurnContext } from "./turn-context.js";
import { join } from "node:path";

export type RuntimePhase =
  | "boot"
  | "connecting"
  | "reconciling"
  | "subscribing"
  | "recovering"
  | "running"
  | "draining"
  | "stopped";

/**
 * Phases in which a membership change must not publish the roster on its own.
 *
 * Discovery grants channels one at a time; publishing per grant would put a
 * half-discovered set on the relay. `start` publishes once, after discovery.
 */
const PRE_LIVE_PHASES: ReadonlySet<RuntimePhase> = new Set<RuntimePhase>([
  "boot",
  "connecting",
  "reconciling",
  "subscribing",
]);

export interface AppRuntimeOptions {
  config: AgentConfig;
  signer: Signer;
  ownerPubkey: string;
  authTag: AuthTag;
  logger: Logger;
  clock?: Clock;
  /** Injected by tests; production builds a real relay supervisor. */
  relay?: RelayPort;
  /** Injected by tests; production opens the SQLite file under the state dir. */
  state?: AgentState;
  /** Injected by tests; production creates real Pi sessions through the SDK. */
  sessions?: SessionRegistryPort;
}

export class AppRuntime {
  #phase: RuntimePhase = "boot";
  readonly #config: AgentConfig;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #signer: Signer;
  readonly #ownerPubkey: string;
  readonly #builder: AgentEventBuilder;
  readonly #state: AgentState;
  readonly #relay: RelayPort;
  readonly #telemetry: ObserverPublisher;
  readonly #usageTracker: UsageTracker;
  readonly #usagePublisher: UsagePublisher;
  readonly #outboxPublisher: OutboxPublisher;
  readonly #sessions: SessionRegistryPort;
  readonly #registry: ChannelRegistry;
  readonly #memberships: MembershipManager;
  readonly #profiles: ProfileReconciler;
  readonly #presence: PresencePublisher;
  readonly #gate: AuthorGate;
  readonly #context: ContextFetcher;
  /** Serialises roster republication; the dirty flag collapses bursts. */
  #profileSync: Promise<void> = Promise.resolve();
  #profileDirty = false;
  /** Resolves when the process should exit. */
  readonly #stopped = deferred<void>();

  constructor(options: AppRuntimeOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#clock = options.clock ?? systemClock;
    this.#signer = options.signer;
    this.#ownerPubkey = options.ownerPubkey;

    this.#builder = createEventBuilder({
      signer: this.#signer,
      authTag: options.authTag,
      clock: this.#clock,
    });

    this.#state =
      options.state ?? openDatabase(join(this.#config.stateDir, "agent.db"), { now: () => this.#clock.now() });

    this.#relay =
      options.relay ??
      new RelaySupervisor({
        url: this.#config.relayUrl,
        builder: this.#builder,
        clock: this.#clock,
        logger: this.#logger.child({ component: "relay" }),
      });

    this.#telemetry = new ObserverPublisher({
      signer: this.#signer,
      ownerPubkey: this.#ownerPubkey,
      builder: this.#builder,
      relay: this.#relay,
      sessions: this.#state.sessions,
      clock: this.#clock,
      logger: this.#logger.child({ component: "telemetry" }),
      coalesceWindowMs: this.#config.telemetry.coalesceMs,
    });

    this.#usageTracker = new UsageTracker({
      sessions: this.#state.sessions,
      clock: this.#clock,
      harness: "pi",
    });

    this.#usagePublisher = new UsagePublisher({
      signer: this.#signer,
      ownerPubkey: this.#ownerPubkey,
      builder: this.#builder,
      // Metrics are durable, so they go through the same outbox as chat rather
      // than straight to the socket.
      publish: (event) => {
        this.#state.outbox.putSigned({
          logicalId: `metric:${event.id}`,
          eventId: event.id,
          kind: KIND.USAGE_METRIC,
          signedEvent: event,
          state: "pending",
          attempts: 0,
          nextRetryAt: this.#clock.now(),
          lastError: null,
        });
        this.#outboxPublisher.notify();
      },
      logger: this.#logger.child({ component: "usage" }),
    });

    this.#outboxPublisher = new OutboxPublisher({
      outbox: this.#state.outbox,
      relay: this.#relay,
      clock: this.#clock,
      logger: this.#logger.child({ component: "outbox" }),
    });

    const toolPolicy = resolveToolPolicy(this.#config.security, {
      cwd: this.#config.pi.cwd,
      stateDir: this.#config.stateDir,
      pi: this.#config.pi,
    });

    this.#sessions =
      options.sessions ??
      new SessionRegistry({
        config: { ...this.#config.pi, ...toPiToolConfig(toolPolicy) },
        channels: this.#state.channels,
        relayId: this.#config.relayId,
        logger: this.#logger.child({ component: "sessions" }),
      });

    this.#context = new ContextFetcher({
      relay: this.#relay,
      logger: this.#logger.child({ component: "context" }),
      limit: this.#config.scheduler.contextMessageLimit,
    });

    const output = new OutputRouter({
      outbox: this.#state.outbox,
      builder: this.#builder,
      config: this.#config.output,
      now: () => this.#clock.now(),
      notify: () => this.#outboxPublisher.notify(),
    });

    this.#registry = new ChannelRegistry({
      relayId: this.#config.relayId,
      state: this.#state,
      telemetry: this.#telemetry,
      output,
      sessions: this.#sessions,
      clock: this.#clock,
      logger: this.#logger.child({ component: "channel" }),
      fetchContext: (event, threadRootId) => this.#context.fetch(event, threadRootId),
      observeUsage: (sessionId, turnId, usage) =>
        this.#usageTracker.observe(sessionId, turnId, usage),
      publishUsage: (turn, sessionId, stopReason) =>
        this.#onTurnSettled(turn, sessionId, stopReason),
      newTurnId: () => randomUUID(),
      idleTimeoutMs: this.#config.scheduler.idleTimeoutSec * 1_000,
      maxTurnDurationMs: this.#config.scheduler.maxTurnDurationSec * 1_000,
      concurrency: new Semaphore(this.#config.scheduler.maxConcurrentTurns),
    });

    this.#gate = new AuthorGate({
      agentPubkey: this.#signer.publicKey,
      ownerPubkey: this.#ownerPubkey,
      respondTo: this.#config.security.respondTo,
      allowlist: this.#config.security.allowlist,
      siblingAgents: this.#config.security.siblingAgents,
      lookupProfile: (pubkey) => this.#lookupProfile(pubkey),
      logger: this.#logger.child({ component: "gate" }),
    });

    this.#memberships = new MembershipManager({
      relay: this.#relay,
      agentPubkey: this.#signer.publicKey,
      subscribeMode: this.#config.subscribe,
      channelAllowlist: this.#config.channels,
      logger: this.#logger.child({ component: "memberships" }),
      onMessage: (event, channel) => void this.#onInboundMessage(event, channel),
      onControl: (event) => void this.#onControlFrame(event),
      onChannelAdded: (channel) => this.#onChannelAdded(channel),
      onChannelRemoved: (channelId) => void this.#onChannelRemoved(channelId),
    });

    this.#profiles = new ProfileReconciler({
      relay: this.#relay,
      builder: this.#builder,
      profile: this.#config.profile,
      logger: this.#logger.child({ component: "profile" }),
    });

    this.#presence = new PresencePublisher({
      relay: this.#relay,
      builder: this.#builder,
      clock: this.#clock,
      heartbeatSec: this.#config.presence.heartbeatSec,
      logger: this.#logger.child({ component: "presence" }),
    });
  }

  get phase(): RuntimePhase {
    return this.#phase;
  }

  /** Resolves when the runtime has fully stopped. */
  get finished(): Promise<void> {
    return this.#stopped.promise;
  }

  async start(): Promise<void> {
    this.#relay.onTerminal((error) => {
      this.#logger.error("relay failed terminally, shutting down", { error: error.message });
      void this.stop("relay_terminal");
    });

    this.#phase = "connecting";
    await this.#relay.connect();

    // The snapshot comes from the persisted channel set, not from the (still
    // empty) live registry: a restart then republishes the roster it had rather
    // than flapping through "in no channel" before discovery catches up.
    this.#phase = "reconciling";
    const outcome = await this.#profiles.reconcile(this.#profileSnapshot());
    this.#logger.info("profile reconciled", { outcome });

    this.#phase = "subscribing";
    await this.#memberships.start();

    this.#phase = "recovering";
    // Discovery may have changed the set; publish it before going live.
    await this.#syncProfile("memberships_discovered");
    this.#recover();
    this.#outboxPublisher.start();

    if (this.#config.presence.enabled) await this.#presence.online();
    this.#phase = "running";
    this.#logger.info("agent online", {
      relayUrl: this.#config.relayUrl,
      channels: this.#registry.channelIds.length,
    });
  }

  async stop(reason: string): Promise<void> {
    if (this.#phase === "draining" || this.#phase === "stopped") return;
    this.#phase = "draining";
    this.#logger.info("draining", { reason });

    this.#memberships.stop();
    await this.#registry.closeAll();
    await this.#telemetry.flush();
    this.#telemetry.close();
    await this.#outboxPublisher.stop();
    // The roster entry is the one thing that outlives this process on the relay,
    // so its last word must not be "online".
    await this.#announceOffline();
    if (this.#config.presence.enabled) await this.#presence.offline();
    this.#presence.stop();
    await this.#sessions.disposeAll();
    await this.#relay.close();
    this.#state.close();

    this.#phase = "stopped";
    this.#stopped.resolve();
  }

  /* ------------------------------------------------------------------ */
  /* Inbound pipeline (plan §6.4)                                        */
  /* ------------------------------------------------------------------ */

  /**
   * The gate chain. Order matters: cheap structural checks run before signature
   * verification, and every trust decision runs before the event can reach Pi.
   */
  async #onInboundMessage(event: NostrEvent, channel: ChannelInfo): Promise<void> {
    if (event.pubkey === this.#signer.publicKey) return;
    if (!verifyNostrEvent(event)) {
      this.#logger.warn("rejected event with an invalid signature", { eventId: event.id });
      return;
    }

    const channelId = channelIdOf(event);
    if (!channelId || channelId !== channel.channelId) return;

    // Dedup before anything with a side effect, so a relay replay cannot produce
    // a second prompt for a message we already answered.
    const threadRootId = canonicalThreadRoot(event);
    const inserted = this.#state.inbox.insertIfAbsent({
      eventId: event.id,
      channelId,
      threadRootId,
      authorPubkey: event.pubkey,
      createdAt: event.created_at,
      receivedAt: this.#clock.now(),
      disposition: "queued",
      turnId: null,
      inputOrdinal: null,
      rawEvent: event,
    });
    if (!inserted) return;

    const control = parseControlCommand(event, {
      agentPubkey: this.#signer.publicKey,
      ownerPubkey: this.#ownerPubkey,
      // Buzz's composer writes the profile name into the body when it mentions
      // the agent, so the name is what has to come back off the command.
      agentName: this.#config.profile.name,
    });
    if (control) {
      this.#state.inbox.setDisposition(event.id, "completed");
      await this.#onControlCommand(control, channelId);
      return;
    }

    const gateType: GateChannelType = channel.metadataKnown ? channel.type : "unknown";
    const decision = await this.#gate.evaluate({
      authorPubkey: event.pubkey,
      channelType: gateType,
    });
    if (!decision.allowed) {
      this.#state.inbox.setDisposition(event.id, "rejected");
      this.#logger.debug("event rejected by author gate", {
        eventId: event.id,
        code: decision.code,
      });
      return;
    }

    if (!this.#registry.has(channelId)) this.#onChannelAdded(channel);
    this.#state.channels.setLastSeen(this.#config.relayId, channelId, event.created_at);
    this.#registry.submit(channelId, { event, promptTag: "@mention" });
  }

  #onChannelAdded(channel: ChannelInfo): void {
    const known = this.#registry.has(channel.channelId);
    this.#registry.add({
      channelId: channel.channelId,
      name: channel.name,
      channelType: channel.type,
    });
    if (!known) void this.#syncProfile("membership_granted");
  }

  async #onChannelRemoved(channelId: string): Promise<void> {
    await this.#registry.remove(channelId);
    await this.#syncProfile("membership_revoked");
  }

  /* ------------------------------------------------------------------ */
  /* Roster entry (kind 10100)                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The channel set as the roster should describe it.
   *
   * Read from the database rather than the registry because `add`/`remove`
   * write through to it, so it is the one view that is also correct at boot,
   * before any subscription exists. Ids are sorted: the reconciler suppresses
   * republication by fingerprint, and an unstable order would defeat it.
   *
   * Human-readable names are deliberately left empty — the agent is told channel
   * ids, and Desktop resolves ids first (`resolveManagedAgentChannelId`).
   */
  #profileSnapshot(): AgentProfileSnapshot {
    const channelIds = this.#state.channels
      .active(this.#config.relayId)
      .map((channel) => channel.channelId)
      .sort();
    return { status: "online", capabilities: [], channels: [], channelIds };
  }

  /**
   * Republish the kind 10100 roster entry after a membership change.
   *
   * Not cosmetic: Buzz Desktop reads `channel_ids` out of this event's content
   * and stops a provider-deployed agent by sending `!shutdown` into one of
   * those channels. An agent whose roster entry claims no channels cannot be
   * stopped from the UI at all ("Cannot stop: agent is not in any channel").
   *
   * Calls are serialised and coalesced: a burst of grants during discovery
   * collapses into one publication of the final set.
   */
  /** Best-effort farewell; a relay that will not take it never blocks the drain. */
  async #announceOffline(): Promise<void> {
    try {
      const result = await this.#profiles.publishAgentProfile({
        ...this.#profileSnapshot(),
        status: "offline",
      });
      if (!result.ok) this.#logger.warn("roster farewell rejected", { message: result.message });
    } catch (error) {
      this.#logger.warn("roster farewell failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #syncProfile(reason: string): Promise<void> {
    this.#profileDirty = true;
    this.#profileSync = this.#profileSync.then(() => this.#drainProfileSync(reason));
    return this.#profileSync;
  }

  async #drainProfileSync(reason: string): Promise<void> {
    // Every early return leaves the dirty flag standing, so the change is not
    // lost: it is published by the next drain that is allowed to run.
    if (!this.#profileDirty) return;
    if (PRE_LIVE_PHASES.has(this.#phase)) return;
    if (this.#phase === "draining" || this.#phase === "stopped") return;
    this.#profileDirty = false;

    const snapshot = this.#profileSnapshot();
    try {
      const outcome = await this.#profiles.reconcile(snapshot);
      if (outcome.agentProfilePublished) {
        this.#logger.info("roster entry republished", {
          reason,
          channels: snapshot.channelIds.length,
        });
      }
    } catch (error) {
      // A roster that failed to publish degrades Desktop's Stop button; it must
      // not take down an agent that is otherwise answering. Stay dirty so the
      // next membership change retries.
      this.#profileDirty = true;
      this.#logger.warn("roster republication failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #onControlCommand(command: string, channelId: string): Promise<void> {
    switch (command) {
      case "cancel":
        this.#registry.cancel(channelId, "owner_cancel");
        return;
      case "rotate":
        this.#registry.rotate(channelId);
        return;
      case "shutdown":
        await this.stop("owner_shutdown");
        return;
    }
  }

  /** Owner -> agent NIP-AO control frames (plan §6.9). */
  async #onControlFrame(event: NostrEvent): Promise<void> {
    if (event.pubkey !== this.#ownerPubkey) return;
    if (!verifyNostrEvent(event)) return;

    let payload: unknown;
    try {
      payload = JSON.parse(this.#signer.decrypt(event.pubkey, event.content));
    } catch {
      this.#logger.debug("undecryptable control frame", { eventId: event.id });
      return;
    }

    const control = parseControlFrame(payload);
    if (!control) return;

    switch (control.type) {
      case "cancel_turn":
        this.#registry.cancel(control.channelId, "control_cancel");
        this.#emitControlResult("cancel_turn", true, control.channelId);
        return;
      case "switch_model": {
        const channels = control.channelId ? [control.channelId] : this.#registry.channelIds;
        let ok = true;
        for (const channelId of channels) {
          try {
            const session = await this.#sessions.acquire(channelId);
            await session.setModel(control.model);
          } catch (error) {
            ok = false;
            this.#logger.warn("model switch failed", { channelId, error });
          }
        }
        this.#emitControlResult("switch_model", ok, control.channelId ?? null);
        return;
      }
    }
  }

  #emitControlResult(request: string, ok: boolean, channelId: string | null): void {
    this.#telemetry.emit({
      kind: "raw_json_rpc",
      channelId,
      sessionId: null,
      turnId: null,
      payload: { type: "control_result", request, ok, channelId },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Turn accounting                                                     */
  /* ------------------------------------------------------------------ */

  #onTurnSettled(turn: TurnContext, sessionId: string | null, stopReason: string): void {
    if (!this.#config.telemetry.metricsEnabled || !sessionId) return;

    const payload = this.#usageTracker.settle({
      sessionId,
      turnId: turn.turnId,
      channelId: turn.channelId,
      model: null,
      stopReason: toStopReason(stopReason),
    });
    // Absent when the provider reported nothing: NIP-AM forbids publishing a
    // metric whose every counter is unknown.
    if (payload) void this.#usagePublisher.publish(payload);
  }

  /* ------------------------------------------------------------------ */
  /* Recovery                                                            */
  /* ------------------------------------------------------------------ */

  #recover(): void {
    const plan = planRecovery(this.#state, this.#clock.now());
    applyRecovery(this.#state, plan);
    if (plan.resend.length > 0 || plan.requeue.length > 0 || plan.interrupt.length > 0) {
      this.#logger.warn("recovered interrupted work", {
        resend: plan.resend.length,
        requeue: plan.requeue.length,
        interrupted: plan.interrupt.length,
        deadLettered: plan.deadLetter.length,
      });
    }
  }

  async #lookupProfile(pubkey: string): Promise<{ pubkey: string; tags: NostrEvent["tags"] } | null> {
    const events = await this.#relay.query([{ kinds: [KIND.METADATA], authors: [pubkey], limit: 1 }]);
    const profile = events[0];
    return profile ? { pubkey, tags: profile.tags } : null;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function toStopReason(reason: string): "end_turn" | "cancelled" | "error" | "unknown" {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "owner_cancel":
    case "control_cancel":
    case "shutdown":
    case "rotated":
    case "idle_timeout":
    case "max_duration":
      return "cancelled";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}
