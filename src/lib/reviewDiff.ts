import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { ReviewAnchor, ReviewSide } from "./reviewComments";

export const normalizeReviewText = (text: string): string => text.replace(/\r\n?/g, "\n");

export interface ReviewLine { before?: number; after?: number; text: string; kind: "same" | "before" | "after"; changes?: { from: number; to: number }[] }

/** A unified document with real selectable deleted lines and both source line numbers. */
export function unifiedReviewLines(before: string, after: string): ReviewLine[] {
  const a = Text.of(normalizeReviewText(before).split("\n")), b = Text.of(normalizeReviewText(after).split("\n"));
  const lines: ReviewLine[] = [];
  let ai = 1, bi = 1;
  for (const chunk of Chunk.build(a, b)) {
    const startA = a.lineAt(Math.min(chunk.fromA, a.length)).number;
    const startB = b.lineAt(Math.min(chunk.fromB, b.length)).number;
    while (ai < startA && bi < startB) {
      lines.push({ before: ai++, after: bi, text: b.line(bi++).text, kind: "same" });
    }
    while (ai <= a.lines && a.line(ai).from < chunk.toA) {
      const line = a.line(ai++);
      const changes = chunk.changes.flatMap((c) => {
        const from = Math.max(line.from, chunk.fromA + c.fromA), to = Math.min(line.to, chunk.fromA + c.toA);
        return from < to ? [{ from: from - line.from, to: to - line.from }] : [];
      });
      lines.push({ before: line.number, text: line.text, kind: "before", changes });
    }
    while (bi <= b.lines && b.line(bi).from < chunk.toB) {
      const line = b.line(bi++);
      const changes = chunk.changes.flatMap((c) => {
        const from = Math.max(line.from, chunk.fromB + c.fromB), to = Math.min(line.to, chunk.fromB + c.toB);
        return from < to ? [{ from: from - line.from, to: to - line.from }] : [];
      });
      lines.push({ after: line.number, text: line.text, kind: "after", changes });
    }
  }
  while (bi <= b.lines) lines.push({ before: ai <= a.lines ? ai++ : undefined, after: bi, text: b.line(bi++).text, kind: "same" });
  return lines.length ? lines : [{ text: "", kind: "same" }];
}

export function reviewSelection(path: string, lines: ReviewLine[], from: number, to: number, preferred?: ReviewSide): ReviewAnchor | null {
  const selected = lines.slice(Math.min(from, to) - 1, Math.max(from, to));
  const side = preferred ?? (selected.every((l) => l.after != null) ? "after" : "before");
  if (!selected.length || selected.some((l) => l[side] == null)) return null;
  const startLine = selected[0][side]!;
  const endLine = selected[selected.length - 1][side]!;
  if (endLine - startLine + 1 !== selected.length) return null;
  return { path, side, startLine, endLine, lineText: selected.map((l) => l.text).join("\n") };
}
