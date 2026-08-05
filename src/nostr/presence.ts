/**
 * Agent presence, kind 20001 (plan §6.6).
 *
 * Ephemeral by design: the relay does not store it, so it goes out on the
 * socket without waiting for an `OK`. A dropped heartbeat is corrected by the
 * next one 60s later, which is cheaper than blocking the outbox behind it.
 */

import { nullLogger } from "../runtime/logger.js";
import type { Clock, Logger, RelayPort } from "../runtime/ports.js";
import type { AgentEventBuilder } from "./event-builder.js";
import { KIND } from "./types.js";

export type PresenceStatus = "online" | "offline" | "degraded";

export const DEFAULT_HEARTBEAT_SEC = 60;

export interface PresencePublisherOptions {
  relay: RelayPort;
  builder: AgentEventBuilder;
  clock: Clock;
  heartbeatSec?: number;
  logger?: Logger;
}

export class PresencePublisher {
  readonly #relay: RelayPort;
  readonly #builder: AgentEventBuilder;
  readonly #clock: Clock;
  readonly #heartbeatMs: number;
  readonly #logger: Logger;
  #cancelHeartbeat: (() => void) | null = null;
  #status: PresenceStatus | null = null;
  /** What the heartbeat repeats: "online", or "degraded" while fail-closed. */
  #liveStatus: "online" | "degraded" = "online";

  constructor(options: PresencePublisherOptions) {
    this.#relay = options.relay;
    this.#builder = options.builder;
    this.#clock = options.clock;
    this.#heartbeatMs = (options.heartbeatSec ?? DEFAULT_HEARTBEAT_SEC) * 1000;
    this.#logger = options.logger ?? nullLogger;
  }

  get status(): PresenceStatus | null {
    return this.#status;
  }

  /** Announces readiness and starts the heartbeat. Idempotent. */
  online(): void {
    this.#liveStatus = "online";
    this.#beat();
  }

  /**
   * Degraded: the agent is reachable for owner diagnostics but refuses
   * prompts (missing record heads / invalid credentials, remote plan §6.2.8).
   * Presence-is-status is the only management channel, so the state must be
   * visible on the relay rather than only in Pod logs.
   */
  degraded(): void {
    this.#liveStatus = "degraded";
    this.#beat();
  }

  #beat(): void {
    this.#publish(this.#liveStatus);
    if (this.#cancelHeartbeat !== null) return;
    this.#cancelHeartbeat = this.#clock.setInterval(
      () => this.#publish(this.#liveStatus),
      this.#heartbeatMs,
    );
  }

  /** Best-effort farewell on graceful shutdown. */
  offline(): void {
    this.stop();
    this.#publish("offline");
  }

  stop(): void {
    this.#cancelHeartbeat?.();
    this.#cancelHeartbeat = null;
  }

  #publish(status: PresenceStatus): void {
    // Buzz reads the bare status string, not a JSON envelope, and the `h` tag
    // is omitted because presence is agent-wide rather than per channel.
    try {
      this.#relay.publishEphemeral(
        this.#builder.build({ kind: KIND.PRESENCE, tags: [], content: status }),
      );
      this.#status = status;
    } catch (error) {
      this.#logger.warn("presence publish failed", {
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
