import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MessageSquarePlus } from "@/icons";
import { useAccount } from "@/lib/account";
import { api } from "@/lib/api";
import { addReviewsToChat, onReviewsChanged, orderedComments, reviewComments, reviewLocation, reviewVersion, reviewDraft, type ReviewAction, type ReviewAnchor, type ReviewComment } from "@/lib/reviewComments";
import { threadInitials } from "@/lib/reviewThreads";
import type { GitSource } from "@/lib/gitSource";
import { GitHubThreadComment } from "./ReviewThreads";

interface Draft {
  anchor: ReviewAnchor; note: string; original: ReviewComment | null; opener?: HTMLElement; owner: string;
  /** Set while the draft's card asks whether to discard what was written (PRO-392); called with the answer. */
  asking?: (discard: boolean) => void;
}
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
/** The id the draft is drawn under, as a line comment of the diff that shows its line. */
export const REVIEW_DRAFT_ID = "review-draft";
interface ReviewContext {
  comments: ReviewComment[];
  /** Comments not yet sent to the agent, for "Add all N comments". */
  unsent: ReviewComment[];
  draft: Draft | null;
  /** This panel holds the draft: a diff of it draws the draft under its line. */
  ownsDraft: boolean;
  /** A diff that draws the draft inline says so while it does, so it is not drawn above the diff as well. */
  placeDraft(): () => void;
  setNote(note: string): void;
  save(): void;
  cancel(): void;
  start(anchor: ReviewAnchor, original?: ReviewComment): void;
  remove(comment: ReviewComment): void;
  add(comments: ReviewComment[]): void;
  busy: boolean;
  canAdd: boolean;
  refresh(): void;
}
const Context = createContext<ReviewContext | null>(null);
export const useReviewComments = () => useContext(Context);

/** "line 4", "lines 3–5", with "(before)" for a removed line. */
export function reviewLines(anchor: Pick<ReviewAnchor, "startLine" | "endLine" | "side">): string {
  const lines = anchor.startLine === anchor.endLine ? `line ${anchor.endLine}` : `lines ${anchor.startLine}–${anchor.endLine}`;
  return anchor.side === "before" ? `${lines} (before)` : lines;
}

export function ReviewCommentsProvider({ source, tabId, active = true, onAdd, chrome = true, children }: {
  source: GitSource; tabId?: string | null; active?: boolean; onAdd?: () => void;
  /** The Changes panel's header (count, Add all, every comment). The review tab draws none of it (PRO-392). */
  chrome?: boolean;
  children: ReactNode;
}) {
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
  const [placed, setPlaced] = useState(0);
  const placeDraft = useCallback(() => { setPlaced((n) => n + 1); return () => setPlaced((n) => n - 1); }, []);
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
  /**
   * Run `then` once the draft may go: at once when nothing was written, else after its card's
   * in-app "Discard this comment?" (PRO-392) says Discard. The draft moves to this panel to ask:
   * the one that held it may be a hidden tab, where the question would never be seen.
   */
  const whenDiscarded = (then: () => void) => {
    const held = drafts.get(source.key);
    if (!held || held.note === (held.original?.note ?? "")) { then(); return; }
    held.asking?.(false);
    const asking = (discard: boolean) => {
      const now = drafts.get(source.key);
      if (now?.asking === asking) { drafts.set(source.key, { ...now, asking: undefined }); draftChanged(); }
      if (discard) then();
    };
    drafts.set(source.key, { ...held, asking, owner });
    draftChanged();
  };
  const add = (items: ReviewComment[]) => {
    if (!tabId) return;
    addReviewsToChat(source.key, tabId, items);
    setNotice(reviewDraft(items).length > 32000 ? "Added a large batch to the chat draft. Review and shorten it in the composer before sending." : "Added to the chat draft. Edit it in the composer before sending.");
    onAdd?.();
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLTextAreaElement>("[data-composer]")].find((el) => el.getClientRects().length)?.focus({ preventScroll: true }));
  };
  const unsent = comments.filter((c) => !c.sent);
  const ownsDraft = draft?.owner === owner;
  const value: ReviewContext = {
    comments, unsent, draft, ownsDraft, placeDraft, refresh, canAdd: !!tabId, busy: busy || !ready,
    setNote: (note) => { const held = drafts.get(source.key); if (held) setDraft({ ...held, note }); },
    save: () => {
      const held = drafts.get(source.key);
      if (!held || !held.note.trim()) return;
      void run({ type: "save", anchor: held.anchor, note: held.note, expected: held.original }, () => clearDraft(held));
    },
    cancel: () => { if (!writing.current) whenDiscarded(() => clearDraft(drafts.get(source.key) ?? null)); },
    start: (anchor, original) => {
      if (writing.current) return;
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      whenDiscarded(() => { setDraft({ anchor, note: original?.note ?? "", original: original ?? null, owner, opener }); setNotice(null); });
    },
    remove: (comment) => {
      const del = () => void run({ type: "delete", expected: comment }, () => { const held = drafts.get(source.key); if (held?.original?.id === comment.id) clearDraft(held); });
      if (draft?.original?.id === comment.id) whenDiscarded(del); else del();
    },
    add,
  };
  // The draft goes under its line. Only when no diff here shows that line is it drawn above them, so it is never lost;
  // that waits a moment for the diff to place it first (its editor may be rebuilt to draw it), so it does not flash.
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (!ownsDraft || placed > 0) { setFallback(false); return; }
    const timer = window.setTimeout(() => setFallback(true), 120);
    return () => window.clearTimeout(timer);
  }, [ownsDraft, placed, draft?.anchor]);
  const header = (chrome && comments.length > 0) || error || notice || (ownsDraft && fallback);
  return <Context.Provider value={value}>
    <div ref={container} className="flex h-full min-h-0 flex-col">
      {/* No bar at all until there is something to say: an empty "0 review comments" would take the top of Changes. */}
      {header && <div className="shrink-0 border-b border-hairline px-3 py-2 text-xs">
        {chrome && comments.length > 0 && <div className="flex items-center gap-2">
          <span>{comments.length} review {comments.length === 1 ? "comment" : "comments"}</span>
          <Button className="ml-auto" size="sm" variant="secondary" disabled={!tabId || !unsent.length || busy} onClick={() => add(unsent)}>Add all to chat{unsent.length ? ` (${unsent.length})` : ""}</Button>
        </div>}
        {error && <div role="alert" className="mt-1 text-destructive first:mt-0">Review comments: {error} <button type="button" onClick={() => { setError(null); void load(); }}>Retry</button></div>}
        {notice && <p role="status" className="mt-1 text-muted-foreground">{notice}</p>}
        {ownsDraft && fallback && <div className="mt-2"><ReviewDraftCard /></div>}
        {chrome && !!comments.length && <details className="mt-1" onToggle={(e) => setShowAll(e.currentTarget.open)}><summary className="cursor-pointer text-muted-foreground">All review comments</summary><div className="max-h-64 overflow-auto">{showAll && comments.map((c) => <ReviewCommentCard key={c.id} comment={c} />)}</div></details>}
      </div>}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  </Context.Provider>;
}

