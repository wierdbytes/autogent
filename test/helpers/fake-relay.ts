/**
 * Scripted in-process relay.
 *
 * Speaks the NIP-01/NIP-42 frame protocol over an injected socket instead of a
 * real WebSocket, so the supervisor's whole state machine runs under `FakeClock`
 * with no sockets, ports or wall-clock waiting.
 */

import type {
  RelaySocket,
  RelaySocketFactory,
  RelaySocketHandlers,
} from "../../src/nostr/relay-supervisor.js";
import type {
  ClientMessage,
  NostrEvent,
  NostrFilter,
  RelayMessage,
} from "../../src/nostr/types.js";

/** `null` means "stay silent", which is how a lost `OK` is simulated. */
export type Verdict = { ok: boolean; message: string } | null;

export function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false;
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(value)) continue;
    const name = key.slice(1);
    const wanted = value as string[];
    const present = event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]);
    if (!present.some((item) => item !== undefined && wanted.includes(item))) return false;
  }
  return true;
}

export class FakeConnection {
  readonly sent: ClientMessage[] = [];
  readonly reqs: Array<{ id: string; filters: NostrFilter[] }> = [];
  readonly subscriptions = new Map<string, NostrFilter[]>();
  readonly socket: RelaySocket;
  authEvents: NostrEvent[] = [];
  authenticated = false;
  closed = false;

  constructor(
    private readonly relay: FakeRelay,
    private readonly handlers: RelaySocketHandlers,
  ) {
    this.socket = {
      send: (data) => this.#onClientFrame(JSON.parse(data) as ClientMessage),
      close: () => this.close("closed by client", 1000),
    };
  }

  begin(): void {
    if (this.relay.stall) return;
    queueMicrotask(() => {
      if (this.closed) return;
      const status = this.relay.handshakeStatus;
      if (status !== null) {
        this.handlers.onHttpStatus(status);
        this.closed = true;
        this.handlers.onClose(1006, `unexpected server response: ${status}`);
        return;
      }
      this.handlers.onOpen();
      if (this.relay.sendChallenge) this.send(["AUTH", this.relay.challenge]);
    });
  }

  send(message: RelayMessage): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed) return;
      this.handlers.onMessage(JSON.stringify(message));
    });
  }

  /**
   * Emits a frame even though the socket is closing.
   *
   * A real WebSocket keeps delivering until the closing handshake finishes, so
   * a socket the client has already abandoned can still speak.
   */
  sendWhileClosing(message: RelayMessage): void {
    queueMicrotask(() => this.handlers.onMessage(JSON.stringify(message)));
  }

  close(reason = "connection reset", code = 1006): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.handlers.onClose(code, reason));
  }

  /** Pushes an event to every live subscription whose filters match. */
  deliver(event: NostrEvent): string[] {
    const delivered: string[] = [];
    for (const [id, filters] of this.subscriptions) {
      if (!filters.some((filter) => matchesFilter(event, filter))) continue;
      this.send(["EVENT", id, event]);
      delivered.push(id);
    }
    return delivered;
  }

  #onClientFrame(frame: ClientMessage): void {
    this.sent.push(frame);
    // NIP-42: anything but AUTH is refused until the handshake completes, so a
    // supervisor that resubscribes before re-authenticating fails loudly.
    if (this.relay.requireAuth && !this.authenticated) {
      if (frame[0] === "EVENT") {
        this.send(["OK", frame[1].id, false, "auth-required: authenticate first"]);
        return;
      }
      if (frame[0] === "REQ") {
        this.send(["CLOSED", frame[1], "auth-required: authenticate first"]);
        return;
      }
    }
    switch (frame[0]) {
      case "AUTH": {
        const event = frame[1];
        this.authEvents.push(event);
        const verdict = this.relay.authVerdict(event, this);
        if (verdict === null) return;
        this.authenticated = verdict.ok;
        this.send(["OK", event.id, verdict.ok, verdict.message]);
        return;
      }
      case "EVENT": {
        const event = frame[1];
        this.relay.received.push(event);
        if (this.relay.fanOutPublished) this.relay.store(event);
        const verdict = this.relay.eventVerdict(event);
        if (verdict === null) return;
        this.send(["OK", event.id, verdict.ok, verdict.message]);
        return;
      }
      case "REQ": {
        const [, id, ...filters] = frame;
        this.reqs.push({ id, filters });
        this.subscriptions.set(id, filters);
        if (this.relay.autoReplay) {
          for (const event of this.relay.matching(filters)) this.send(["EVENT", id, event]);
        }
        if (this.relay.autoEose) this.send(["EOSE", id]);
        return;
      }
      case "CLOSE": {
        this.subscriptions.delete(frame[1]);
        return;
      }
      default:
        return;
    }
  }
}

export class FakeRelay {
  readonly connections: FakeConnection[] = [];
  readonly stored: NostrEvent[] = [];
  /** Every event the client published, in wire order. */
  readonly received: NostrEvent[] = [];

  challenge = "challenge-0";
  /** Disable to leave the client waiting for a NIP-42 challenge forever. */
  sendChallenge = true;
  authVerdict: (event: NostrEvent, connection: FakeConnection) => Verdict = () => ({
    ok: true,
    message: "",
  });
  eventVerdict: (event: NostrEvent) => Verdict = () => ({ ok: true, message: "" });
  /** Non-null makes the upgrade fail with that HTTP status. */
  handshakeStatus: number | null = null;
  /** Never opens and never closes; drives the connect timeout. */
  stall = false;
  /** Replay stored events matching a REQ before EOSE. */
  autoReplay = true;
  /** Answer a REQ with EOSE. Disable to leave a query hanging. */
  autoEose = true;
  /** Refuse REQ/EVENT frames sent before the NIP-42 handshake succeeds. */
  requireAuth = true;
  /** Keep published events so they can be replayed to subscribers. */
  fanOutPublished = false;

  readonly factory: RelaySocketFactory = (_url, handlers) => {
    const connection = new FakeConnection(this, handlers);
    this.connections.push(connection);
    connection.begin();
    return connection.socket;
  };

  get current(): FakeConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) throw new Error("no connection has been opened");
    return connection;
  }

  get connectionCount(): number {
    return this.connections.length;
  }

  store(...events: NostrEvent[]): void {
    this.stored.push(...events);
  }

  matching(filters: readonly NostrFilter[]): NostrEvent[] {
    return this.stored
      .filter((event) => filters.some((filter) => matchesFilter(event, filter)))
      .sort((a, b) => a.created_at - b.created_at);
  }

  /** Stores an event and pushes it to matching live subscriptions. */
  emit(event: NostrEvent): string[] {
    this.store(event);
    return this.current.deliver(event);
  }

  notice(message: string): void {
    this.current.send(["NOTICE", message]);
  }

  closeSubscription(subscriptionId: string, message: string): void {
    this.current.subscriptions.delete(subscriptionId);
    this.current.send(["CLOSED", subscriptionId, message]);
  }

  drop(reason = "connection reset"): void {
    this.current.close(reason);
  }

  reqFor(subscriptionId: string, connectionIndex = this.connections.length - 1) {
    const connection = this.connections[connectionIndex];
    if (connection === undefined) throw new Error(`no connection ${connectionIndex}`);
    return connection.reqs.filter((req) => req.id === subscriptionId);
  }
}
