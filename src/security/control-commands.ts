/**
 * Owner chat controls (plan §6.9).
 *
 * `!cancel`, `!shutdown` and `!rotate` arrive as ordinary chat events, so they
 * must be recognised *before* the prompt path — otherwise `!shutdown` would be
 * handed to the model as a question about shutting down.
 *
 * Three conditions all have to hold: the event is a chat event, the author is
 * the owner, and the agent is genuinely `p`-tagged. Matching the text alone is
 * not enough, because anyone in a channel can type `!shutdown`. When any
 * condition fails the event is *not* consumed — it is a normal message that
 * happens to contain the word, and it continues down the regular pipeline.
 *
 * The command still has to be the whole message, but `@mention` text at either
 * end is discarded first. Without that the commands are unreachable by hand: a
 * default `subscribe: mentions` agent only receives `p`-tagged messages, and
 * Buzz's composer always writes an `@Name` into the body when it adds that tag.
 */

import { KIND } from "../nostr/types.js";
import type { NostrTag } from "../nostr/types.js";

export type ControlCommand = "cancel" | "shutdown" | "rotate";

/** Wire text -> command. The `!` prefix keeps these out of normal prose. */
const COMMANDS: ReadonlyMap<string, ControlCommand> = new Map([
  ["!cancel", "cancel"],
  ["!shutdown", "shutdown"],
  ["!rotate", "rotate"],
]);

/** The minimum of a chat event this decision needs. */
export interface ControlCommandEvent {
  kind: number;
  pubkey: string;
  content: string;
  tags: readonly NostrTag[];
}

export interface ControlCommandContext {
  agentPubkey: string;
  /** Null before provisioning; no owner means no controls. */
  ownerPubkey: string | null;
  /**
   * The agent's own display name, matched as one unit so that a name with
   * spaces (`@Pi Agent !shutdown`) survives — whitespace splitting alone would
   * leave `Agent !shutdown` behind.
   */
  agentName?: string;
}

/** True when the event `p`-tags this exact agent. */
export function mentionsAgent(tags: readonly NostrTag[], agentPubkey: string): boolean {
  return tags.some((tag) => tag[0] === "p" && tag[1] === agentPubkey);
}

/**
 * Returns the command when the event is an authenticated owner control, else
 * null so the caller keeps treating it as an ordinary message.
 *
 * The whole content must be the command: an exact match stops a message that
 * merely quotes `!cancel` in a sentence from aborting a turn.
 */
export function parseControlCommand(
  event: ControlCommandEvent,
  context: ControlCommandContext,
): ControlCommand | null {
  if (event.kind !== KIND.CHAT) return null;
  const command = COMMANDS.get(stripEdgeMentions(event.content, context.agentName));
  if (command === undefined) return null;
  if (context.ownerPubkey === null || event.pubkey !== context.ownerPubkey) return null;
  if (!mentionsAgent(event.tags, context.agentPubkey)) return null;
  return command;
}

/** True when the text would be a control if it came from the owner. */
export function looksLikeControlCommand(content: string, agentName?: string): boolean {
  return COMMANDS.has(stripEdgeMentions(content, agentName));
}

/** One `@…` run at the start or the end, or null when there is none to take. */
function stripOneMention(text: string, agentName: string | undefined): string | null {
  if (agentName !== undefined && agentName !== "") {
    const own = `@${agentName}`.toLowerCase();
    const lower = text.toLowerCase();
    if (lower.startsWith(own)) return text.slice(own.length).trimStart();
    if (lower.endsWith(own)) return text.slice(0, text.length - own.length).trimEnd();
  }

  const leading = /^@\S+/.exec(text);
  if (leading !== null) return text.slice(leading[0].length).trimStart();

  const trailing = /@\S+$/.exec(text);
  if (trailing !== null) return text.slice(0, trailing.index).trimEnd();

  return null;
}

/**
 * `content` with mentions peeled off both ends, stopping the moment what is
 * left is a command.
 *
 * Deliberately edge-only, and deliberately not a general mention parser: text
 * between the mentions is never removed, so `"remind me to !cancel @bot"` keeps
 * its prose and stays an ordinary message. Only a message that *is* the command
 * plus mentions is consumed.
 */
export function stripEdgeMentions(content: string, agentName?: string): string {
  let text = content.trim();
  // Bounded: each pass must shorten the string, and a message cannot carry an
  // unlimited number of mentions worth peeling.
  for (let pass = 0; pass < 8; pass += 1) {
    if (COMMANDS.has(text)) return text;
    const next = stripOneMention(text, agentName);
    if (next === null || next === text) return text;
    text = next;
  }
  return text;
}
