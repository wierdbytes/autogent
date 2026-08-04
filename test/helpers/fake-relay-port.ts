import type { NostrEvent, NostrFilter } from "../../src/nostr/types.js";
import type {
  PublishResult,
  RelayPort,
  RelayState,
  SubscribeOptions,
  Subscription,
} from "../../src/runtime/ports.js";

interface Registered {
  options: SubscribeOptions;
  closed: boolean;
}

/**
 * A `RelayPort` fake that speaks in whole events rather than sockets.
 *
 * The socket-level `FakeRelay` exercises the supervisor; this one sits a layer
 * above so runtime wiring can be tested without a transport at all.
 */
export class FakeRelayPort implements RelayPort {
  state: RelayState = "disconnected";
  readonly published: NostrEvent[] = [];
  readonly ephemeral: NostrEvent[] = [];
  readonly subscriptions = new Map<string, Registered>();
  /** Canned responses for `query`, matched in registration order. */
  readonly queryResponders: Array<(filters: NostrFilter[]) => NostrEvent[] | null> = [];
  /** Set to make every `publish` fail, to exercise outbox retry. */
  publishVerdict: (event: NostrEvent) => PublishResult = () => ({
    ok: true,
    message: "",
    terminal: false,
  });

  #stateListeners = new Set<(state: RelayState) => void>();
  #terminalListeners = new Set<(error: Error) => void>();

  async connect(): Promise<void> {
    this.#setState("ready");
  }

  async publish(event: NostrEvent): Promise<PublishResult> {
    const verdict = this.publishVerdict(event);
    if (verdict.ok) this.published.push(event);
    return verdict;
  }

  publishEphemeral(event: NostrEvent): void {
    this.ephemeral.push(event);
  }

  subscribe(options: SubscribeOptions): Subscription {
    const registered: Registered = { options, closed: false };
    this.subscriptions.set(options.id, registered);
    // Relays answer an empty backlog with EOSE; without it, callers that wait
    // for the initial replay to finish would hang.
    queueMicrotask(() => options.onEose?.());
    return {
      id: options.id,
      close: () => {
        registered.closed = true;
        this.subscriptions.delete(options.id);
      },
    };
  }

  async query(filters: NostrFilter[]): Promise<NostrEvent[]> {
    for (const responder of this.queryResponders) {
      const result = responder(filters);
      if (result !== null) return result;
    }
    return [];
  }

  onStateChange(listener: (state: RelayState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  onTerminal(listener: (error: Error) => void): () => void {
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#setState("disconnected");
    this.subscriptions.clear();
  }

  /** Delivers an event to every subscription whose filters match it. */
  deliver(event: NostrEvent): void {
    for (const { options } of this.subscriptions.values()) {
      if (options.filters.some((filter) => matches(filter, event))) options.onEvent(event);
    }
  }

  failTerminally(error: Error): void {
    this.#setState("failed");
    for (const listener of [...this.#terminalListeners]) listener(error);
  }

  #setState(state: RelayState): void {
    this.state = state;
    for (const listener of [...this.#stateListeners]) listener(state);
  }
}

function matches(filter: NostrFilter, event: NostrEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;

  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(value)) continue;
    const name = key.slice(1);
    const present = event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]);
    if (!value.some((wanted) => present.includes(wanted as string))) return false;
  }
  return true;
}
