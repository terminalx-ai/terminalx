import type { Token } from "marked";
import type { Turn, WorkItem } from "@terminalx/portable/transcript";
import { markdownBlocks, textChunks } from "./markdown-blocks";

export type TurnRow = { key: string; startsTurn: boolean } & (
  | { kind: "prompt"; text: string }
  | { kind: "markdown"; token: Token }
  | { kind: "work"; item: WorkItem }
);

// A turn is a grouping for transcript semantics, not a virtualization unit.
// Give the list individual message blocks with stable keys during streaming,
// tool completion, reconnects, and insertion of earlier turns.
export function turnRows(turn: Turn): TurnRow[] {
  const rows: TurnRow[] = [];
  const addMarkdown = (key: string, text: string) => {
    for (const [index, token] of markdownBlocks(text).entries()) rows.push({ key: `${key}:${index}`, kind: "markdown", token, startsTurn: false });
  };
  if (turn.prompt) {
    const chunks = turn.prompt.text ? textChunks(turn.prompt.text) : [""];
    for (const [index, text] of chunks.entries()) rows.push({ key: `prompt:${turn.prompt.seq}:${index}`, kind: "prompt", text, startsTurn: false });
  }
  for (const item of turn.work) {
    if (item.kind === "text") addMarkdown(item.key, item.text);
    else if ("text" in item) {
      for (const [index, text] of textChunks(item.text).entries()) rows.push({ key: `${item.key}:${index}`, kind: "work", item: { ...item, text }, startsTurn: false });
    } else rows.push({ key: item.key, kind: "work", item, startsTurn: false });
  }
  if (turn.finalText) addMarkdown(`final:${turn.key}`, turn.finalText);
  if (rows.length) rows[0].startsTurn = true;
  return rows;
}
