/**
 * Harness-side relay infrastructure (buzz-cli plan §1).
 *
 * The model reaches the relay through the `buzz` CLI: a shim in the
 * container's PATH forwards to {@link BuzzCliBroker}, which spawns the real
 * binary with credentials injected. Git transport stays on the loopback
 * {@link GitAuthProxy}, which signs NIP-98 headers per request. Neither is a
 * model-visible tool — Pi sees only its built-in tools; the CLI is discovered
 * through the system prompt (`src/prompts/buzz-cli.ts`).
 */

export { httpOriginOf } from "./deps.js";
export { GitAuthProxy } from "./git-tools.js";
export { BuzzCliBroker, defaultBuzzSocketPath } from "./buzz-broker.js";
export type { BuzzCliBrokerOptions } from "./buzz-broker.js";
