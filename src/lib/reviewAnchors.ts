import type { ReviewAnchor } from "./reviewComments";

export const normalizeReviewText = (text: string) => text.replace(/\r\n?/g, "\n");

/** Same relocation rule as store/review_comments.rs: never guess between duplicates. */
export function locateReview(anchor: ReviewAnchor, content: string | null): { outdated: boolean; startLine?: number; endLine?: number } {
  if (content === null) return { outdated: true };
  const lines = normalizeReviewText(content).split("\n"), quote = anchor.lineText.split("\n");
  const left = anchor.contextBefore ?? [], right = anchor.contextAfter ?? [];
  // Linear-time matching matters for large selections of repeated/blank lines.
  const fallback = new Array<number>(quote.length).fill(0);
  for (let i = 1, matched = 0; i < quote.length; i++) {
    while (matched && quote[i] !== quote[matched]) matched = fallback[matched - 1];
    if (quote[i] === quote[matched]) matched++;
    fallback[i] = matched;
  }
  let candidates = 0, contextual = 0, candidate = 0, context = 0, matched = 0;
  for (let i = 0; i < lines.length; i++) {
    while (matched && lines[i] !== quote[matched]) matched = fallback[matched - 1];
    if (lines[i] === quote[matched]) matched++;
    if (matched !== quote.length) continue;
    const start = i + 1 - quote.length;
    candidates++; candidate = start + 1;
    if (start >= left.length && i + 1 + right.length <= lines.length
      && left.every((line, n) => lines[start - left.length + n] === line)
      && right.every((line, n) => lines[i + 1 + n] === line)) { contextual++; context = start + 1; }
    matched = fallback[matched - 1];
  }
  const startLine = contextual === 1 ? context : candidates === 1 ? candidate : undefined;
  return { outdated: candidates === 0, startLine, endLine: startLine === undefined ? undefined : startLine + quote.length - 1 };
}

export function anchorReview(path: string, base: string, side: ReviewAnchor["side"], text: string, from: number, to: number, originalPath?: string): ReviewAnchor {
  const lines = normalizeReviewText(text).split("\n");
  const startLine = Math.max(1, Math.min(from, to)), endLine = Math.min(lines.length, Math.max(from, to));
  return { path, base, side, originalPath, startLine, endLine, lineText: lines.slice(startLine - 1, endLine).join("\n"),
    contextBefore: lines.slice(Math.max(0, startLine - 4), startLine - 1), contextAfter: lines.slice(endLine, endLine + 3) };
}

/** Old unanchored notes remain in the inventory but must never attach by line number. */
export function reviewInDiff(anchor: ReviewAnchor, path: string, base: string | undefined, originalPath?: string) {
  return !!base && anchor.base === base && anchor.path === path && (anchor.originalPath ?? path) === (originalPath ?? path);
}
