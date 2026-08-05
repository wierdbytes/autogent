/**
 * Formats an inbound Nostr event into the prompt text handed to Pi.
 *
 * The layout is not cosmetic. Buzz Desktop reconstructs the triggering user
 * message by parsing this text out of the telemetry frame:
 *
 *   - sections are split on lines matching `^\[([^\]]+)]\s*$`
 *   - the user's message is the section whose title starts with `buzz event`
 *   - the author is `/^From:.*\bhex:\s*([0-9a-fA-F]{64})/m`
 *   - the event id is `/^Event ID:\s*([0-9a-fA-F]{64})\b/m`
 *
 * (`desktop/src/features/agents/ui/agentSessionTranscript.ts`). The field order
 * mirrors `format_event_block` in `crates/buzz-acp/src/queue.rs` so an existing
 * Desktop renders our transcript identically to a buzz-acp one.
 *
 * Everything below the section headers is untrusted input. It is fenced into
 * labelled sections and never merged with system instructions (plan §7.2).
 */

import type { NostrEvent } from "../nostr/types.js";
import { parseThreadTags } from "./conversation-key.js";

export type ChannelType = "stream" | "private" | "dm";

export interface PromptChannelInfo {
  channelId: string;
  name: string | null;
  channelType: ChannelType;
}

/** One prior message supplied as conversation context. */
export interface ContextMessage {
  eventId: string;
  authorPubkey: string;
  authorLabel: string | null;
  createdAt: number;
  content: string;
}

export interface ConversationContext {
  kind: "thread" | "conversation";
  messages: ContextMessage[];
  total: number;
  truncated: boolean;
}

export interface FormatPromptArgs {
  event: NostrEvent;
  channel: PromptChannelInfo;
  /** Human-readable label for the author, when a profile is known. */
  authorLabel?: string | null;
  /** `npub1…` form of the author key, for readability in the transcript. */
  authorNpub?: string | null;
  context?: ConversationContext | null;
  /** Why this event reached the agent, e.g. `@mention`. */
  promptTag?: string;
}

function channelDisplay(channel: PromptChannelInfo): string {
  return channel.name ? `${channel.name} (#${channel.channelId})` : channel.channelId;
}

function rfc3339(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function actor(pubkey: string, label: string | null | undefined, npub: string | null | undefined): string {
  const identity = npub ?? pubkey;
  return label ? `${label} (npub: ${identity}, hex: ${pubkey})` : `${identity} (hex: ${pubkey})`;
}

/**
 * The `[Context]` section.
 *
 * The buzz CLI hints carry the concrete channel UUID (and thread root) so the
 * model can read history without guessing identifiers, in the style of
 * buzz-acp's context block. Unlike buzz-acp, the *reply* instruction stays
 * inverted: the visible answer is published automatically from the turn's
 * immutable reply target, and telling the model otherwise would invite it to
 * try to control routing it does not own.
 */
function formatContextSection(args: FormatPromptArgs): string {
  const { rootEventId, replyEventId } = parseThreadTags(args.event.tags);
  const isDm = args.channel.channelType === "dm";
  const scope = isDm ? "dm" : rootEventId ? "thread" : "channel";
  const channelId = args.channel.channelId;

  const lines = [`[Context]`, `Scope: ${scope}`, `Channel: ${channelDisplay(args.channel)}`];
  if (rootEventId) {
    lines.push(`Thread root: ${rootEventId}`);
    if (replyEventId && replyEventId !== rootEventId) lines.push(`Parent: ${replyEventId}`);
  }
  lines.push(
    "Replies: your visible answer is published to this channel automatically as a reply to the triggering message. Do not attempt to send it yourself.",
    rootEventId
      ? `Buzz CLI: \`buzz messages thread --channel ${channelId} --event ${rootEventId}\` reads this thread; \`buzz messages get --channel ${channelId}\` reads recent channel history.`
      : `Buzz CLI: \`buzz messages get --channel ${channelId}\` reads recent channel history; \`buzz messages thread --channel ${channelId} --event <root-id>\` reads a thread.`,
  );
  return lines.join("\n");
}

/** The `[Buzz event: …]` block Desktop parses for author and event id. */
export function formatEventBlock(args: FormatPromptArgs): string {
  const { event } = args;
  const lines = [
    `Event ID: ${event.id}`,
    `Channel: ${channelDisplay(args.channel)}`,
    `Kind: ${event.kind}`,
    `From: ${actor(event.pubkey, args.authorLabel, args.authorNpub)}`,
    `Time: ${rfc3339(event.created_at)}`,
    `Content: ${event.content}`,
    `Tags: ${JSON.stringify(event.tags)}`,
  ];

  const { rootEventId, replyEventId } = parseThreadTags(event.tags);
  const parsed: string[] = [];
  if (replyEventId) parsed.push(`parent=${replyEventId}`);
  if (rootEventId) parsed.push(`root=${rootEventId}`);
  const mentions = event.tags.filter((tag) => tag[0] === "p" && tag[1]).map((tag) => tag[1] as string);
  if (mentions.length > 0) parsed.push(`mentions=[${mentions.join(", ")}]`);
  if (parsed.length > 0) lines.push(`Parsed: ${parsed.join(", ")}`);

  return lines.join("\n");
}

function formatConversationContext(context: ConversationContext): string {
  const header = context.kind === "thread" ? "[Thread Context]" : "[Conversation Context]";
  const lines = [header];
  if (context.truncated) {
    lines.push(`Showing ${context.messages.length} of ${context.total} messages (older elided).`);
  }
  for (const message of context.messages) {
    const who = message.authorLabel ?? message.authorPubkey;
    lines.push(`--- ${who} at ${rfc3339(message.createdAt)} (${message.eventId})`);
    lines.push(message.content);
  }
  return lines.join("\n");
}

/** The prompt for the event that starts a turn. */
export function formatPrimaryPrompt(args: FormatPromptArgs): string {
  const sections = [formatContextSection(args)];
  if (args.context && args.context.messages.length > 0) {
    sections.push(formatConversationContext(args.context));
  }
  sections.push(`[Buzz event: ${args.promptTag ?? "@mention"}]\n${formatEventBlock(args)}`);
  return sections.join("\n\n");
}

/**
 * The prompt for a message that arrives mid-turn in the same thread.
 *
 * Framed as an addition rather than a replacement: the agent should fold it into
 * the work already in flight instead of restarting (plan §1.4).
 */
export function formatSteeringPrompt(args: FormatPromptArgs): string {
  // The header section must not be titled "Buzz event…": Desktop takes the
  // *first* section whose title starts with that prefix as the user's message,
  // and it has to find the event block, not this framing.
  const header =
    "[Steering]\nA new message arrived while you were working. Fold it into the work in progress if relevant; otherwise finish what you started.";
  return `${header}\n\n[Buzz event: ${args.promptTag ?? "@mention"}]\n${formatEventBlock(args)}`;
}
