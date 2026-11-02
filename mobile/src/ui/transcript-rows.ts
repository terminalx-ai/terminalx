import type { Token } from "marked";
import type { Delivery, Turn, WorkItem } from "@terminalx/portable/transcript";
import { markdownBlocks, textChunks } from "./markdown-blocks";

export type TurnRow = { key: string; startsTurn: boolean; ts?: string } & (
  /** `note`: under the last of a message's rows, what became of it on its way to the agent (#722). */
  | { kind: "prompt"; text: string; note?: string }
  | { kind: "markdown"; token: Token }
  | { kind: "work"; item: WorkItem }
);

/** What became of a message of the reader's on its way to the agent, in a line (#722). */
export function deliveryNote(delivery: Delivery): string | undefined {
  if (delivery.replaced) return "Not answered: the agent dropped this turn before replying, and took a later prompt in its place.";
  if (delivery.withdrawn) return "Not sent: the agent was stopped while its input box had text in it, so this message was never typed.";
  if (delivery.inputOccupied) return "Waiting: the agent's input box already has text in it. Send or clear that text in the terminal, and this message goes in after it.";
  if (delivery.sent !== undefined) return "Changed on the way: this is what the agent received.";
  return undefined;
}

// A turn is a grouping for transcript semantics, not a virtualization unit.
// Give the list individual message blocks with stable keys during streaming,
// tool completion, reconnects, and insertion of earlier turns.
export function turnRows(turn: Turn): TurnRow[] {
  const rows: TurnRow[] = [];
  const addMarkdown = (key: string, text: string, ts?: string) => {
    for (const [index, token] of markdownBlocks(text).entries()) rows.push({ key: `${key}:${index}`, kind: "markdown", token, startsTurn: false, ts: index === 0 ? ts : undefined });
  };
  const note = (rows: TurnRow[], delivery: Delivery) => {
    const last = rows[rows.length - 1];
    const said = deliveryNote(delivery);
    if (last?.kind === "prompt" && said) last.note = said;
  };
  if (turn.prompt) {
    const chunks = turn.prompt.text ? textChunks(turn.prompt.text) : [""];
    for (const [index, text] of chunks.entries()) rows.push({ key: `prompt:${turn.prompt.seq}:${index}`, kind: "prompt", text, startsTurn: false, ts: index === 0 ? turn.prompt.messageTs : undefined });
    note(rows, turn.prompt);
  }
  for (const item of turn.work) {
    if (item.kind === "text") addMarkdown(item.key, item.text, item.messageTs);
    // A message the agent took mid-turn is the reader's, drawn like the prompt.
    else if (item.kind === "message") {
      for (const [index, text] of (item.text ? textChunks(item.text) : [""]).entries()) rows.push({ key: `${item.key}:${index}`, kind: "prompt", text, startsTurn: false, ts: index === 0 ? item.messageTs : undefined });
      note(rows, item);
    } else if ("text" in item) {
      for (const [index, text] of textChunks(item.text).entries()) rows.push({ key: `${item.key}:${index}`, kind: "work", item: { ...item, text, ...((item.kind === "queued") ? { messageTs: index === 0 ? item.messageTs : undefined } : {}) }, startsTurn: false });
    } else rows.push({ key: item.key, kind: "work", item, startsTurn: false });
  }
  if (turn.finalText) addMarkdown(`final:${turn.key}`, turn.finalText);
  if (rows.length) rows[0].startsTurn = true;
  return rows;
}
