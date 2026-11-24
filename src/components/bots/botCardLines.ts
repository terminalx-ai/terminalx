import type { BotMessage } from "@terminalx/portable/events";

/**
 * The lines of a bot message's card that the owner has not worded yet (PRO-539). Every card asks here, at the place
 * the design draws the line, and draws nothing while the answer is null. Each line is added in this file alone: the
 * cards already carry what a line needs (`relation`, the two names, the two access levels) and already leave it room.
 *
 * Left out, waiting for the owner's own words:
 * - `relationLine`: what the sender is to the receiver, said to the owner, under a card's body (design 23.14's line
 *   with the person-and-tick mark). Four cases, by `card.relation`: `lead` (the receiver's lead), `report` (a bot
 *   that reports to the receiver), `listed` (the receiver's Who can ask lets the sender hand it work; 23.17 shows a
 *   proposal for this one, not approved) and `pointed` (a bot the owner pointed the receiver to).
 * - `lowerAccessLine`: the sentence beside the two access chips when the sender may do less than the receiver
 *   (23.17 shows a proposal, not approved). The chips themselves are drawn.
 */

/** What the sender is to the receiver, in the owner's view. Not worded yet for any relation. */
export function relationLine(_card: BotMessage, _fromName: string, _toName: string): string | null {
  return null;
}

/** What it means that the sender may do less than the receiver, in the owner's view. Not worded yet. */
export function lowerAccessLine(_card: BotMessage, _fromName: string, _toName: string): string | null {
  return null;
}
