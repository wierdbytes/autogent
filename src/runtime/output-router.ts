/**
 * Turns completed assistant messages into durable, correctly-addressed chat
 * events (plan §1.2, §6.5, §9.3).
 *
 * Two invariants drive the whole design:
 *
 *  1. **Every reply targets the primary user event.** Routing tags come only
 *     from the immutable {@link TurnContext}, never from the model's output and
 *     never from a previously published agent event. The agent therefore cannot
 *     be talked into replying somewhere else, and never builds a reply chain
 *     through its own messages.
 *  2. **Intent is durable before the network is touched.** A message is recorded,
 *     then signed, then stored signed, and only then sent. A retry re-sends the
 *     same bytes, so relay-side id dedup gives us effectively-once publishing.
 */

import type { NostrEvent, NostrTag } from "../nostr/types.js";
import { KIND } from "../nostr/types.js";
import type { OutputConfig } from "../config.js";
import type { EventBuilderPort, OutboxRepository, OutputIntent } from "./ports.js";
import type { TurnContext } from "./turn-context.js";

export interface OutputRouterDeps {
  outbox: OutboxRepository;
  builder: EventBuilderPort;
  config: OutputConfig;
  now(): number;
  /** Signals the publisher that new work is available. */
  notify(): void;
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Splits text into chunks no larger than `maxBytes`.
 *
 * Breaks at paragraph, then line, then word boundaries before resorting to a
 * hard cut, so a split message stays readable in a chat client. Code point
 * integrity is preserved because slicing happens on string indices that were
 * measured in UTF-8 bytes only as a size check.
 */
export function splitMessage(text: string, maxBytes: number): string[] {
  if (byteLength(text) <= maxBytes) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (byteLength(rest) > maxBytes) {
    // Find the largest prefix that fits, by character count, then walk back to a
    // natural boundary.
    let cut = rest.length;
    while (cut > 0 && byteLength(rest.slice(0, cut)) > maxBytes) {
      cut = Math.floor(cut * 0.9);
    }
    while (cut < rest.length && byteLength(rest.slice(0, cut + 1)) <= maxBytes) {
      cut += 1;
    }

    const window = rest.slice(0, cut);
    const boundary =
      lastIndexBefore(window, "\n\n") ?? lastIndexBefore(window, "\n") ?? lastIndexBefore(window, " ");
    const end = boundary !== null && boundary > cut * 0.5 ? boundary : cut;

    chunks.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
    if (rest.length === 0) break;
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((chunk) => chunk.length > 0);
}

function lastIndexBefore(text: string, needle: string): number | null {
  const index = text.lastIndexOf(needle);
  return index <= 0 ? null : index + needle.length;
}

/**
 * Builds the NIP-10 tags for a reply.
 *
 * `root` stays the thread root and `reply` stays the *primary trigger* even for
 * outputs produced after a steering message — the participants grow, the anchor
 * does not (plan §1.3).
 */
export function buildReplyTags(context: TurnContext): NostrTag[] {
  const tags: NostrTag[] = [["h", context.channelId]];

  if (context.threadRootEventId !== context.primaryTriggerEventId) {
    tags.push(["e", context.threadRootEventId, "", "root"]);
    tags.push(["e", context.primaryTriggerEventId, "", "reply"]);
  } else {
    // Replying to a top-level message: it is both the root and the parent, and
    // NIP-10 wants a single `root` marker in that case.
    tags.push(["e", context.primaryTriggerEventId, "", "root"]);
  }

  for (const pubkey of dedupe(context.participantPubkeys)) {
    tags.push(["p", pubkey]);
  }
  return tags;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export interface RecordedOutput {
  intent: OutputIntent;
  event: NostrEvent;
}

export class OutputRouter {
  /** Publish order within a turn. Identity lives in the logical id, not here. */
  readonly #ordinals = new Map<string, number>();

  constructor(private readonly deps: OutputRouterDeps) {}

  /**
   * Records a completed assistant message.
   *
   * Returns the events that will be published. An empty result means the message
   * carried nothing publishable — a tool-only turn, or whitespace.
   */
  record(context: TurnContext, piMessageId: string, text: string): RecordedOutput[] {
    if (text.trim().length === 0) return [];

    const bodies = this.#applyOversizePolicy(text);
    const recorded: RecordedOutput[] = [];

    for (const [chunkIndex, body] of bodies.entries()) {
      // Identity is derived from the message and its chunk, not from the
      // per-turn counter: after a crash the counter restarts, and a logical id
      // that moved would defeat the duplicate check and publish twice.
      const logicalId = `${context.turnId}:${piMessageId}:${chunkIndex}`;
      const ordinal = this.#nextOrdinal(context.turnId);

      const intent: OutputIntent = {
        logicalId,
        turnId: context.turnId,
        piMessageId,
        ordinal,
        content: body,
        channelId: context.channelId,
        replyEventId: context.primaryTriggerEventId,
        rootEventId: context.threadRootEventId,
        participantPubkeys: dedupe(context.participantPubkeys),
        state: "pending",
      };

      // A duplicate logical id means this message was already recorded before a
      // crash; the stored signed event is authoritative and must not be re-signed.
      if (!this.deps.outbox.putIntent(intent)) continue;

      const event = this.deps.builder.build({
        kind: KIND.CHAT,
        content: body,
        tags: buildReplyTags(context),
      });

      this.deps.outbox.putSigned({
        logicalId,
        eventId: event.id,
        kind: KIND.CHAT,
        signedEvent: event,
        state: "pending",
        attempts: 0,
        nextRetryAt: this.deps.now(),
        lastError: null,
      });
      this.deps.outbox.setIntentState(logicalId, "signed");

      recorded.push({ intent, event });
    }

    if (recorded.length > 0) this.deps.notify();
    return recorded;
  }

  /** Frees per-turn ordinal bookkeeping once a turn can produce no more output. */
  finishTurn(turnId: string): void {
    this.#ordinals.delete(turnId);
  }

  #applyOversizePolicy(text: string): string[] {
    const max = this.deps.config.maxMessageBytes;
    if (byteLength(text) <= max) return [text];

    switch (this.deps.config.oversizePolicy) {
      case "split":
        return splitMessage(text, max);
      case "truncate": {
        const [head] = splitMessage(text, max);
        return head ? [`${head}\n\n[truncated]`] : [];
      }
      case "reject":
        return [];
    }
  }

  #nextOrdinal(turnId: string): number {
    const next = this.#ordinals.get(turnId) ?? 0;
    this.#ordinals.set(turnId, next + 1);
    return next;
  }
}
