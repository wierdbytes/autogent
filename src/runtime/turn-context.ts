/**
 * Immutable turn identity (plan §1.3).
 *
 * Every outbound artefact of a turn — chat replies, telemetry, metrics — derives
 * its routing exclusively from this snapshot. The model never contributes to it,
 * which is what makes prompt injection unable to redirect output (plan §10.2).
 */

/** Where an accepted input sits in a turn. */
export type TurnInputRole = "primary" | "steer";

/** One accepted Nostr input that belongs to a turn. */
export interface TurnInput {
  eventId: string;
  role: TurnInputRole;
  authorPubkey: string;
  /** Order of acceptance within the turn, starting at 0 for the primary. */
  ordinal: number;
  createdAt: number;
}

/**
 * The reply target of a turn, fixed at creation.
 *
 * Crucially `primaryTriggerEventId` never advances to an agent-authored event:
 * all assistant outputs of the turn reply to the user message that started it,
 * so the agent never builds a reply chain through its own messages.
 */
export interface TurnContext {
  readonly turnId: string;
  readonly channelId: string;
  readonly threadRootEventId: string;
  readonly primaryTriggerEventId: string;
  readonly primaryAuthorPubkey: string;
  readonly startedAtMs: number;
  readonly acceptedInputEventIds: readonly string[];
  readonly participantPubkeys: readonly string[];
  readonly inputs: readonly TurnInput[];
}

export interface CreateTurnContextArgs {
  turnId: string;
  channelId: string;
  threadRootEventId: string;
  primaryTriggerEventId: string;
  primaryAuthorPubkey: string;
  startedAtMs: number;
  primaryCreatedAt: number;
}

export function createTurnContext(args: CreateTurnContextArgs): TurnContext {
  const primary: TurnInput = {
    eventId: args.primaryTriggerEventId,
    role: "primary",
    authorPubkey: args.primaryAuthorPubkey,
    ordinal: 0,
    createdAt: args.primaryCreatedAt,
  };
  return Object.freeze({
    turnId: args.turnId,
    channelId: args.channelId,
    threadRootEventId: args.threadRootEventId,
    primaryTriggerEventId: args.primaryTriggerEventId,
    primaryAuthorPubkey: args.primaryAuthorPubkey,
    startedAtMs: args.startedAtMs,
    acceptedInputEventIds: Object.freeze([args.primaryTriggerEventId]),
    participantPubkeys: Object.freeze([args.primaryAuthorPubkey]),
    inputs: Object.freeze([primary]),
  });
}

/**
 * Returns a new context with a steering input folded in.
 *
 * The reply target and thread root are deliberately untouched — only the
 * participant set grows, so the steering author keeps receiving notifications
 * without the agent re-anchoring its replies (plan §1.3).
 */
export function withSteeringInput(
  context: TurnContext,
  input: { eventId: string; authorPubkey: string; createdAt: number },
): TurnContext {
  if (context.acceptedInputEventIds.includes(input.eventId)) return context;
  const next: TurnInput = {
    eventId: input.eventId,
    role: "steer",
    authorPubkey: input.authorPubkey,
    ordinal: context.inputs.length,
    createdAt: input.createdAt,
  };
  const participants = context.participantPubkeys.includes(input.authorPubkey)
    ? context.participantPubkeys
    : [...context.participantPubkeys, input.authorPubkey];
  return Object.freeze({
    ...context,
    acceptedInputEventIds: Object.freeze([...context.acceptedInputEventIds, input.eventId]),
    participantPubkeys: Object.freeze(participants),
    inputs: Object.freeze([...context.inputs, next]),
  });
}
