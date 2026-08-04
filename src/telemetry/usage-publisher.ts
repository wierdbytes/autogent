/**
 * NIP-AM metric publisher (plan §6.8): kind 44200, NIP-44 agent -> owner.
 *
 * Unlike observer frames this is durable: the signed event goes to the outbox
 * so a relay hiccup cannot lose an owner's billing record. The database lives
 * behind the injected `publish` callback, which is the outbox's enqueue path.
 */

import { KIND, type NostrEvent, type NostrTag } from "../nostr/types.js";
import type { Signer } from "../nostr/signer.js";
import { nullLogger } from "../runtime/logger.js";
import type { EventBuilderPort, Logger } from "../runtime/ports.js";
import { countersAreEmpty, type UsageMetricPayload } from "./usage-types.js";
import { utf8ByteLength } from "./buzz-desktop-compat.js";
import { OBSERVER_MAX_PLAINTEXT_BYTES } from "./observer-envelope.js";

export interface UsagePublisherOptions {
  signer: Signer;
  ownerPubkey: string;
  builder: EventBuilderPort;
  /** Durable enqueue. Owned by the outbox, which handles retry and dead-lettering. */
  publish(event: NostrEvent): Promise<void> | void;
  logger?: Logger;
}

export class UsagePublisher {
  readonly #signer: Signer;
  readonly #ownerPubkey: string;
  readonly #builder: EventBuilderPort;
  readonly #publish: (event: NostrEvent) => Promise<void> | void;
  readonly #logger: Logger;

  constructor(options: UsagePublisherOptions) {
    this.#signer = options.signer;
    this.#ownerPubkey = options.ownerPubkey;
    this.#builder = options.builder;
    this.#publish = options.publish;
    this.#logger = options.logger ?? nullLogger;
  }

  /**
   * Builds and hands off the metric. Returns false when the payload carries no
   * usage, which NIP-AM says must not be published at all.
   */
  async publish(payload: UsageMetricPayload): Promise<boolean> {
    if (countersAreEmpty(payload.turn) && countersAreEmpty(payload.cumulative)) {
      this.#logger.debug("usage metric skipped: no observed counters", {
        turnId: payload.turnId,
      });
      return false;
    }
    // A cumulative series without its key is unorderable, so consumers would
    // have to discard it. Fail loudly instead of shipping a useless record.
    if (payload.cumulative !== null && (payload.sessionId === null || payload.turnSeq === null)) {
      throw new Error("NIP-AM requires sessionId and turnSeq whenever cumulative is present");
    }

    const plaintext = JSON.stringify(payload);
    const size = utf8ByteLength(plaintext);
    if (size > OBSERVER_MAX_PLAINTEXT_BYTES) {
      throw new Error(`usage metric plaintext of ${size} bytes exceeds the NIP-44 limit`);
    }

    const tags: NostrTag[] = [
      ["p", this.#ownerPubkey],
      ["agent", this.#signer.publicKey],
    ];
    const event = this.#builder.build({
      kind: KIND.USAGE_METRIC,
      tags,
      content: this.#signer.encrypt(this.#ownerPubkey, plaintext),
      created_at: Math.floor(Date.parse(payload.timestamp) / 1000),
    });
    await this.#publish(event);
    return true;
  }
}
