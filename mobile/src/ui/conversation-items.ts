import type { Turn } from "@terminalx/portable/transcript";
import type { ChatNote } from "../data/host-api";
import { textChunks } from "./markdown-blocks";
import { turnRows, type TurnRow } from "./transcript-rows";

export type ConversationItem = { key: string; kind: "turn"; row: TurnRow } | { key: string; kind: "note"; note: ChatNote; first: boolean };

/**
 * How long after saving a note an older phone sent it to the agent. Those
 * phones sent every message as a note and then promoted it, and the host kept
 * no record of that (#541). So a note with no promotion on it is taken for a
 * user message of this tab with the same text, published within this long
 * after it, and is not shown again. A heuristic: a note posted on purpose and
 * then sent with the same words this soon is hidden too, and its text still
 * shows once, as the message.
 */
const UNRECORDED_PROMOTION_MS = 60_000;

/**
 * A conversation's rows: its turns and the session's notes, in time order.
 * A note that was sent to this tab's agent is the prompt of the turn it
 * started, and is shown once, as that prompt.
 */
export function conversationItems(turns: Turn[], notes: ChatNote[], tabId: string): ConversationItem[] {
  const messages = userMessages(turns);
  const groups: ({ kind: "turn"; turn: Turn } | { kind: "note"; note: ChatNote })[] = [
    ...turns.map((turn) => ({ kind: "turn" as const, turn })),
    ...notes.filter((note) => !sentHere(note, tabId, messages)).map((note) => ({ kind: "note" as const, note })),
  ].sort((left, right) => itemTime(left) - itemTime(right));
  return groups.flatMap<ConversationItem>((group) => group.kind === "turn"
    ? turnRows(group.turn).map((row) => ({ key: row.key, kind: "turn" as const, row }))
    : textChunks(group.note.body).map((body, index) => ({ key: `note-${group.note.id}:${index}`, kind: "note" as const, note: { ...group.note, body }, first: index === 0 })));
}

type UserMessage = { text: string; ts: number; userId?: string };

/** What was said to the agent: each turn's prompt, and messages still queued in a turn. */
function userMessages(turns: Turn[]): UserMessage[] {
  return turns.flatMap((turn) => [
    ...(turn.prompt ? [{ text: turn.prompt.text, ts: Date.parse(turn.prompt.ts), userId: turn.prompt.author?.userId }] : []),
    ...turn.work.flatMap((item) => item.kind === "queued" && item.ts ? [{ text: item.text, ts: Date.parse(item.ts), userId: item.author?.userId }] : []),
  ]);
}

function sentHere(note: ChatNote, tabId: string, messages: UserMessage[]): boolean {
  if (note.promotedTo) return note.promotedTo.some((promotion) => promotion.tabId === tabId);
  const body = note.body.trim();
  // A phone's message is published without an author; any other author is someone else.
  return messages.some((message) => message.text.trim() === body
    && (message.userId === undefined || message.userId === note.author.userId)
    && message.ts >= note.createdAt && message.ts - note.createdAt <= UNRECORDED_PROMOTION_MS);
}

function itemTime(item: { kind: "turn"; turn: Turn } | { kind: "note"; note: ChatNote }) { return item.kind === "turn" ? Date.parse(item.turn.ts) : item.note.createdAt; }
