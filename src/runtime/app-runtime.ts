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
import type { RecordClient } from "../nostr/record-client.js";
import {
  CONFIG_SLUG,
  AUTH_SLUG,
  type RecordHead,
} from "../nostr/config-records.js";
import {
  authContentFromValue,
  authValueFromContent,
  digestOf,
  materializeAuth,
  readLocalAuth,
  recordAuthSynced,
  watchAuthFile,
} from "./provider-auth.js";
import { applyCoreConfig, parseCoreConfig } from "./remote-config.js";
import { BuzzCliBroker, GitAuthProxy, httpOriginOf } from "../tools/index.js";
import { BUZZ_CLI_PROMPT } from "../prompts/buzz-cli.js";
import { toNostrTag } from "../nostr/nip-oa.js";
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
import { InactivityMonitor } from "./inactivity.js";
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

/**
 * Post-drain finalisation reserve (remote plan §6.2.6): presence offline, the
 * roster farewell and the relay close must always get at least this much of
 * the shutdown budget, and the drain may never eat into it.
 */
export const SHUTDOWN_FINALIZE_RESERVE_MS = 7_000;

/**
 * Remote (record-configured) mode, prepared by `main.ts` (remote plan §3).
 *
 * The initial head fetch happens before the runtime is constructed — the
 * effective config feeds the constructor — so this block carries the outcome:
 * the client for live updates, which heads were missing (degraded until they
 * appear), and the env-derived base config that record overlays are applied to.
 */
export interface RemoteRuntimeOptions {
  records: RecordClient;
  /** Env-derived config before the core-record overlay. */
  baseConfig: AgentConfig;
  missing: { core: boolean; providerAuth: boolean };
  coreHeadCreatedAt: number;
  authHeadCreatedAt: number;
}

export interface AppRuntimeOptions {
  config: AgentConfig;
  signer: Signer;
  ownerPubkey: string;
  authTag: AuthTag;
  logger: Logger;
  clock?: Clock;
  /** Present when the agent is record-configured (remote plan §3.3). */
  remote?: RemoteRuntimeOptions;
  /** Injected by tests; production builds a real relay supervisor. */
  relay?: RelayPort;
  /** Injected by tests; production opens the SQLite file under the state dir. */
  state?: AgentState;
  /** Injected by tests; production creates real Pi sessions through the SDK. */
  sessions?: SessionRegistryPort;
  /**
   * Agent secret as 64-char hex, for the buzz CLI broker only (buzz-cli plan
   * §3). Absent in tests — the broker is simply not started then.
   */
  buzzSecretHex?: string;
}

export class AppRuntime {
  #phase: RuntimePhase = "boot";
  #config: AgentConfig;
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
  readonly #concurrency: Semaphore;
  readonly #remote: RemoteRuntimeOptions | null;
  /** Heads the agent still lacks; non-empty means degraded (prompts refused). */
  readonly #missing = { core: false, providerAuth: false };
  #coreHeadCreatedAt = 0;
  #authHeadCreatedAt = 0;
  #stopAuthWatcher: (() => void) | null = null;
  readonly #inactivity: InactivityMonitor;
  readonly #gitProxy: GitAuthProxy;
  readonly #buzzBroker: BuzzCliBroker | null;
  #stopReason: string | null = null;
  /** Serialises roster republication; the dirty flag collapses bursts. */
  #profileSync: Promise<void> = Promise.resolve();
  #profileDirty = false;
  /** Resolves when the process should exit. */
  readonly #stopped = deferred<void>();

  constructor(options: AppRuntimeOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#remote = options.remote ?? null;
    if (this.#remote) {
      this.#missing.core = this.#remote.missing.core;
      this.#missing.providerAuth = this.#remote.missing.providerAuth;
      this.#coreHeadCreatedAt = this.#remote.coreHeadCreatedAt;
      this.#authHeadCreatedAt = this.#remote.authHeadCreatedAt;
    }
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

    const httpOrigin = httpOriginOf(this.#config.relayUrl);
    this.#gitProxy = new GitAuthProxy({
      upstreamOrigin: httpOrigin,
      builder: this.#builder,
      clock: this.#clock,
      logger: this.#logger.child({ component: "git-proxy" }),
    });

