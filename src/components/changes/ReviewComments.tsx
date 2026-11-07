import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { addReviewsToChat, onReviewsChanged, orderedComments, reviewComments, reviewLocation, type ReviewAction, type ReviewAnchor, type ReviewComment } from "@/lib/reviewComments";
import type { GitSource } from "@/lib/gitSource";

interface Draft { anchor: ReviewAnchor; note: string; original: ReviewComment | null }
// Switching files, scopes or sessions never discards a note being written.
const drafts = new Map<string, Draft>();
// Keep the warning even if a session switch unmounts the last Changes panel.
if (typeof window !== "undefined") window.addEventListener("beforeunload", (event) => {
  if ([...drafts.values()].some((d) => d.note !== (d.original?.note ?? ""))) { event.preventDefault(); event.returnValue = ""; }
});
interface ReviewContext {
  comments: ReviewComment[];
  draft: Draft | null;
  start(anchor: ReviewAnchor, original?: ReviewComment): void;
  remove(comment: ReviewComment): void;
  add(comments: ReviewComment[]): void;
  busy: boolean;
}
const Context = createContext<ReviewContext | null>(null);
export const useReviewComments = () => useContext(Context);

export function ReviewCommentsProvider({ source, tabId, active = true, children }: { source: GitSource; tabId: string; active?: boolean; children: ReactNode }) {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraftState] = useState<Draft | null>(() => drafts.get(source.key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const checking = useRef(false);
  const writing = useRef(false);
  const setDraft = (next: Draft | null) => {
    if (next) drafts.set(source.key, next); else drafts.delete(source.key);
    setDraftState(next);
  };
  const clearDraft = (expected: Draft | null) => {
    if (drafts.get(source.key) !== expected) return;
    drafts.delete(source.key);
    if (mounted.current) setDraftState(null);
  };
  const load = async () => {
    const request = ++generation.current;
    try {
      const next = await reviewComments(source.key, { type: "list" });
      if (!mounted.current || request !== generation.current) return;
      setComments(orderedComments(next)); setReady(true);
      // Compare to the live workspace, never to whichever historical scope happens to be open.
      // Read every noted path, including files that disappeared from the current diff.
      if (active && !checking.current && next.some((c) => !c.outdated)) {
        checking.current = true;
        try {
          const range = await source.reviewRange(null, false);
          const files = await source.changesBetween(range.base, range.head);
          let reconciled = next;
          for (const path of new Set(next.filter((c) => !c.outdated).map((c) => c.path))) {
            if (!mounted.current || request !== generation.current) break;
            const pair = await source.fileContentsAt(path, range.base, null);
            const oldPath = files.find((f) => f.path === path)?.oldPath;
            const before = oldPath ? (await source.fileContentsAt(oldPath, range.base, null)).before : pair.before;
            if (!mounted.current || request !== generation.current) break;
            const noted = next.filter((c) => c.path === path);
            // The old side is a specific Git tree, not necessarily the default merge base
            // (it may be HEAD, a custom target, or a historical commit's parent).
            const groups = new Map<string, ReviewComment[]>();
            for (const comment of noted) {
              const key = comment.side === "before" && comment.base ? JSON.stringify([comment.base, comment.originalPath ?? path]) : "live";
              groups.set(key, [...(groups.get(key) ?? []), comment]);
            }
            for (const [key, group] of groups) {
              const original = key === "live" ? before : (await source.fileContentsAt(group[0].originalPath ?? path, group[0].base!, null)).before;
              if (!mounted.current || request !== generation.current) break;
              reconciled = await reviewComments(source.key, { type: "reconcile", path, before: original, after: pair.after, comments: group });
            }
          }
          if (mounted.current && request === generation.current) setComments(orderedComments(reconciled));
        } finally { checking.current = false; }
      }
    } catch (e) { if (mounted.current && request === generation.current) setError(String(e)); }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => { if (!checking.current) void load(); };
    const off = onReviewsChanged(refresh);
    const timer = active ? window.setInterval(refresh, 4000) : undefined;
    window.addEventListener("focus", refresh);
    return () => { mounted.current = false; generation.current++; off(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [source.key, active]);
  const mutate = async (action: ReviewAction) => {
    generation.current++;
    await reviewComments(source.key, action);
    if (mounted.current) await load();
  };
  const run = async (action: ReviewAction, done?: () => void) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true); setError(null);
    try { await mutate(action); done?.(); }
    catch (e) { if (mounted.current) setError(String(e)); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  };
  const discard = () => !draft || draft.note === (draft.original?.note ?? "") || window.confirm("Discard this unsaved review comment?");
  const add = (items: ReviewComment[]) => {
    addReviewsToChat(source.key, tabId, items);
    setNotice("Added to the chat draft. Edit it in the composer before sending.");
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus({ preventScroll: true }));
  };
  const value: ReviewContext = {
    comments, draft, busy: busy || !ready,
    start: (anchor, original) => { if (!writing.current && discard()) { setDraft({ anchor, note: original?.note ?? "", original: original ?? null }); setNotice(null); } },
    remove: (comment) => { if (draft?.original?.id === comment.id && !discard()) return; void run({ type: "delete", expected: comment }, () => { if (draft?.original?.id === comment.id) clearDraft(draft); }); },
    add,
  };
  const unsent = comments.filter((c) => !c.sent);
  return <Context.Provider value={value}>
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-hairline px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span>{comments.length} review {comments.length === 1 ? "comment" : "comments"}</span>
          <Button className="ml-auto" size="sm" variant="secondary" disabled={!unsent.length || busy} onClick={() => add(unsent)}>Add all to chat{unsent.length ? ` (${unsent.length})` : ""}</Button>
        </div>
        {error && <div role="alert" className="mt-1 text-destructive">Review comments: {error} <button type="button" onClick={() => { setError(null); void load(); }}>Retry</button></div>}
        {notice && <p role="status" className="mt-1 text-muted-foreground">{notice}</p>}
        {draft && <form className="mt-2 space-y-2 rounded-lg border border-hairline bg-well p-2" onSubmit={(e) => {
          e.preventDefault();
          void run({ type: "save", anchor: draft.anchor, note: draft.note, expected: draft.original }, () => clearDraft(draft));
        }}>
          <div className="font-mono break-all">{reviewLocation(draft.anchor)} ({draft.anchor.side})</div>
          <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap border-l-2 border-hairline pl-2 font-mono text-faint">{draft.anchor.lineText}</blockquote>
          <textarea autoFocus aria-label="Review comment" className="min-h-20 w-full resize-y rounded bg-composer p-2 outline-none focus:ring-1 focus:ring-ring" value={draft.note} disabled={busy} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="What should the agent change?" />
          <div className="flex gap-2"><Button type="submit" size="sm" variant="accent" disabled={busy || !draft.note.trim()}>Save</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { if (discard()) setDraft(null); }}>Cancel</Button></div>
        </form>}
        {!!comments.length && <details className="mt-1" onToggle={(e) => setShowAll(e.currentTarget.open)}><summary className="cursor-pointer text-muted-foreground">All review comments</summary><div className="max-h-64 overflow-auto">{showAll && comments.map((c) => <ReviewCommentCard key={c.id} comment={c} />)}</div></details>}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  </Context.Provider>;
}

