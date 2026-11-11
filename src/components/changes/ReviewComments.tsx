import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { addReviewsToChat, onReviewsChanged, orderedComments, reviewComments, reviewLocation, reviewVersion, reviewDraft, type ReviewAction, type ReviewAnchor, type ReviewComment } from "@/lib/reviewComments";
import type { GitSource } from "@/lib/gitSource";

interface Draft { anchor: ReviewAnchor; note: string; original: ReviewComment | null; opener?: HTMLElement; owner: string }
// Switching files, scopes or sessions never discards a note being written.
const drafts = new Map<string, Draft>();
const owners = new Set<string>();
const draftListeners = new Set<() => void>();
const subscribeDraft = (listener: () => void) => { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; };
const draftChanged = () => { for (const listener of draftListeners) listener(); };
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
  canAdd: boolean;
  refresh(): void;
}
const Context = createContext<ReviewContext | null>(null);
export const useReviewComments = () => useContext(Context);

export function ReviewCommentsProvider({ source, tabId, active = true, onAdd, children }: { source: GitSource; tabId?: string | null; active?: boolean; onAdd?: () => void; children: ReactNode }) {
  const owner = useId();
  useEffect(() => {
    owners.add(owner);
    return () => {
      owners.delete(owner);
      const d = drafts.get(source.key);
      if (d?.owner === owner) { drafts.set(source.key, { ...d, owner: "" }); draftChanged(); }
    };
  }, [owner, source.key]);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const draft = useSyncExternalStore(subscribeDraft, () => drafts.get(source.key) ?? null);
  useEffect(() => {
    const held = drafts.get(source.key);
    if (active && held && !owners.has(held.owner)) { drafts.set(source.key, { ...held, owner }); draftChanged(); }
  }, [active, draft, owner, source.key]);
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
    draftChanged();
  };
  const clearDraft = (expected: Draft | null) => {
    const held = drafts.get(source.key);
    // Ownership may move between panels while a save is in flight. Only a
    // content edit (not that handoff) should prevent clearing the saved draft.
    if (!held || !expected || held.anchor !== expected.anchor || held.note !== expected.note || held.original !== expected.original) return;
    drafts.delete(source.key);
    draftChanged();
    restoreFocus(expected);
  };
  const restoreFocus = (d: Draft | null) => requestAnimationFrame(() => {
    if (d?.opener?.isConnected) d.opener.focus({ preventScroll: true });
    else container.current?.querySelector<HTMLElement>(".cm-content")?.focus({ preventScroll: true });
  });
  const container = useRef<HTMLDivElement>(null);
  const load = async () => {
    const request = ++generation.current;
    try {
      const next = await reviewComments(source.key, { type: "list" });
      if (!mounted.current || request !== generation.current) return;
      setComments(orderedComments(next)); setReady(true);
      // Existing Changes refreshes drive these reads. No second Git polling loop,
      // reviewRange or changesBetween request is needed to resolve saved anchors.
      if (active && !checking.current && next.length) {
        checking.current = true;
        try {
          const groups = new Map<string, ReviewComment[]>();
          for (const comment of next) {
            if (!comment.base) continue;
            const key = JSON.stringify([comment.path, comment.base, comment.originalPath]);
            groups.set(key, [...(groups.get(key) ?? []), comment]);
          }
          let reconciled = next;
          for (const group of groups.values()) {
            if (!mounted.current || request !== generation.current) return;
            const c = group[0];
            const pair = await source.fileContentsAt(c.path, c.base!, null);
            const before = c.originalPath ? (await source.fileContentsAt(c.originalPath, c.base!, null)).before : pair.before;
            if (!mounted.current || request !== generation.current) return;
            // The preview sentinel is not file content and cannot invalidate an anchor.
            if (before === "<file too large to show>" || pair.after === "<file too large to show>") continue;
            reconciled = await reviewComments(source.key, { type: "reconcile", path: c.path, base: c.base!, before, after: pair.after, comments: group });
          }
          if (mounted.current && request === generation.current) setComments(orderedComments(reconciled));
        } finally { checking.current = false; }
      }
    } catch (e) { if (mounted.current && request === generation.current) setError(String(e)); }
  };
  const latestLoad = useRef(load);
  latestLoad.current = load;
  const refresh = useCallback(() => { if (!checking.current && !writing.current) void latestLoad.current(); }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const off = onReviewsChanged((workspace) => { if (!workspace || workspace === source.key) refresh(); });
    window.addEventListener("focus", refresh);
    return () => { mounted.current = false; generation.current++; off(); window.removeEventListener("focus", refresh); };
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
    if (!tabId) return;
    addReviewsToChat(source.key, tabId, items);
    setNotice(reviewDraft(items).length > 32000 ? "Added a large batch to the chat draft. Review and shorten it in the composer before sending." : "Added to the chat draft. Edit it in the composer before sending.");
    onAdd?.();
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLTextAreaElement>("[data-composer]")].find((el) => el.getClientRects().length)?.focus({ preventScroll: true }));
  };
  const value: ReviewContext = {
    comments, draft, refresh, canAdd: !!tabId, busy: busy || !ready,
    start: (anchor, original) => { if (!writing.current && discard()) { setDraft({ anchor, note: original?.note ?? "", original: original ?? null, owner, opener: document.activeElement instanceof HTMLElement ? document.activeElement : undefined }); setNotice(null); } },
    remove: (comment) => { if (draft?.original?.id === comment.id && !discard()) return; void run({ type: "delete", expected: comment }, () => { if (draft?.original?.id === comment.id) clearDraft(draft); }); },
    add,
  };
  const unsent = comments.filter((c) => !c.sent);
  return <Context.Provider value={value}>
    <div ref={container} className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-hairline px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span>{comments.length} review {comments.length === 1 ? "comment" : "comments"}</span>
          <Button className="ml-auto" size="sm" variant="secondary" disabled={!tabId || !unsent.length || busy} onClick={() => add(unsent)}>Add all to chat{unsent.length ? ` (${unsent.length})` : ""}</Button>
        </div>
        {error && <div role="alert" className="mt-1 text-destructive">Review comments: {error} <button type="button" onClick={() => { setError(null); void load(); }}>Retry</button></div>}
        {notice && <p role="status" className="mt-1 text-muted-foreground">{notice}</p>}
        {draft?.owner === owner && <form onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!busy && discard()) clearDraft(draft); } }} className="mt-2 space-y-2 rounded-lg border border-hairline bg-well p-2" onSubmit={(e) => {
          e.preventDefault();
          void run({ type: "save", anchor: draft.anchor, note: draft.note, expected: draft.original }, () => clearDraft(draft));
        }}>
          <div className="font-mono break-all">{reviewLocation(draft.anchor)} ({reviewVersion(draft.anchor)})</div>
          <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap border-l-2 border-hairline pl-2 font-mono text-faint">{draft.anchor.lineText}</blockquote>
          <textarea autoFocus aria-label="Review comment" className="min-h-20 w-full resize-y rounded bg-composer p-2 outline-none focus:ring-1 focus:ring-ring" value={draft.note} disabled={busy} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="What should the agent change?" />
          <div className="flex gap-2"><Button type="submit" size="sm" variant="accent" disabled={busy || !draft.note.trim()}>Save</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { if (discard()) clearDraft(draft); }}>Cancel</Button></div>
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
    <div className="flex flex-wrap gap-2"><span className="font-mono break-all">{reviewLocation(c)} ({reviewVersion(c)})</span>{c.author?.kind === "agent" && <span>{c.author.name ?? "Reviewer agent"}</span>}{c.author?.kind === "github" && <span>GitHub{c.author.login ? ` · ${c.author.login}` : ""}</span>}{c.sent && <span className="text-add">Sent</span>}{c.outdated && <span className="text-warning">Outdated</span>}</div>
    <blockquote className="my-1 max-h-32 overflow-auto whitespace-pre-wrap break-all border-l-2 border-hairline pl-2 font-mono text-faint">{c.lineText}</blockquote>
    <p className="whitespace-pre-wrap break-words">{c.note}</p>
    <div className="mt-1 flex flex-wrap gap-1">
      <Button size="sm" variant="ghost" disabled={!review.canAdd} onClick={() => review.add([c])}>Add to chat</Button>
      <Button size="sm" variant="ghost" disabled={review.busy} onClick={() => review.start(c, c)}>Edit</Button>
      <Button size="sm" variant="ghost" disabled={review.busy} onClick={() => review.remove(c)}>Delete</Button>
    </div>
  </article>;
}
