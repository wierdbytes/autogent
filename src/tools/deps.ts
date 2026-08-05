/**
 * Shared helpers for the harness-side relay infrastructure.
 *
 * The seven model-visible relay tools that used to live here were replaced by
 * the `buzz` CLI (buzz-cli plan): the model drives the relay through the shim
 * + {@link BuzzCliBroker} pipeline, and the only harness-owned pieces left are
 * the git auth proxy and the broker itself.
 */

/** `wss://relay.example[/path]` → `https://relay.example` (and ws → http). */
export function httpOriginOf(relayUrl: string): string {
  const url = new URL(relayUrl);
  const scheme = url.protocol === "ws:" ? "http:" : "https:";
  return `${scheme}//${url.host}`;
}
