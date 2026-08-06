/**
 * Formats inbound Nostr events into the prompt text handed to Pi.
 *
 * The turn prompt is deliberately minimal — `From`/`Time`/`Content` and nothing
 * else. Everything static for the session (channel, scope, thread root, the
 * agent's own username, reply routing, buzz CLI hints) lives in the system
 * prompt instead (see `formatSystemPromptContext`), and prior conversation is
 * seeded into the session as real `user`/`assistant` turns rather than pasted
 * into the prompt.
 *
 * Everything below `Content:` is untrusted input. It is never merged with
 * system instructions (plan §7.2).
 */

import { npubEncode } from "nostr-tools/nip19";

export type ChannelType = "stream" | "private" | "dm";

export interface PromptChannelInfo {
  channelId: string;
  name: string | null;
  channelType: ChannelType;
}

/** One inbound message, resolved for display. */
export interface EventBlockArgs {
  /** Bare display name from the author's kind 0 profile, when known. */
  authorLabel: string | null;
  authorPubkey: string;
  /** Unix seconds. */
  createdAt: number;
  content: string;
}

function channelDisplay(channel: PromptChannelInfo): string {
  return channel.name ? `${channel.name} (#${channel.channelId})` : channel.channelId;
}

function rfc3339(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** `@username` when the profile is known, `npub1…` otherwise. */
export function displayAuthor(label: string | null, pubkey: string): string {
  if (label) return `@${label}`;
  try {
    return npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

/**
 * The message block delivered for every inbound event:
 *
 *     From: @WierdBytes
 *     Time: 2026-08-06T15:04:16.000Z
 *     Content:
 *     @Линкед Коуч и ещё один
 */
export function formatEventBlock(args: EventBlockArgs): string {
  return [
    `From: ${displayAuthor(args.authorLabel, args.authorPubkey)}`,
    `Time: ${rfc3339(args.createdAt)}`,
    `Content:`,
    args.content,
  ].join("\n");
}

/** The prompt for the event that starts a turn. */
export function formatPrimaryPrompt(args: EventBlockArgs): string {
  return formatEventBlock(args);
}

/**
 * The prompt for a message that arrives mid-turn in the same conversation.
 *
 * Framed as an addition rather than a replacement: the agent should fold it
 * into the work already in flight instead of restarting (plan §1.4).
 */
export function formatSteeringPrompt(args: EventBlockArgs): string {
  const header =
    "[Steering]\nA new message arrived while you were working. Fold it into the work in progress if relevant; otherwise finish what you started.";
  return `${header}\n\n${formatEventBlock(args)}`;
}

export interface SystemPromptContextArgs {
  channel: PromptChannelInfo;
  /** Canonical thread root when this session is bound to a thread. */
  threadRootId: string | null;
  /** The agent's own profile name, shown to the model as its username. */
  selfName: string;
}

/**
 * Static, per-session context lines injected into the system prompt right
 * below `Current working directory` (see `shapeSystemPrompt`).
 *
 * The buzz CLI hints carry the concrete channel UUID (and thread root) so the
 * model can read history without guessing identifiers. The *reply* instruction
 * stays inverted relative to buzz-acp: the visible answer is published
 * automatically from the turn's immutable reply target, and telling the model
 * otherwise would invite it to try to control routing it does not own.
 */
export function formatSystemPromptContext(args: SystemPromptContextArgs): string[] {
  const { channel, threadRootId } = args;
  const isDm = channel.channelType === "dm";
  const scope = threadRootId ? "thread" : isDm ? "dm" : "channel";
  const channelId = channel.channelId;

  const lines = [`Scope: ${scope}`, `Channel: ${channelDisplay(channel)}`];
  if (threadRootId) lines.push(`Thread root: ${threadRootId}`);
  lines.push(
    `Self username: @${args.selfName}`,
    "Replies: your visible answer is published to this channel automatically as a reply to the triggering message. Do not attempt to send it yourself.",
    threadRootId
      ? `Buzz CLI: \`buzz messages thread --channel ${channelId} --event ${threadRootId}\` reads this thread; \`buzz messages get --channel ${channelId}\` reads recent channel history.`
      : `Buzz CLI: \`buzz messages get --channel ${channelId}\` reads recent channel history; \`buzz messages thread --channel ${channelId} --event <root-id>\` reads a thread.`,
  );
  return lines;
}
