/**
 * HTTP auth events for the relay's non-WebSocket doors (remote plan §5).
 *
 * Two schemes, both `Authorization: Nostr <base64(event JSON)>`:
 *
 * - **NIP-98** (kind 27235) for git Smart HTTP: `u` = the *repo-root* URL,
 *   `method` tag, created_at within ±60s of the relay's clock;
 * - **Blossom** (kind 24242) for media: `t` = upload|get verb, `x` = blob
 *   sha256, `expiration` in the near future.
 *
 * Events are built through the NIP-OA builder so they carry the owner
 * attestation — the relay resolves agent permissions through it.
 */

import type { AgentEventBuilder } from "../nostr/event-builder.js";
import { KIND } from "../nostr/types.js";
import type { Clock } from "../runtime/ports.js";

/** Blossom's HTTP-auth kind (BUD-01). Never stored by the relay. */
export const BLOSSOM_AUTH_KIND = 24242;

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

/** `Authorization` value for a Blossom upload/get of blob `sha256`. */
export function blossomHeader(
  builder: AgentEventBuilder,
  clock: Clock,
  verb: "upload" | "get",
  sha256: string,
): string {
  const nowSec = Math.floor(clock.now() / 1000);
  const event = builder.build({
    kind: BLOSSOM_AUTH_KIND,
    tags: [
      ["t", verb],
      ["x", sha256],
      ["expiration", String(nowSec + 300)],
    ],
    content: `${verb} ${sha256}`,
    created_at: nowSec,
  });
  return `Nostr ${encode(event)}`;
}
