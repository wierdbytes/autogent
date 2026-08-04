/**
 * Shared surface for the relay tools (remote plan §5).
 *
 * The tools never see the signer's key material, only the capabilities: sign
 * an HTTP-auth event, query the relay, enqueue an outbound chat message. The
 * auto-reply invariant stays intact — a tool can *add* messages, it cannot
 * redirect where the model's ordinary visible output goes.
 */

import type { AgentEventBuilder } from "../nostr/event-builder.js";
import type { Signer } from "../nostr/signer.js";
import type { Clock, Logger, RelayPort } from "../runtime/ports.js";

export interface RelayToolDeps {
  relay: RelayPort;
  signer: Signer;
  builder: AgentEventBuilder;
  clock: Clock;
  logger: Logger;
  /** Channels the agent is currently a member of (early refusal gate). */
  knownChannels(): ReadonlySet<string>;
  /** The model's working directory; media and clones stay inside it. */
  workspaceDir: string;
  /** `https://…` origin of the relay's HTTP side (git, media). */
  httpOrigin: string;
  /**
   * Enqueues a chat message through the durable outbox — the same
   * write→sign→publish→confirm path the auto-reply uses.
   */
  sendChat(
    channelId: string,
    content: string,
    reply: { rootEventId: string } | null,
  ): Promise<{ eventId: string }>;
  /** Upload/download ceiling for media, in bytes. */
  maxMediaBytes: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Structural twin of the pi SDK's `ToolDefinition`.
 *
 * Declared locally (with plain JSON-Schema parameters) so the tools module
 * does not import the SDK: the schema objects are ordinary JSON that the
 * SDK's TypeBox validator accepts, and the array is handed to
 * `createAgentSession({ customTools })` as-is.
 */
export interface RelayToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

export interface RelayTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RelayToolResult>;
}

export function textResult(text: string, details: unknown = null): RelayToolResult {
  return { content: [{ type: "text", text }], details };
}

export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

/** Uniform failure envelope: refusals and errors surface as tool text. */
export function asToolError(error: unknown): RelayToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return textResult(`error: ${message}`, { error: true });
}

/** `wss://relay.example[/path]` → `https://relay.example` (and ws → http). */
export function httpOriginOf(relayUrl: string): string {
  const url = new URL(relayUrl);
  const scheme = url.protocol === "ws:" ? "http:" : "https:";
  return `${scheme}//${url.host}`;
}