function Avatar({ name, tone = "accent" }: { name: string; tone?: "accent" | "info" }) {
  return <span aria-hidden className={`grid size-5 shrink-0 place-items-center rounded-full text-[9.5px] font-semibold ${tone === "accent" ? "bg-accent/15 text-accent" : "bg-info/15 text-info"}`}>{threadInitials(name)}</span>;
}

// Signed out, a comment's author is the person Git knows: read once, for every card.
let gitName: Promise<string | null> | null = null;
function useYou(): string {
  const identity = useAccount().status.identity;
  const signedIn = identity?.name?.trim() || identity?.email;
  const [git, setGit] = useState<string | null>(null);
  useEffect(() => {
    if (signedIn) return;
    let alive = true;
    gitName ??= Promise.resolve().then(() => api.gitIdentity()).then((id) => id?.name?.trim() || null, () => null);
    void gitName.then((name) => { if (alive) setGit(name); });
    return () => { alive = false; };
  }, [signedIn]);
  return signedIn || git || "You";
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd aria-hidden className="ml-0.5 rounded border border-current/25 px-1 font-mono text-[10px] leading-4 opacity-70">{children}</kbd>;
}

/**
 * The comment being written (PRO-392, designs 05.01 and 05.13), under its line: who writes it and on which line,
 * the note, "Draft · not saved", Cancel (esc) and Comment (⌘↵). Discarding what was written asks in the card.
 */
