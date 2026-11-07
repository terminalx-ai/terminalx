import { invoke } from "@/lib/api";
import { getDraft, setDraft, subscribeDrafts } from "@/lib/drafts";

export type ReviewSide = "before" | "after";
export interface ReviewAnchor { path: string; side: ReviewSide; startLine: number; endLine: number; lineText: string; base?: string; originalPath?: string }
export interface ReviewComment extends ReviewAnchor { id: string; revision: number; note: string; sent: boolean; outdated: boolean }
export interface ReviewRevision { id: string; revision: number }
export type ReviewAction = { type: "list" }
  | { type: "save"; anchor: ReviewAnchor; note: string; expected: ReviewRevision | null }
  | { type: "delete"; expected: ReviewRevision }
  | { type: "sent"; comments: ReviewRevision[] }
  | { type: "reconcile"; path: string; before: string | null; after: string | null; comments: ReviewRevision[] };

export function reviewComments(workspace: string, action: ReviewAction): Promise<ReviewComment[]> {
  return invoke("review_comments", { workspace, action });
}
export function reviewLocation(c: ReviewAnchor): string {
  return `${c.path}:${c.startLine}${c.endLine === c.startLine ? "" : `-${c.endLine}`}`;
}
export function reviewEntry(c: ReviewComment): string {
  return `${reviewLocation(c)} (${c.side}${c.outdated ? ", outdated" : ""})\n${c.lineText.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${c.note}`;
}
export function orderedComments(comments: ReviewComment[]): ReviewComment[] {
  return [...comments].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || a.startLine - b.startLine || a.endLine - b.endLine || a.side.localeCompare(b.side) || a.id.localeCompare(b.id));
}
export function reviewDraft(comments: ReviewComment[]): string {
  return orderedComments(comments.filter((c) => !c.sent)).map(reviewEntry).join("\n\n");
}

export interface DraftReview extends ReviewRevision { workspace: string; from: number; to: number; location?: string }
const pending = new Map<string, { text: string; entries: DraftReview[] }>();

/** Follow a text edit so editing a note keeps its receipt, while removing it does not. */
export function moveReviewRanges(before: string, after: string, entries: DraftReview[]): DraftReview[] {
  if (before === after) return entries;
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = newEnd - oldEnd;
  return entries.flatMap((entry) => {
    if (oldEnd <= entry.from) return [{ ...entry, from: entry.from + delta, to: entry.to + delta }];
    if (from >= entry.to) return [entry];
    // A whole removed/replaced entry is no longer this comment. Edits within it are still its draft.
    if (from <= entry.from && oldEnd >= entry.to) return [];
    return [{ ...entry, from: Math.min(entry.from, from), to: Math.max(newEnd, entry.to + delta) }];
  });
}
subscribeDrafts((tabId, text) => {
  const held = pending.get(tabId);
  if (!held) return;
  const entries = moveReviewRanges(held.text, text, held.entries);
  if (entries.length) pending.set(tabId, { text, entries });
  else pending.delete(tabId);
});

export function addReviewsToChat(workspace: string, tabId: string, comments: ReviewComment[]) {
  let text = getDraft(tabId);
  const held = pending.get(tabId);
  const entries = held ? moveReviewRanges(held.text, text, held.entries) : [];
  for (const comment of orderedComments(comments)) {
    if (entries.some((e) => e.workspace === workspace && e.id === comment.id && e.revision === comment.revision)) continue;
    text += text.trim() ? "\n\n" : "";
    const from = text.length;
    text += reviewEntry(comment);
    entries.push({ workspace, id: comment.id, revision: comment.revision, from, to: text.length, location: `${reviewLocation(comment)} (${comment.side}` });
  }
  setDraft(tabId, text);
  pending.set(tabId, { text, entries });
}

/** Capture before the composer clears the draft; failure leaves comments unsent. */
export function captureReviewSend(tabId: string, text: string): DraftReview[] {
  const held = pending.get(tabId);
  if (!held) return [];
  // Send trims the composer in one operation. Treat its two boundary edits
  // separately, otherwise their common replacement span would swallow every note.
  const leading = held.text.length - held.text.trimStart().length;
  const entries = held.text.trim() === text
    ? held.entries.map((e) => ({ ...e, from: Math.max(0, e.from - leading), to: Math.min(text.length, e.to - leading) }))
    : moveReviewRanges(held.text, text, held.entries);
  return entries.filter((e) => {
    const entry = text.slice(e.from, e.to);
    return !e.location || entry.startsWith(e.location) || entry.includes(`\n${e.location}`);
  });
}
const listeners = new Set<() => void>();
export function onReviewsChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export async function markReviewsSent(entries: DraftReview[]): Promise<void> {
  for (const workspace of new Set(entries.map((e) => e.workspace))) {
    await reviewComments(workspace, { type: "sent", comments: entries.filter((e) => e.workspace === workspace).map(({ id, revision }) => ({ id, revision })) });
  }
  for (const listener of listeners) listener();
}
export function restoreReviewSend(tabId: string, text: string, entries: DraftReview[]) {
  const draft = getDraft(tabId);
  const offset = draft.indexOf(text);
  if (offset < 0 || !entries.length) return;
  const existing = pending.get(tabId)?.entries ?? [];
  pending.set(tabId, { text: draft, entries: [...existing, ...entries.map((e) => ({ ...e, from: e.from + offset, to: e.to + offset }))] });
}
