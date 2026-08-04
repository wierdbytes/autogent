/**
 * Signs agent events with exactly one NIP-OA `auth` tag (plan §6.2).
 *
 * Every outbound event funnels through here so the attestation can never be
 * forgotten, duplicated, or supplied by a caller: a second `auth` tag makes the
 * event ambiguous about who authorised it, and relays that see one reject the
 * whole event rather than pick a winner.
 */

import type { Clock, EventBuilderPort } from "../runtime/ports.js";
import {
  AUTH_TAG_NAME,
  type AuthTag,
  conditionsAllow,
  kindsNotCovered,
  toNostrTag,
  verifyAttestation,
} from "./nip-oa.js";
import type { Signer } from "./signer.js";
import { AGENT_PUBLISHED_KINDS, type NostrEvent, type NostrTag } from "./types.js";

export interface AgentEventBuilder extends EventBuilderPort {
  readonly agentPubkey: string;
  readonly ownerPubkey: string;
  /** The canonical attestation, for callers that must compare provenance. */
  readonly authTag: AuthTag;
}

export interface EventBuilderOptions {
  signer: Signer;
  authTag: AuthTag;
  clock: Clock;
  /** Kinds the attestation must cover. Defaults to the whole publish surface. */
  requiredKinds?: readonly number[];
}

class Nip0aEventBuilder implements AgentEventBuilder {
  readonly agentPubkey: string;
  readonly ownerPubkey: string;
  readonly authTag: AuthTag;
  readonly #signer: Signer;
  readonly #clock: Clock;
  readonly #tag: NostrTag;

  constructor(options: EventBuilderOptions) {
    const { signer, authTag, clock } = options;
    if (!verifyAttestation(authTag, signer.publicKey)) {
      throw new Error("owner attestation does not verify against the agent pubkey");
    }
    const required = options.requiredKinds ?? AGENT_PUBLISHED_KINDS;
    const uncovered = kindsNotCovered(authTag.conditions, required, Math.floor(clock.now() / 1000));
    if (uncovered.length > 0) {
      throw new Error(
        `owner attestation conditions '${authTag.conditions}' do not cover kinds ${uncovered.join(", ")}`,
      );
    }

    this.#signer = signer;
    this.#clock = clock;
    this.authTag = authTag;
    this.#tag = toNostrTag(authTag);
    this.agentPubkey = signer.publicKey;
    this.ownerPubkey = authTag.ownerPubkey;
  }

  build(draft: { kind: number; tags: NostrTag[]; content: string; created_at?: number }): NostrEvent {
    if (draft.tags.some((tag) => tag[0] === AUTH_TAG_NAME)) {
      throw new Error("callers must not supply an auth tag; the builder owns attestation");
    }
    const createdAt = draft.created_at ?? Math.floor(this.#clock.now() / 1000);
    // `created_at<` conditions expire, so coverage is re-checked per event and
    // not just at construction: a stale attestation must fail fast at the point
    // of signing rather than be rejected by the relay later.
    if (!conditionsAllow(this.authTag.conditions, draft.kind, createdAt)) {
      throw new Error(
        `owner attestation does not authorise kind ${draft.kind} at ${createdAt}`,
      );
    }
    return this.#signer.sign({
      pubkey: this.agentPubkey,
      created_at: createdAt,
      kind: draft.kind,
      tags: [...draft.tags, this.#tag],
      content: draft.content,
    });
  }
}

export function createEventBuilder(options: EventBuilderOptions): AgentEventBuilder {
  return new Nip0aEventBuilder(options);
}

/**
 * Signs events with no NIP-OA tag.
 *
 * For owner-side commands: the owner is a real community member acting under
 * their own key, so there is no attestation to attach — and attaching one would
 * be a lie about who authorised the event. The agent runtime must never use
 * this; it is reachable only from `autogent-nostr attest` and `channel`.
 */
export function createPlainEventBuilder(options: {
  signer: Signer;
  clock: Clock;
}): EventBuilderPort {
  return {
    build(draft) {
      return options.signer.sign({
        pubkey: options.signer.publicKey,
        created_at: draft.created_at ?? Math.floor(options.clock.now() / 1000),
        kind: draft.kind,
        tags: draft.tags,
        content: draft.content,
      });
    },
  };
}
