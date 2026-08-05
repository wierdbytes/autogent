/**
 * HTTP auth events for the relay's non-WebSocket doors (remote plan §5).
 *
 * **NIP-98** (kind 27235) for git Smart HTTP, as `Authorization: Nostr
 * <base64(event JSON)>`: `u` = the *repo-root* URL, `method` tag, created_at
 * within ±60s of the relay's clock. Media auth moved with the media tools to
 * the buzz CLI, which mints its own Blossom events.
 *
 * Events are built through the NIP-OA builder so they carry the owner
 * attestation — the relay resolves agent permissions through it.
 */

import type { AgentEventBuilder } from "../nostr/event-builder.js";
import { KIND } from "../nostr/types.js";
import type { Clock } from "../runtime/ports.js";

function encode(event: unknown): string {
  return Buffer.from(JSON.stringify(event), "utf8").toString("base64");
}

/** `Authorization` value for a git request against `repoRootUrl`. */
export function nip98Header(
  builder: AgentEventBuilder,
  clock: Clock,
  repoRootUrl: string,
  method: string,
): string {
  const event = builder.build({
    kind: KIND.HTTP_AUTH,
    tags: [
      ["u", repoRootUrl],
      ["method", method.toUpperCase()],
    ],
    content: "",
    created_at: Math.floor(clock.now() / 1000),
  });
  return `Nostr ${encode(event)}`;
}

