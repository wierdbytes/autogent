/**
 * Relay-facing NIP-AE engram client (remote plan §6.2.2).
 *
 * Wraps head fetch, monotonic write and live subscription for the two engrams
 * the remote agent depends on. Publication goes through the NIP-OA event
 * builder, so every engram carries the owner attestation like everything else
 * the agent signs.
 */

import type { Clock, Logger, RelayPort, Subscription } from "../runtime/ports.js";
import { nullLogger } from "../runtime/logger.js";
import type { AgentEventBuilder } from "./event-builder.js";
import {
  deriveEngramDTag,
  selectEngramHead,
  serializeEngramBody,
  type EngramBody,
  type EngramHead,
} from "./nip-ae.js";
import type { Signer } from "./signer.js";
import { KIND } from "./types.js";

export interface EngramClientOptions {
  relay: RelayPort;
  signer: Signer;
  builder: AgentEventBuilder;
  clock: Clock;
  logger?: Logger;
  /** One-shot query budget. Engram heads are small; 10s is generous. */
  queryTimeoutMs?: number;
}

export class EngramClient {
  readonly #relay: RelayPort;
  readonly #signer: Signer;
  readonly #builder: AgentEventBuilder;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #queryTimeoutMs: number;
  /** slug -> derived d-tag; derivation is an HMAC, cheap but not free. */
  readonly #dTags = new Map<string, string>();

  constructor(options: EngramClientOptions) {
    this.#relay = options.relay;
    this.#signer = options.signer;
    this.#builder = options.builder;
    this.#clock = options.clock;
    this.#logger = options.logger ?? nullLogger;
    this.#queryTimeoutMs = options.queryTimeoutMs ?? 10_000;
  }

  get agentPubkey(): string {
    return this.#builder.agentPubkey;
  }

  get ownerPubkey(): string {
    return this.#builder.ownerPubkey;
  }

  dTag(slug: string): string {
    let d = this.#dTags.get(slug);
    if (!d) {
      d = deriveEngramDTag(this.#signer, this.ownerPubkey, slug);
      this.#dTags.set(slug, d);
    }
    return d;
  }

  /** Fetches and validates the current head for `slug`, or null. */
  async fetchHead(slug: string): Promise<EngramHead | null> {
    const dTag = this.dTag(slug);
    const events = await this.#relay.query(
      [{ kinds: [KIND.ENGRAM], authors: [this.agentPubkey], "#d": [dTag], "#p": [this.ownerPubkey] }],
      this.#queryTimeoutMs,
    );
    return selectEngramHead(events, {
      signer: this.#signer,
      agentPubkey: this.agentPubkey,
      ownerPubkey: this.ownerPubkey,
      slug,
      dTag,
    });
  }

  /**
   * Publishes a new head for `slug`.
   *
   * `created_at` is forced monotonic over the supplied prior head
   * (`max(now, head+1)`, NIP-AE §Writing) so replaceable selection can never
   * tie-break away from the write. Callers pass the head they read; when they
   * have none the relay is queried first.
   */
  async publish(
    slug: string,
    body: EngramBody,
    prior?: { createdAt: number } | null,
  ): Promise<EngramHead> {
    const head = prior === undefined ? await this.fetchHead(slug) : prior;
    const now = Math.floor(this.#clock.now() / 1000);
    const createdAt = Math.max(now, (head?.createdAt ?? 0) + 1);

    const event = this.#builder.build({
      kind: KIND.ENGRAM,
      created_at: createdAt,
      tags: [
        ["d", this.dTag(slug)],
        ["p", this.ownerPubkey],
        ["alt", "encrypted agent memory record"],
      ],
      content: this.#signer.encrypt(this.ownerPubkey, serializeEngramBody(body)),
    });

    const result = await this.#relay.publish(event);
    if (!result.ok) {
      throw new Error(`relay rejected engram ${slug}: ${result.message}`);
    }
    this.#logger.info("engram published", { slug, createdAt });
    return { event, body, createdAt };
  }

  /**
   * Live subscription to this agent's own kind 30174 heads.
   *
   * One subscription covers every slug in `slugs`; the handler receives the
   * validated head (events that fail NIP-AE validation are dropped silently —
   * they are noise or hostile, and either way not config).
   */
  subscribe(slugs: readonly string[], onHead: (slug: string, head: EngramHead) => void): Subscription {
    const bySlug = new Map(slugs.map((slug) => [this.dTag(slug), slug]));
    return this.#relay.subscribe({
      id: "engram-heads",
      filters: [
        {
          kinds: [KIND.ENGRAM],
          authors: [this.agentPubkey],
          "#d": [...bySlug.keys()],
        },
      ],
      onEvent: (event) => {
        const dTag = event.tags.find((tag) => tag[0] === "d")?.[1];
        const slug = dTag ? bySlug.get(dTag) : undefined;
        if (!slug) return;
        const head = selectEngramHead([event], {
          signer: this.#signer,
          agentPubkey: this.agentPubkey,
          ownerPubkey: this.ownerPubkey,
          slug,
          dTag,
        });
        if (!head) {
          this.#logger.warn("dropped invalid engram update", { slug, eventId: event.id });
          return;
        }
        onHead(slug, head);
      },
    });
  }
}