export function ReviewDraftCard({ inline = false }: { inline?: boolean }) {
  const review = useReviewComments();
  const you = useYou();
  const text = useRef<HTMLTextAreaElement>(null);
  const asking = review?.draft?.asking;
  const wasAsking = useRef(false);
  useEffect(() => {
    // Keep editing puts the caret back in the note.
    if (wasAsking.current && !asking) text.current?.focus({ preventScroll: true });
    wasAsking.current = !!asking;
  }, [asking]);
  if (!review?.draft) return null;
  const d = review.draft;
  const lines = reviewLines(d.anchor);
  return <form aria-label="Review comment draft" className={`relative min-w-0 rounded-lg border border-mention/50 bg-card font-sans text-xs whitespace-normal ${inline ? "mx-2 my-1.5 max-w-3xl" : ""}`}
    onKeyDown={(e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (asking) asking(false); else if (!review.busy) review.cancel(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); if (!review.busy) review.save(); }
    }}
    onSubmit={(e) => { e.preventDefault(); review.save(); }}>
    <div className="flex h-8 min-w-0 items-center gap-2 border-b border-hairline px-3">
      <Avatar name={you} />
      <span className="shrink-0 font-medium text-foreground">{you}</span>
      {inline ? <span className="min-w-0 truncate text-faint">{lines} · comment for the agent</span>
        : <span className="min-w-0 truncate font-mono text-faint">{reviewLocation(d.anchor)} ({reviewVersion(d.anchor)})</span>}
    </div>
    <textarea ref={text} autoFocus aria-label="Review comment" className="block min-h-16 w-full resize-y bg-transparent px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-faint"
      value={d.note} disabled={review.busy} onChange={(e) => review.setNote(e.target.value)} placeholder="What should the agent change?" />
    <div className="flex items-center gap-2 px-3 pb-2.5">
      <span className="text-[11.5px] text-faint">{d.original ? "Editing · not saved" : "Draft · not saved"}</span>
      <Button className="ml-auto" type="button" size="sm" variant="outline" aria-keyshortcuts="Escape" disabled={review.busy} onClick={() => review.cancel()}>Cancel<Kbd>esc</Kbd></Button>
      <Button type="submit" size="sm" aria-keyshortcuts="Meta+Enter" disabled={review.busy || !d.note.trim()}>Comment<Kbd>⌘↵</Kbd></Button>
    </div>
    {asking && <div role="alertdialog" aria-modal="false" aria-labelledby="review-discard-title" aria-describedby="review-discard-detail"
      className="absolute right-4 top-full z-30 mt-1.5 w-[300px] max-w-[calc(100%-2rem)] rounded-lg border border-hairline bg-popover p-3.5 shadow-lg">
      <div id="review-discard-title" className="text-[13px] font-medium text-foreground">Discard this comment?</div>
      <p id="review-discard-detail" className="mt-0.5 text-xs text-muted-foreground">What you wrote on {lines} will be lost. It hasn't been sent to the agent.</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" autoFocus onClick={() => asking(false)}>Keep editing</Button>
        <Button type="button" size="sm" className="bg-destructive font-semibold text-white hover:opacity-90" onClick={() => asking(true)}>Discard</Button>
      </div>
    </div>}
  </form>;
}

/** One line comment in a diff. A GitHub review thread (author kind "github") draws as its thread, with its actions. */
export function ReviewCommentCard({ comment: c, workspace }: { comment: ReviewComment; workspace?: string }) {
  const review = useReviewComments();
  const you = useYou();
  if (c.author?.kind === "github") return <div className="mx-2 my-1.5 min-w-0 max-w-3xl"><GitHubThreadComment workspace={workspace} threadId={String(c.author.threadId ?? "")} /></div>;
  if (!review) return null;
  const name = c.author?.kind === "agent" ? c.author.name ?? "Reviewer agent" : c.author?.name ?? you;
  const others = review.unsent.length;
  return <article className="mx-2 my-1.5 min-w-0 max-w-3xl rounded-lg border border-hairline bg-card font-sans text-xs whitespace-normal [overflow-wrap:anywhere]" aria-label={`Comment on ${reviewLocation(c)}`}>
    <div className="flex h-8 min-w-0 items-center gap-2 border-b border-hairline px-3">
      <Avatar name={name} tone={c.author?.kind === "agent" ? "info" : "accent"} />
      <span className="shrink-0 font-medium text-foreground">{name}</span>
      <span className="min-w-0 truncate text-faint">on {reviewLines(c)}</span>
      <span className="ml-auto flex shrink-0 gap-1 text-[11px]">
        {c.outdated && <span className="rounded bg-warning/15 px-1.5 text-warning">Outdated</span>}
        {c.sent ? <span className="rounded bg-add/15 px-1.5 text-add">Sent</span> : <span className="rounded bg-mention/15 px-1.5 text-mention">Draft</span>}
      </span>
    </div>
    <p className="whitespace-pre-wrap break-words px-3 py-2 text-[13px] text-foreground">{c.note}</p>
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5">
      <Button size="sm" disabled={!review.canAdd} onClick={() => review.add([c])}><MessageSquarePlus />Add to chat</Button>
      {others > 1 && <Button size="sm" variant="outline" disabled={!review.canAdd || review.busy} onClick={() => review.add(review.unsent)}>Add all {others} comments</Button>}
      <span className="ml-auto flex items-center gap-1 text-faint">
        <button type="button" className="hover:text-foreground disabled:opacity-50" disabled={review.busy} onClick={() => review.start(c, c)}>Edit</button>
        <span aria-hidden>·</span>
        <button type="button" className="hover:text-foreground disabled:opacity-50" disabled={review.busy} onClick={() => review.remove(c)}>Delete</button>
      </span>
    </div>
  </article>;
}
