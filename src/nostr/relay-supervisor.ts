/**
 * Supervised relay connection (plan §5.2, §6.1).
 *
 * Owns the socket, the NIP-42 handshake, reconnect backoff, replay floors and
 * rate-limit gating. Callers register subscriptions once and stay registered
 * across reconnects; nothing above this layer knows a socket exists.
 *
 * The socket itself is injected so the whole state machine can be driven by a
 * scripted in-process relay under a fake clock.
 */

import type WebSocketNS from "ws";
import WebSocket from "ws";
import { nullLogger } from "../runtime/logger.js";
import type {
  Clock,
  Logger,
  PublishResult,
  RelayPort,
  RelayState,
  SubscribeOptions,
  Subscription,
} from "../runtime/ports.js";
import type { EventBuilderPort } from "../runtime/ports.js";
import { buildAuthEvent } from "./nip42.js";
import { SubscriptionRecord, SubscriptionRegistry } from "./subscriptions.js";
import type { ClientMessage, NostrEvent, NostrFilter, RelayMessage } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Timings                                                                    */
/* -------------------------------------------------------------------------- */

export const CONNECT_TIMEOUT_MS = 30_000;
export const AUTH_TIMEOUT_MS = 20_000;
export const PUBLISH_TIMEOUT_MS = 20_000;
export const QUERY_TIMEOUT_MS = 10_000;
export const BACKOFF_LADDER_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];
export const BACKOFF_JITTER = 0.2;
/** Connect attempts before startup gives up; reconnects after that are unbounded. */
export const STARTUP_ATTEMPTS = 5;
/** Uptime after which the backoff ladder is considered recovered. */
export const STABILITY_RESET_MS = 60_000;
/** Spacing applied to REQs parked behind a rate-limit gate. */
export const REQ_DRAIN_SPACING_MS = 125;
export const RATE_LIMIT_DEFAULT_MS = 5_000;
/** Hints shorter than this are ignored in favour of the default. */
export const RATE_LIMIT_MIN_HINT_MS = 2_000;

/* -------------------------------------------------------------------------- */
/* Failure classification                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Relay message prefixes that retrying cannot fix.
 *
 * Everything else — including `error:` — is treated as transient, because a
 * relay that is merely unhappy right now will accept the same bytes later.
 */
const TERMINAL_PREFIXES = ["invalid:", "auth-required:", "restricted:", "blocked:"] as const;

export function isTerminalRelayMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return TERMINAL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isRateLimitedMessage(message: string): boolean {
  return message.toLowerCase().includes("rate-limited:");
}

/** Parses the `retry in {N}s` hint relays attach to rate-limit messages. */
export function retryHintMs(message: string): number | null {
  const match = /retry in\s+(\d+(?:\.\d+)?)\s*s/i.exec(message);
  if (match === null) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

/** 408/429/5xx are the statuses a relay recovers from; the rest are permanent. */
export function isTerminalHttpStatus(status: number): boolean {
  if (status === 408 || status === 429) return false;
  if (status >= 500 && status <= 599) return false;
  return true;
}

/** A failure that reconnecting cannot resolve; the supervisor stops for good. */
export class TerminalRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalRelayError";
  }
}

/* -------------------------------------------------------------------------- */
/* Socket abstraction                                                         */
/* -------------------------------------------------------------------------- */

export interface RelaySocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
  onError(error: Error): void;
  /** The WebSocket upgrade was answered with an HTTP response instead of 101. */
  onHttpStatus(status: number): void;
}

export interface RelaySocket {
  send(data: string): void;
  close(): void;
}

export type RelaySocketFactory = (url: string, handlers: RelaySocketHandlers) => RelaySocket;

