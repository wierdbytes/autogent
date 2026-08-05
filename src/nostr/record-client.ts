/**
 * Relay-facing config-record client (kind 30078, see nostr/config-records.ts).
 *
 * Wraps head fetch, monotonic write and live subscription for the two records
 * the remote agent depends on. Events are signed directly by the agent key —
 * deliberately *not* through the NIP-OA event builder — so a record carries
 * no `auth` tag and no owner linkage. The relay accepts them on the strength
 * of the authenticated NIP-42 connection alone (scope `UsersWrite`), which is
 * how every other kind-30078 write is admitted too.
 */

import type { Clock, Logger, RelayPort, Subscription } from "../runtime/ports.js";
import { nullLogger } from "../runtime/logger.js";
import {
  deriveRecordDTag,
  RECORD_ALT,
  selectRecordHead,
  serializeRecordBody,
  type RecordBody,
  type RecordHead,
} from "./config-records.js";
import type { Signer } from "./signer.js";
import { KIND } from "./types.js";

export interface RecordClientOptions {
  relay: RelayPort;
  signer: Signer;
  clock: Clock;
  logger?: Logger;
  /** One-shot query budget. Record heads are small; 10s is generous. */
  queryTimeoutMs?: number;
}

export class RecordClient {
  readonly #relay: RelayPort;
  readonly #signer: Signer;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #queryTimeoutMs: number;
  /** slug -> derived d-tag; derivation is an HMAC, cheap but not free. */
  readonly #dTags = new Map<string, string>();

  constructor(options: RecordClientOptions) {
    this.#relay = options.relay;
    this.#signer = options.signer;
    this.#clock = options.clock;
    this.#logger = options.logger ?? nullLogger;
    this.#queryTimeoutMs = options.queryTimeoutMs ?? 10_000;
  }

  get agentPubkey(): string {
    return this.#signer.publicKey;
  }

  dTag(slug: string): string {
    let d = this.#dTags.get(slug);
    if (!d) {
      d = deriveRecordDTag(this.#signer, slug);
      this.#dTags.set(slug, d);
    }
    return d;
  }

  /** Fetches and validates the current head for `slug`, or null. */
  async fetchHead(slug: string): Promise<RecordHead | null> {
    const dTag = this.dTag(slug);
    const events = await this.#relay.query(
      [{ kinds: [KIND.APP_DATA], authors: [this.agentPubkey], "#d": [dTag] }],
      this.#queryTimeoutMs,
    );
    return selectRecordHead(events, {
      signer: this.#signer,
      agentPubkey: this.agentPubkey,
      slug,
      dTag,
    });
  }

  /**
   * Publishes a new head for `slug`.
   *
   * `created_at` is forced monotonic over the supplied prior head
   * (`max(now, head+1)`) so replaceable selection can never tie-break away
   * from the write. Callers pass the head they read; when they have none the
   * relay is queried first.
   */
  async publish(
    slug: string,
    body: RecordBody,
    prior?: { createdAt: number } | null,
  ): Promise<RecordHead> {
    const head = prior === undefined ? await this.fetchHead(slug) : prior;
    const now = Math.floor(this.#clock.now() / 1000);
    const createdAt = Math.max(now, (head?.createdAt ?? 0) + 1);

    const event = this.#signer.sign({
      pubkey: this.agentPubkey,
      kind: KIND.APP_DATA,
      created_at: createdAt,
      tags: [
        ["d", this.dTag(slug)],
        ["alt", RECORD_ALT],
      ],
      content: this.#signer.encrypt(this.agentPubkey, serializeRecordBody(body)),
    });

    const result = await this.#relay.publish(event);
    if (!result.ok) {
      throw new Error(`relay rejected config record ${slug}: ${result.message}`);
    }
    this.#logger.info("config record published", { slug, createdAt });
    return { event, body, createdAt };
  }

  /**
   * Live subscription to this agent's own kind 30078 heads.
   *
   * One subscription covers every slug in `slugs`; the handler receives the
   * validated head (events that fail validation are dropped silently — they
   * are noise or hostile, and either way not config). Filtering by the
   * derived d-tags also keeps unrelated kind-30078 writers under this key
   * (e.g. NIP-RS read state) out of the stream entirely.
   */
  subscribe(slugs: readonly string[], onHead: (slug: string, head: RecordHead) => void): Subscription {
    const bySlug = new Map(slugs.map((slug) => [this.dTag(slug), slug]));
    return this.#relay.subscribe({
      id: "config-records",
      filters: [
        {
          kinds: [KIND.APP_DATA],
          authors: [this.agentPubkey],
          "#d": [...bySlug.keys()],
        },
      ],
      onEvent: (event) => {
        const dTag = event.tags.find((tag) => tag[0] === "d")?.[1];
        const slug = dTag ? bySlug.get(dTag) : undefined;
        if (!slug) return;
        const head = selectRecordHead([event], {
          signer: this.#signer,
          agentPubkey: this.agentPubkey,
          slug,
          dTag,
        });
        if (!head) {
          this.#logger.warn("dropped invalid config record update", { slug, eventId: event.id });
          return;
        }
        onHead(slug, head);
      },
    });
  }
}
