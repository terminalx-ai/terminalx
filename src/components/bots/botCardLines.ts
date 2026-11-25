import type { BotMessage } from "@terminalx/portable/events";
import type { BotAccess } from "@/types/bots";
import { accessLabel } from "./botLabels";

/**
 * The two lines of a hand-off's card that say, to the owner, what the sending bot is to the receiving one and what it
 * may do (PRO-539, worded by the owner on 2026-11-25 in PRO-517, PRO-571). Both are the owner's view of what the
 * agent's own text already says ("your lead, a bot with full access"); neither changes that text.
 *
 * - `relationLine`: under the card's body, by `card.relation` (`relation_id` in `src-tauri/src/bots/handoffs.rs`).
 * - `lowerAccessLine`: after the two access chips, when the sender may do less than the receiver.
 *
 * Both are drawn on a hand-off's card only: "does this" is the work handed. A relation this build does not know (a
 * newer TerminalX wrote it) has no line: never a guess, never another relation's words. The words are security
 * wording, fixed by the owner: they are shown whole and wrap, never shortened.
 */

/** What the sender is to the receiver, in the owner's view, or null when there is no line for it. */
export function relationLine(card: BotMessage, fromName: string, toName: string): string | null {
  if (card.kind !== "handoff") return null;
  switch (card.relation) {
    case "lead":
      return `${toName} reports to ${fromName}.`;
    case "report":
      return `${fromName} reports to ${toName}.`;
    case "listed":
      return `You let ${fromName} hand work to ${toName}.`;
    case "pointed":
      return `You pointed ${fromName} to ${toName}.`;
    default:
      return null;
  }
}

/**
 * What it means that the sender may do less than the receiver, in the owner's view, in the receiver's access words.
 * The card asks only when the sender's access is lower than the receiver's.
 */
export function lowerAccessLine(card: BotMessage, fromName: string, toName: string): string | null {
  if (card.kind !== "handoff" || !card.toAccess) return null;
  return `${toName} does this with their own access (${accessLabel(card.toAccess as BotAccess)}), which is more than ${fromName} has.`;
}
