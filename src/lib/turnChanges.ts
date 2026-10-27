import type { FileEdit } from "@terminalx/portable/events";
import type { Turn } from "@/lib/transcript";
import { diffLines } from "@/lib/diff";

/** One file a turn changed, and by how many lines, over all of the turn's edits to it. */
export interface TurnFileChange {
  path: string;
  kind: FileEdit["kind"];
  added: number;
  removed: number;
}

/** Lines one edit adds and removes: a line diff of its two texts, or its patch's own +/- lines. */
export function editLineCounts(edit: Pick<FileEdit, "oldText" | "newText" | "unified">): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (edit.oldText == null && edit.newText == null && edit.unified) {
    for (const line of edit.unified.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
    return { added, removed };
  }
  for (const line of diffLines(edit.oldText ?? "", edit.newText ?? "")) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}

/**
 * The files a turn's tool calls changed, in the order it first touched them.
 * A file created and then edited stays "create"; one deleted in the end is "delete".
 */
export function turnFileChanges(turn: Turn): TurnFileChange[] {
  const byPath = new Map<string, TurnFileChange>();
  for (const item of turn.work) {
    const calls = item.kind === "tool" ? [item.call] : item.kind === "tool_group" ? item.calls : [];
    for (const call of calls) {
      if (call.result?.isError) continue;
      for (const edit of call.edits ?? []) {
        const { added, removed } = editLineCounts(edit);
        const seen = byPath.get(edit.path);
        if (!seen) {
          byPath.set(edit.path, { path: edit.path, kind: edit.kind, added, removed });
          continue;
        }
        seen.added += added;
        seen.removed += removed;
        if (edit.kind === "delete" || (edit.kind !== "update" && seen.kind === "update")) seen.kind = edit.kind;
      }
    }
  }
  return [...byPath.values()];
}