    // The broker reads the flag and denylist through closures, so a core
    // record push (#onCoreRecord) binds without restarting anything.
    this.#buzzBroker = options.buzzSecretHex
      ? new BuzzCliBroker({
          relayHttpOrigin: httpOrigin,
          secretHex: options.buzzSecretHex,
          authTagJson: JSON.stringify(toNostrTag(options.authTag)),
          gitProxy: this.#gitProxy,
          enabled: () => this.#config.buzzCli.enabled,
          denyCommands: () => this.#config.buzzCli.denyCommands,
          clock: this.#clock,
          logger: this.#logger.child({ component: "buzz-cli" }),
        })
      : null;

    this.#sessions =
      options.sessions ??
      new SessionRegistry({
        config: { ...this.#config.pi, ...toPiToolConfig(toolPolicy) },
        channels: this.#state.channels,
        relayId: this.#config.relayId,
        logger: this.#logger.child({ component: "sessions" }),
        systemPromptPrelude: () => (this.#config.buzzCli.enabled ? [BUZZ_CLI_PROMPT] : []),
      });

    this.#context = new ContextFetcher({
      relay: this.#relay,
      logger: this.#logger.child({ component: "context" }),
      limit: this.#config.scheduler.contextMessageLimit,
      agentPubkey: this.#signer.publicKey,
      deliveredDispositionOf: (eventId) => this.#state.inbox.get(eventId)?.disposition ?? null,
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
      fetchContext: (event, threadRootId, opts) => this.#context.fetch(event, threadRootId, opts),
      observeUsage: (sessionId, turnId, usage) =>
        this.#usageTracker.observe(sessionId, turnId, usage),
      publishUsage: (turn, sessionId, stopReason) =>
        this.#onTurnSettled(turn, sessionId, stopReason),
      newTurnId: () => randomUUID(),
      idleTimeoutMs: this.#config.scheduler.idleTimeoutSec * 1_000,
      maxTurnDurationMs: this.#config.scheduler.maxTurnDurationSec * 1_000,
      concurrency: (this.#concurrency = new Semaphore(this.#config.scheduler.maxConcurrentTurns)),
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

    this.#inactivity = new InactivityMonitor({
      clock: this.#clock,
      isBusy: () => this.#registry.turnsInFlight > 0,
      onExpire: () => void this.stop("inactivity"),
      logger: this.#logger.child({ component: "inactivity" }),
    });
  }

  get phase(): RuntimePhase {
    return this.#phase;
  }

  /** True while a required record head is missing or revoked (plan §6.2.8). */
  get degraded(): boolean {
    return this.#missing.core || this.#missing.providerAuth;
  }

  /** Resolves when the runtime has fully stopped. */
  get finished(): Promise<void> {
    return this.#stopped.promise;
  }

  /** Why the runtime stopped; null while it is still running. */
  get stopReason(): string | null {
    return this.#stopReason;
  }