export function wsSocketFactory(): RelaySocketFactory {
  return (url, handlers) => {
    const socket = new WebSocket(url);
    socket.on("open", () => handlers.onOpen());
    socket.on("message", (data: WebSocketNS.RawData) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data as ArrayBufferLike).toString("utf8");
      handlers.onMessage(text);
    });
    socket.on("close", (code: number, reason: Buffer) =>
      handlers.onClose(code, reason.toString("utf8")),
    );
    socket.on("error", (error: Error) => handlers.onError(error));
    socket.on("unexpected-response", (_request, response) =>
      handlers.onHttpStatus(response.statusCode ?? 0),
    );
    return {
      send: (data) => socket.send(data),
      close: () => socket.close(),
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Rate-limit gate                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Holds REQs back while the relay says we are going too fast.
 *
 * Deadlines only ever extend: two overlapping rate-limit notices must not let
 * the second, shorter one release traffic the first one was still holding.
 */
export class RateLimitGate {
  #until = 0;
  #queue: Array<() => void> = [];
  #draining = false;

  constructor(private readonly clock: Clock) {}

  get gated(): boolean {
    return this.clock.now() < this.#until;
  }

  get deadline(): number {
    return this.#until;
  }

  /** Arms from a relay message. Returns true when the message was a rate limit. */
  arm(message: string): boolean {
    if (!isRateLimitedMessage(message)) return false;
    const hint = retryHintMs(message);
    this.armFor(hint === null || hint < RATE_LIMIT_MIN_HINT_MS ? RATE_LIMIT_DEFAULT_MS : hint);
    return true;
  }

  armFor(ms: number): void {
    this.#until = Math.max(this.#until, this.clock.now() + ms);
  }

  /** Parks `run` behind the gate. Returns false when the caller may run now. */
  defer(run: () => void): boolean {
    if (!this.gated && this.#queue.length === 0) return false;
    this.#queue.push(run);
    void this.#drain();
    return true;
  }

  /**
   * Resolves once the gate is open, without taking a drain slot.
   *
   * Durable publishes use this rather than `defer` so the serial outbox keeps
   * its `(turnId, ordinal)` order instead of being interleaved with REQs.
   */
  async open(): Promise<void> {
    for (;;) {
      const remaining = this.#until - this.clock.now();
      if (remaining <= 0) return;
      await this.clock.sleep(remaining);
    }
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const remaining = this.#until - this.clock.now();
        if (remaining > 0) {
          await this.clock.sleep(remaining);
          continue;
        }
        this.#queue.shift()?.();
        if (this.#queue.length > 0) await this.clock.sleep(REQ_DRAIN_SPACING_MS);
      }
    } finally {
      this.#draining = false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Supervisor                                                                 */
/* -------------------------------------------------------------------------- */

export interface RelaySupervisorOptions {
  url: string;
  /**
   * Signs the NIP-42 handshake. Only `build()` is used, so owner-side commands
   * can supply a plain builder instead of the agent's attested one.
   */
  builder: EventBuilderPort;
  clock: Clock;
  logger?: Logger;
  socketFactory?: RelaySocketFactory;
  /** Jitter source. Injected so backoff timings are assertable. */
  random?: () => number;
  /** Called once when the supervisor gives up for good. */
  onTerminal?: (error: Error) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface OkWaiter {
  resolve(result: { ok: boolean; message: string }): void;
  reject(error: unknown): void;
}

interface QueryState {
  events: NostrEvent[];
  finish(reason?: string): void;
}

export class RelaySupervisor implements RelayPort {
  readonly #url: string;
  readonly #builder: EventBuilderPort;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #factory: RelaySocketFactory;
  readonly #random: () => number;
  readonly #onTerminal: ((error: Error) => void) | undefined;

  readonly #registry: SubscriptionRegistry;
  readonly #gate: RateLimitGate;
  readonly #okWaiters = new Map<string, OkWaiter>();
  readonly #queries = new Map<string, QueryState>();
  readonly #stateListeners = new Set<(state: RelayState) => void>();
  readonly #terminalListeners = new Set<(error: Error) => void>();
  readonly #abort = new AbortController();
  readonly #ready = deferred<void>();

  #state: RelayState = "disconnected";
  #socket: RelaySocket | null = null;
  #challenge: string | null = null;
  #challengeWaiter: Deferred<string> | null = null;
  #supervising = false;
  #closed = false;
  #fatal: Error | null = null;
  #everConnected = false;
  #attempt = 0;
  #querySeq = 0;
  #cancelStability: (() => void) | null = null;

  constructor(options: RelaySupervisorOptions) {
    this.#url = options.url;
    this.#builder = options.builder;
    this.#clock = options.clock;
    this.#logger = (options.logger ?? nullLogger).child({ relay: options.url });
    this.#factory = options.socketFactory ?? wsSocketFactory();
    this.#random = options.random ?? Math.random;
    this.#onTerminal = options.onTerminal;
    this.#gate = new RateLimitGate(options.clock);
    // Captured before any socket exists: an event published while we are still
    // connecting must fall inside the first REQ window, not behind it.
    this.#registry = new SubscriptionRegistry(Math.floor(options.clock.now() / 1000));
    // The startup rejection is delivered to whoever awaited connect(); this
    // keeps it from also surfacing as an unhandled rejection when nobody did.
    this.#ready.promise.catch(() => {});
  }

  get state(): RelayState {
    return this.#state;
  }

  get startupWatermark(): number {
    return this.#registry.startupWatermark;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  async connect(): Promise<void> {
    if (this.#fatal !== null) throw this.#fatal;
    if (!this.#supervising) {
      this.#supervising = true;
      void this.#supervise();
    }
    return this.#ready.promise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    this.#cancelStabilityReset();
    for (const query of [...this.#queries.values()]) query.finish("relay closing");
    this.#teardown(new Error("error: relay closed locally"));
    this.#setState("disconnected");
  }

  async #supervise(): Promise<void> {
    while (!this.#closed) {
      let failure: unknown = null;
      try {
        const session = await this.#connectOnce();
        this.#everConnected = true;
        this.#armStabilityReset();
        this.#ready.resolve();
        const reason = await session.closed;
        this.#logger.warn("relay connection closed", { reason });
        failure = new Error(`connection closed: ${reason}`);
      } catch (error) {
        failure = error;
      }
      this.#cancelStabilityReset();
      this.#teardown(new Error("error: connection lost"));
      if (this.#closed) return;
      this.#setState("disconnected");

      if (failure instanceof TerminalRelayError) {
        this.#fail(failure);
        return;
      }
      this.#attempt += 1;
      if (!this.#everConnected && this.#attempt >= STARTUP_ATTEMPTS) {
        this.#fail(
          new Error(
            `relay unreachable after ${STARTUP_ATTEMPTS} attempts: ${describeError(failure)}`,
          ),
        );
        return;
      }
      this.#logger.warn("relay reconnect scheduled", {
        attempt: this.#attempt,
        cause: describeError(failure),
      });
      this.#setState("backing_off");
      try {
        await this.#clock.sleep(this.#backoffDelayMs(), this.#abort.signal);
      } catch {
        return;
      }
    }
  }

  async #connectOnce(): Promise<{ closed: Promise<string> }> {
    this.#setState("connecting");
    const session = this.#createSocket();
    await session.opened;

    this.#setState("authenticating");
    const deadline = this.#clock.now() + AUTH_TIMEOUT_MS;
    const challenge = await this.#awaitChallenge(deadline - this.#clock.now());
    const authEvent = buildAuthEvent(this.#builder, this.#url, challenge);
    const ok = this.#awaitOk(authEvent.id, deadline - this.#clock.now());
    this.#send(["AUTH", authEvent]);
    const result = await ok;
    if (!result.ok) {
      const message = `NIP-42 authentication rejected: ${result.message}`;
      throw isTerminalRelayMessage(result.message)
        ? new TerminalRelayError(message)
        : new Error(message);
    }

    // Subscriptions are replayed only after the new socket is authenticated;
    // a REQ sent before the handshake is answered with `auth-required:`.
    this.#setState("subscribing");
    for (const record of this.#registry.all()) this.#sendReq(record);
    this.#setState("ready");
    this.#logger.info("relay ready", { subscriptions: this.#registry.size });
    return { closed: session.closed };
  }

  #createSocket(): { opened: Promise<void>; closed: Promise<string> } {
    const opened = deferred<void>();
    const closed = deferred<string>();
    let isOpen = false;
    let httpStatus: number | null = null;
    let socketError: Error | null = null;

    const cancelTimeout = this.#clock.setTimeout(() => {
      if (isOpen) return;
      opened.reject(new Error("connect timeout"));
      this.#destroySocket();
    }, CONNECT_TIMEOUT_MS);

    // A socket abandoned by a timeout can still emit; anything it says must not
    // touch state that by then belongs to its successor. The per-session
    // promises are still settled, since those are nobody else's.
    let self: RelaySocket | null = null;
    const stale = (): boolean => self === null || this.#socket !== self;

    const socket = this.#factory(this.#url, {
      onOpen: () => {
        if (stale()) return;
        isOpen = true;
        cancelTimeout();
        opened.resolve();
      },
      onMessage: (data) => {
        if (stale()) return;
        try {
          this.#handleMessage(data);
        } catch (error) {
          this.#logger.warn("relay frame handling failed", { error: describeError(error) });
        }
      },
      onClose: (code, reason) => {
        cancelTimeout();
        const detail = reason !== "" ? reason : (socketError?.message ?? `code ${code}`);
        if (!stale()) {
          this.#challenge = null;
          this.#rejectWaiters(new Error(`error: connection closed (${detail})`));
        }
        if (!isOpen) {
          opened.reject(
            httpStatus !== null && isTerminalHttpStatus(httpStatus)
              ? new TerminalRelayError(`relay rejected the upgrade with HTTP ${httpStatus}`)
              : new Error(`connect failed: ${detail}`),
          );
        }
        closed.resolve(detail);
      },
      onError: (error) => {
        socketError = error;
      },
      onHttpStatus: (status) => {
        httpStatus = status;
      },
    });
    self = socket;
    this.#socket = socket;
    return { opened: opened.promise, closed: closed.promise };
  }

  #fail(error: Error): void {
    this.#fatal = error;
    this.#closed = true;
    this.#abort.abort();
    this.#teardown(error);
    this.#setState("failed");
    this.#ready.reject(error);
    this.#logger.error("relay supervisor stopped", { error: error.message });
    this.#onTerminal?.(error);
    for (const listener of [...this.#terminalListeners]) {
      listener(error);
    }
  }

  #teardown(reason: Error): void {
    this.#rejectWaiters(reason);
    this.#destroySocket();
  }

  #destroySocket(): void {
    const socket = this.#socket;
    if (socket === null) return;
    this.#socket = null;
    try {
      socket.close();
    } catch (error) {
      this.#logger.debug("socket close threw", { error: describeError(error) });
    }
  }

  #rejectWaiters(reason: Error): void {
    for (const waiter of [...this.#okWaiters.values()]) waiter.reject(reason);
    this.#okWaiters.clear();
    this.#challengeWaiter?.reject(reason);
    this.#challengeWaiter = null;
  }

  #armStabilityReset(): void {
    this.#cancelStabilityReset();
    this.#cancelStability = this.#clock.setTimeout(() => {
      this.#attempt = 0;
      this.#cancelStability = null;
    }, STABILITY_RESET_MS);
  }

  #cancelStabilityReset(): void {
    this.#cancelStability?.();
    this.#cancelStability = null;
  }

  #backoffDelayMs(): number {
    const index = Math.min(Math.max(this.#attempt - 1, 0), BACKOFF_LADDER_MS.length - 1);
    const base = BACKOFF_LADDER_MS[index] ?? 1_000;
    return Math.round(base * (1 - BACKOFF_JITTER + this.#random() * BACKOFF_JITTER * 2));
  }

  /* ---------------------------------------------------------------------- */
  /* Wire handling                                                          */
  /* ---------------------------------------------------------------------- */

  #send(message: ClientMessage): void {
    const socket = this.#socket;
    if (socket === null) throw new Error("error: no relay socket");
    socket.send(JSON.stringify(message));
  }

  #handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#logger.warn("relay sent an unparseable frame");
      return;
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return;
    const message = parsed as RelayMessage;
    switch (message[0]) {
      case "AUTH":
        this.#onChallenge(message[1]);
        return;
      case "OK":
        this.#onOk(message[1], message[2] === true, message[3] ?? "");
        return;
      case "EVENT":
        this.#onEvent(message[1], message[2]);
        return;
      case "EOSE":
        this.#onEose(message[1]);
        return;
      case "CLOSED":
        this.#onSubscriptionClosed(message[1], message[2] ?? "");
        return;
      case "NOTICE":
        this.#onNotice(message[1]);
        return;
      default:
        return;
    }
  }

  #onChallenge(challenge: string): void {
    const waiter = this.#challengeWaiter;
    if (waiter !== null) {
      this.#challengeWaiter = null;
      waiter.resolve(challenge);
      return;
    }
    // Relays send the challenge immediately on connect, often before we have
    // finished awaiting it; buffering avoids a lost-wakeup race.
    this.#challenge = challenge;
  }

  #awaitChallenge(timeoutMs: number): Promise<string> {
    const buffered = this.#challenge;
    if (buffered !== null) {
      this.#challenge = null;
      return Promise.resolve(buffered);
    }
    const waiter = deferred<string>();
    this.#challengeWaiter = waiter;
    const cancel = this.#clock.setTimeout(() => {
      if (this.#challengeWaiter !== waiter) return;
      this.#challengeWaiter = null;
      waiter.reject(new Error("timeout: relay never sent a NIP-42 challenge"));
    }, Math.max(timeoutMs, 0));
    return waiter.promise.finally(cancel);
  }

  #onOk(eventId: string, ok: boolean, message: string): void {
    if (this.#gate.arm(message)) {
      this.#logger.warn("relay rate limited a publish", { until: this.#gate.deadline });
    }
    const waiter = this.#okWaiters.get(eventId);
    if (waiter === undefined) {
      this.#logger.debug("unmatched OK frame", { eventId, ok });
      return;
    }
    this.#okWaiters.delete(eventId);
    waiter.resolve({ ok, message });
  }

  #awaitOk(eventId: string, timeoutMs: number): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve, reject) => {
      const cancel = this.#clock.setTimeout(() => {
        if (this.#okWaiters.delete(eventId)) {
          reject(new Error("timeout: relay never acknowledged the event"));
        }
      }, Math.max(timeoutMs, 0));
      this.#okWaiters.set(eventId, {
        resolve: (result) => {
          cancel();
          resolve(result);
        },
        reject: (error) => {
          cancel();
          reject(error);
        },
      });
    });
  }

  #onEvent(subscriptionId: string, event: NostrEvent): void {
    const query = this.#queries.get(subscriptionId);
    if (query !== undefined) {
      query.events.push(event);
      return;
    }
    try {
      this.#registry.deliver(subscriptionId, event);
    } catch (error) {
      this.#logger.error("subscription handler threw; event marked for replay", {
        subscriptionId,
        eventId: event.id,
        error: describeError(error),
      });
    }
  }

  #onEose(subscriptionId: string): void {
    const query = this.#queries.get(subscriptionId);
    if (query !== undefined) {
      query.finish();
      return;
    }
    const record = this.#registry.get(subscriptionId);
    if (record === undefined) return;
    record.noteReplayComplete();
    record.handlers.onEose?.();
  }

  #onSubscriptionClosed(subscriptionId: string, message: string): void {
    const query = this.#queries.get(subscriptionId);
    if (query !== undefined) {
      query.finish(message);
      return;
    }
    const record = this.#registry.get(subscriptionId);
    if (record === undefined) return;
    record.handlers.onClosed?.(message);

    if (this.#gate.arm(message)) {
      this.#logger.warn("relay rate limited a subscription", { subscriptionId });
      this.#sendReq(record);
      return;
    }
    if (isTerminalRelayMessage(message)) {
      this.#logger.error("relay closed a subscription permanently", { subscriptionId, message });
      return;
    }
    this.#sendReq(record);
  }

  #onNotice(message: string): void {
    if (this.#gate.arm(message)) {
      this.#logger.warn("relay rate limit notice", { message, until: this.#gate.deadline });
      return;
    }
    this.#logger.info("relay notice", { message });
  }

  /* ---------------------------------------------------------------------- */
  /* RelayPort                                                              */
  /* ---------------------------------------------------------------------- */

  subscribe(options: SubscribeOptions): Subscription {
    const record = this.#registry.add(options);
    if (this.#state === "subscribing" || this.#state === "ready") this.#sendReq(record);
    let closed = false;
    return {
      id: options.id,
      close: () => {
        if (closed) return;
        closed = true;
        this.#registry.remove(options.id);
        if (this.#socket !== null) {
          try {
            this.#send(["CLOSE", options.id]);
          } catch (error) {
            this.#logger.debug("CLOSE not delivered", { error: describeError(error) });
          }
        }
      },
    };
  }

  async publish(event: NostrEvent): Promise<PublishResult> {
    try {
      await this.#awaitReady(PUBLISH_TIMEOUT_MS);
      await this.#gate.open();
      // The waiter is registered before the frame goes out so a relay that
      // answers synchronously cannot beat us to it.
      const ok = this.#awaitOk(event.id, PUBLISH_TIMEOUT_MS);
      this.#send(["EVENT", event]);
      const result = await ok;
      return {
        ok: result.ok,
        message: result.message,
        terminal: !result.ok && isTerminalRelayMessage(result.message),
      };
    } catch (error) {
      return { ok: false, message: describeError(error), terminal: false };
    }
  }

  publishEphemeral(event: NostrEvent): void {
    if (this.#state !== "ready" || this.#socket === null) {
      this.#logger.debug("ephemeral event dropped: relay not ready", { kind: event.kind });
      return;
    }
    if (this.#gate.gated) {
      // Queuing ephemerals behind a rate-limit gate would deliver stale
      // presence and telemetry; dropping them is the cheaper failure.
      this.#logger.debug("ephemeral event dropped: rate limited", { kind: event.kind });
      return;
    }
    try {
      this.#send(["EVENT", event]);
    } catch (error) {
      this.#logger.debug("ephemeral event dropped", { error: describeError(error) });
    }
  }

  async query(filters: NostrFilter[], timeoutMs: number = QUERY_TIMEOUT_MS): Promise<NostrEvent[]> {
    await this.#awaitReady(timeoutMs);
    const id = `q${++this.#querySeq}`;
    const events: NostrEvent[] = [];
    return new Promise<NostrEvent[]>((resolve) => {
      let settled = false;
      const finish = (reason?: string): void => {
        if (settled) return;
        settled = true;
        cancel();
        this.#queries.delete(id);
        if (this.#socket !== null) {
          try {
            this.#send(["CLOSE", id]);
          } catch {
            // The socket died; the subscription is gone with it.
          }
        }
        if (reason !== undefined) {
          // A partial answer beats an exception here: callers reconcile against
          // what they got, and an empty result only costs a redundant publish.
          this.#logger.warn("relay query cut short", { id, reason, received: events.length });
        }
        resolve(events);
      };
      const cancel = this.#clock.setTimeout(() => finish("timeout"), timeoutMs);
      this.#queries.set(id, { events, finish });

      const write = (): void => {
        if (settled) return;
        if (this.#socket === null) {
          finish("disconnected");
          return;
        }
        this.#send(["REQ", id, ...filters]);
      };
      if (!this.#gate.defer(write)) write();
    });
  }

  /**
   * Late subscribers are notified immediately: a caller that registers after the
   * connection already died must still learn about it, or the process would sit
   * healthy-looking on a dead socket.
   */
  onTerminal(listener: (error: Error) => void): () => void {
    if (this.#fatal) {
      listener(this.#fatal);
      return () => {};
    }
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  onStateChange(listener: (state: RelayState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  #sendReq(record: SubscriptionRecord): void {
    const write = (): void => {
      if (this.#registry.get(record.id) !== record) return;
      if (this.#socket === null) return;
      this.#send(["REQ", record.id, ...this.#registry.filtersFor(record)]);
    };
    if (!this.#gate.defer(write)) write();
  }

  async #awaitReady(timeoutMs: number): Promise<void> {
    if (this.#fatal !== null) throw this.#fatal;
    if (this.#state === "ready") return;
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        cancel();
        unsubscribe();
      };
      const cancel = this.#clock.setTimeout(() => {
        done();
        reject(new Error("error: relay did not become ready in time"));
      }, timeoutMs);
      const unsubscribe = this.onStateChange((state) => {
        if (this.#fatal !== null) {
          done();
          reject(this.#fatal);
          return;
        }
        if (state === "ready") {
          done();
          resolve();
        }
      });
    });
  }

  #setState(state: RelayState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(state);
      } catch (error) {
        this.#logger.debug("state listener threw", { error: describeError(error) });
      }
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
