import type { Turn } from "@terminalx/portable/transcript";
import type { ChatNote } from "@mobile/data/host-api";
import { textChunks } from "./markdown-blocks";
import { turnRows, type TurnRow } from "./transcript-rows";

export type ConversationItem = { key: string; kind: "turn"; row: TurnRow } | { key: string; kind: "note"; note: ChatNote; first: boolean };

/**
 * How long after saving a note a phone from before #541 sent it on. Those
 * phones saved every message for the agent as a worktree note and then
 * promoted it, and the host did not record the promotion.
 */
const UNRECORDED_PROMOTION_MS = 30_000;

type SentPrompt = { text: string; at: number; author?: { userId: string } };

/**
 * One tab's conversation: its turns and the session's worktree notes in time
 * order. A note that was sent to this tab's agent is already the user message
 * of the turn it started, so it is left out rather than shown twice (#541).
 */
export function conversationItems(turns: Turn[], notes: ChatNote[], tabId: string): ConversationItem[] {
  const prompts = sentPrompts(turns);
  const groups: ({ kind: "turn"; turn: Turn } | { kind: "note"; note: ChatNote })[] = [
    ...turns.map((turn) => ({ kind: "turn" as const, turn })),
    ...notes.filter((note) => !sentToAgent(note, tabId, prompts)).map((note) => ({ kind: "note" as const, note })),
  ].sort((left, right) => itemTime(left) - itemTime(right));
  return groups.flatMap<ConversationItem>((group) => group.kind === "turn"
    ? turnRows(group.turn).map((row) => ({ key: row.key, kind: "turn" as const, row }))
    : textChunks(group.note.body).map((body, index) => ({ key: `note-${group.note.id}:${index}`, kind: "note" as const, note: { ...group.note, body }, first: index === 0 })));
}

function sentToAgent(note: ChatNote, tabId: string, prompts: SentPrompt[]): boolean {
  if (note.promotedTo?.some((promotion) => promotion.tabId === tabId)) return true;
  // A heuristic for notes from before the host recorded promotions: a prompt
  // with the same text, from the same person when the prompt names one,
  // published within moments after the note was saved. It can also hide a
  // note someone added by hand and then sent word for word; the text is
  // still shown once, as the prompt.
  const body = note.body.trim();
  return prompts.some((prompt) => prompt.text === body
    && prompt.at >= note.createdAt && prompt.at - note.createdAt <= UNRECORDED_PROMOTION_MS
    && (!prompt.author || prompt.author.userId === note.author.userId));
}

/** Every message sent to the agent: turn prompts, and messages still queued inside a turn. */
function sentPrompts(turns: Turn[]): SentPrompt[] {
  return turns.flatMap((turn) => [
    ...(turn.prompt ? [{ text: turn.prompt.text.trim(), at: Date.parse(turn.prompt.ts), author: turn.prompt.author }] : []),
    ...turn.work.flatMap((item) => item.kind === "queued" ? [{ text: item.text.trim(), at: Date.parse(item.ts ?? ""), author: item.author }] : []),
  ]);
}

function itemTime(item: { kind: "turn"; turn: Turn } | { kind: "note"; note: ChatNote }) { return item.kind === "turn" ? Date.parse(item.turn.ts) : item.note.createdAt; }