  async start(): Promise<void> {
    this.#relay.onTerminal((error) => {
      this.#logger.error("relay failed terminally, shutting down", { error: error.message });
      void this.stop("relay_terminal");
    });

    if (this.#buzzBroker) {
      try {
        await this.#buzzBroker.start();
      } catch (error) {
        // A dead broker degrades the CLI (shim exits 4), not the agent.
        this.#logger.warn("buzz CLI broker failed to start", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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
    this.#startRemote();

    this.#phase = "recovering";
    // Discovery may have changed the set; publish it before going live.
    await this.#syncProfile("memberships_discovered");
    this.#recover();
    this.#outboxPublisher.start();

    if (this.#config.presence.enabled) {
      if (this.degraded) this.#presence.degraded();
      else this.#presence.online();
    }
    this.#inactivity.arm(this.#config.lifecycle.inactivityExitSec);
    this.#phase = "running";
    this.#logger.info(this.degraded ? "agent online (degraded)" : "agent online", {
      relayUrl: this.#config.relayUrl,
      channels: this.#registry.channelIds.length,
      ...(this.degraded ? { missing: { ...this.#missing } } : {}),
    });
  }

  /**
   * Graceful shutdown with a bounded tail (remote plan §6.2.6).
   *
   * The whole post-signal path must fit the substrate's grace budget
   * (`lifecycle.shutdownBudgetSec`, k8s: terminationGracePeriodSeconds 60).
   * A finalisation reserve is carved out up front — presence offline, the
   * roster farewell and the relay close are the parts an abandoned Pod cannot
   * repair later — and the drain is what degrades when time runs out: turns
   * are cancelled and the flush is abandoned, never the farewell.
   */
  async stop(reason: string): Promise<void> {
    if (this.#phase === "draining" || this.#phase === "stopped") return;
    this.#phase = "draining";
    this.#stopReason = reason;
    this.#logger.info("draining", { reason });

    const budgetMs = this.#config.lifecycle.shutdownBudgetSec * 1000;
    const reserveMs = Math.min(SHUTDOWN_FINALIZE_RESERVE_MS, Math.floor(budgetMs / 2));
    const drainDeadline = this.#clock.now() + budgetMs - reserveMs;

    this.#inactivity.stop();
    this.#stopAuthWatcher?.();
    this.#stopAuthWatcher = null;
    this.#memberships.stop();

    const drained = await this.#withDeadline(this.#registry.closeAll(), drainDeadline, "drain");
    if (!drained) {
      // Out of drain budget: cancel everything and give the actors a moment to
      // observe the abort before the finalisation tail runs.
      this.#registry.cancelAll("shutdown");
      await this.#withDeadline(this.#registry.closeAll(), this.#clock.now() + 2_000, "drain-abort");
    }
    await this.#withDeadline(this.#telemetry.flush(), drainDeadline, "telemetry-flush");
    this.#telemetry.close();
    await this.#withDeadline(this.#outboxPublisher.stop(), drainDeadline, "outbox-stop");

    this.#buzzBroker?.close();
    this.#gitProxy.close();
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

  /** Races `work` against a wall-clock deadline. Returns false on timeout. */
  async #withDeadline(work: Promise<unknown>, deadlineAt: number, label: string): Promise<boolean> {
    const remaining = deadlineAt - this.#clock.now();
    if (remaining <= 0) {
      this.#logger.warn("shutdown step skipped: budget exhausted", { label });
      return false;
    }
    const timeout = Symbol("timeout");
    const timer = new Promise<typeof timeout>((resolve) => {
      this.#clock.setTimeout(() => resolve(timeout), remaining);
    });
    const outcome = await Promise.race([work.then(() => true), timer]);
    if (outcome === timeout) {
      this.#logger.warn("shutdown step timed out", { label, budgetMs: remaining });
      return false;
    }
    return true;
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

    // Degraded is fail-closed for prompts but stays open for the owner's
    // control commands (handled above): the agent must remain stoppable and
    // diagnosable while it refuses to run "empty" (plan §3.2, §6.2.8).
    if (this.degraded) {
      this.#state.inbox.setDisposition(event.id, "rejected");
      this.#logger.warn("prompt refused: agent is degraded", {
        eventId: event.id,
        missing: { ...this.#missing },
      });
      return;
    }

    if (!this.#registry.has(channelId)) this.#onChannelAdded(channel);
    this.#state.channels.setLastSeen(this.#config.relayId, channelId, event.created_at);
    this.#inactivity.noteActivity();
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

  /* ------------------------------------------------------------------ */
  /* Remote mode: record subscription, hot config, auth write-back       */
  /* ------------------------------------------------------------------ */

  #startRemote(): void {
    const remote = this.#remote;
    if (!remote) return;

    remote.records.subscribe([CONFIG_SLUG, AUTH_SLUG], (slug, head) => {
      if (slug === CONFIG_SLUG) void this.#onCoreRecord(head);
      else void this.#onAuthRecord(head);
    });

    this.#stopAuthWatcher = watchAuthFile({
      stateDir: this.#config.stateDir,
      logger: this.#logger.child({ component: "auth-watcher" }),
      onRefresh: (content) => void this.#writeBackAuth(content),
    });
  }

  /** Applies a new core-record head on the fly (plan §3.3). */
  async #onCoreRecord(head: RecordHead): Promise<void> {
    const remote = this.#remote;
    if (!remote) return;
    if (head.createdAt <= this.#coreHeadCreatedAt) return;
    if (head.body.slug !== CONFIG_SLUG) return;

    const parsed = parseCoreConfig(head.body.value);
    if (!parsed.config) {
      // A malformed head keeps the previous config: stale beats broken.
      this.#logger.warn("rejected core record update", { problems: parsed.problems });
      return;
    }
    this.#coreHeadCreatedAt = head.createdAt;

    const next = applyCoreConfig(remote.baseConfig, parsed.config);
    // respond_to / allowlist and scheduler ceilings bind immediately; model,
    // thinking, prompt and tools bind per-session, lazily.
    this.#gate.updatePolicy({
      respondTo: next.security.respondTo,
      allowlist: next.security.allowlist,
    });
    this.#concurrency.setPermits(next.scheduler.maxConcurrentTurns);
    this.#context.setLimit(next.scheduler.contextMessageLimit);
    await this.#sessions.applyConfig?.({
      model: next.pi.model,
      thinkingLevel: next.pi.thinkingLevel,
      appendSystemPrompt: next.pi.appendSystemPrompt,
      tools: next.pi.tools,
      excludeTools: next.pi.excludeTools,
      extensions: next.pi.extensions,
    });
    this.#config = { ...next, stateDir: this.#config.stateDir, relayUrl: this.#config.relayUrl };
    this.#inactivity.arm(next.lifecycle.inactivityExitSec);

    this.#logger.info("core record applied", { createdAt: head.createdAt });
    if (this.#missing.core) {
      this.#missing.core = false;
      this.#maybeLeaveDegraded();
    }
  }

  /** Materialises a newer provider-auth head, or degrades on a tombstone. */
  async #onAuthRecord(head: RecordHead): Promise<void> {
    if (head.createdAt <= this.#authHeadCreatedAt) return;
    const body = head.body;
    if (body.slug !== AUTH_SLUG) return;
    this.#authHeadCreatedAt = head.createdAt;

    if (body.value === null) {
      // Owner revoked the credentials. Fail closed now rather than at the
      // next provider call: prompts stop, presence flips to degraded.
      this.#logger.warn("provider-auth record tombstoned; entering degraded mode");
      this.#missing.providerAuth = true;
      if (this.#config.presence.enabled) this.#presence.degraded();
      return;
    }

    const content = authContentFromValue(body.value);
    if (content === null) return;

    const local = await readLocalAuth(this.#config.stateDir);
    if (local !== null && digestOf(local) === digestOf(content)) {
      // Our own write-back echoing off the relay; just move the watermark.
      await recordAuthSynced(this.#config.stateDir, content, head.createdAt);
      return;
    }
    await materializeAuth(this.#config.stateDir, content, head.createdAt);
    this.#logger.info("provider-auth record materialised", { createdAt: head.createdAt });
    if (this.#missing.providerAuth) {
      this.#missing.providerAuth = false;
      this.#maybeLeaveDegraded();
    }
  }

  /** Publishes a pi OAuth refresh back to the relay (plan §3.2 write-back). */
  async #writeBackAuth(content: string): Promise<void> {
    const remote = this.#remote;
    if (!remote) return;
    const value = authValueFromContent(content);
    if (value === null) {
      this.#logger.warn("provider-auth write-back skipped: auth.json is not a JSON object");
      return;
    }
    try {
      const head = await remote.records.publish(
        AUTH_SLUG,
        { slug: AUTH_SLUG, value },
        { createdAt: this.#authHeadCreatedAt },
      );
      this.#authHeadCreatedAt = head.createdAt;
      await recordAuthSynced(this.#config.stateDir, content, head.createdAt);
      this.#logger.info("provider-auth write-back published", { createdAt: head.createdAt });
    } catch (error) {
      // The token still works locally; the next refresh (or restart) retries.
      this.#logger.warn("provider-auth write-back failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #maybeLeaveDegraded(): void {
    if (this.degraded) return;
    if (this.#phase !== "running") return;
    this.#logger.info("leaving degraded mode: all required record heads present");
    if (this.#config.presence.enabled) this.#presence.online();
  }

  async #onControlCommand(command: string, channelId: string): Promise<void> {
    this.#inactivity.noteActivity();
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
    // A settling turn refreshes the inactivity window: the ceiling measures
    // silence after the last work, not since the last inbound event.
    this.#inactivity.noteActivity();
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