export function ReviewCommentCard({ comment: c }: { comment: ReviewComment }) {
  const review = useReviewComments();
  if (!review) return null;
  return <article className="m-1 min-w-0 rounded-md border border-hairline bg-card p-2 text-xs font-sans whitespace-normal [overflow-wrap:anywhere]" aria-label={`Comment on ${reviewLocation(c)}`}>
    <div className="flex flex-wrap gap-2"><span className="font-mono break-all">{reviewLocation(c)} ({c.side})</span>{c.sent && <span className="text-add">Sent</span>}{c.outdated && <span className="text-warning">Outdated</span>}</div>
    <blockquote className="my-1 max-h-32 overflow-auto whitespace-pre-wrap break-all border-l-2 border-hairline pl-2 font-mono text-faint">{c.lineText}</blockquote>
    <p className="whitespace-pre-wrap break-words">{c.note}</p>
    <div className="mt-1 flex flex-wrap gap-1">
      <Button size="sm" variant="ghost" onClick={() => review.add([c])}>Add to chat</Button>
      <Button size="sm" variant="ghost" disabled={review.busy} onClick={() => review.start(c, c)}>Edit</Button>
      <Button size="sm" variant="ghost" disabled={review.busy} onClick={() => review.remove(c)}>Delete</Button>
    </div>
  </article>;
}
