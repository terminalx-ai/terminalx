import { createPortal } from "react-dom";
import { diffComments } from "./diffComments";
import { REVIEW_DRAFT_ID, ReviewCommentCard, ReviewDraftCard, useReviewComments } from "./ReviewComments";
import { GitHubThreadComment } from "./ReviewThreads";
import { clearThreadFocus, githubThreadComment, githubThreadCommentId, useReviewPr, useThreadFocus } from "@/lib/reviewThreads";
import { locateReview, reviewInDiff } from "@/lib/reviewAnchors";
import type { ReviewAnchor, ReviewComment } from "@/lib/reviewComments";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { whitespaceDiff } from "@/lib/diffOptions";
import { diffPhrases, languageFor, raccoonHighlight, raccoonTheme } from "@/lib/codemirror";

/**
 * A whole-file diff. Unified draws one column with deletions inline; split
 * draws before and after side by side. Both are CodeMirror merge views, so
 * they highlight, collapse unchanged regions and never freeze the page on a
 * large file.
 */
export function DiffPane({ path, before, after, mode, base, originalPath, workspace, wrap = true, hideWhitespace = false, stacked = false }: {
  base?: string; originalPath?: string; workspace?: string; wrap?: boolean; hideWhitespace?: boolean; path: string; before: string; after: string; mode: "unified" | "split" | "entire";
  /** One of a review tab's stacked files (PRO-392): as tall as its lines, scrolled with the tab. */
  stacked?: boolean;
}) {
  const review = useReviewComments();
  const latest = useRef(review); latest.current = review;
  const controller = useRef<ReturnType<typeof diffComments> | null>(null);
  const [mounts, setMounts] = useState(new Map<string, HTMLElement>());
  const [selection, setSelection] = useState<ReviewAnchor | null>(null);
  // GitHub review threads (PRO-234) are line comments of this diff too, anchored by the code they were left on.
  const threads = useReviewPr(workspace)?.snapshot?.threads;
  const fileThreads = useMemo(() => (threads ?? []).filter((t) => t.path === path || (!!originalPath && t.path === originalPath)), [threads, path, originalPath]);
  const github = useMemo(() => base ? fileThreads.flatMap((t) => githubThreadComment(t, { path, base, originalPath }) ?? []) : [], [fileThreads, path, base, originalPath]);
  // The comment being written is drawn under its line too (PRO-392), in place of the comment it edits.
  const draft = review?.ownsDraft ? review.draft : null;
  const draftAnchor = draft?.anchor, editing = draft?.original?.id;
  const draftComment = useMemo<ReviewComment | null>(() => draftAnchor ? { ...draftAnchor, id: REVIEW_DRAFT_ID, revision: 0, note: "", sent: false, outdated: false } : null, [draftAnchor]);
  const all = useMemo(() => [...(review?.comments ?? []).filter((c) => !draftComment || c.id !== editing), ...github, ...(draftComment ? [draftComment] : [])], [review?.comments, github, draftComment, editing]);
  const allComments = useRef(all); allComments.current = all;
  const enabled = !!base && (!!review || github.length > 0);
  const commentable = enabled && !!review;
  const attached = useMemo(() => all.filter((c) => reviewInDiff(c, path, base, originalPath)).flatMap((c) => {
    const position = locateReview(c, c.side === "before" ? before : after);
    return position.endLine === undefined ? [] : [{ ...c, ...position, startLine: position.startLine!, endLine: position.endLine }];
  }), [all, path, base, originalPath, before, after]);
  // As before (main): outdated threads, and those whose code is gone or ambiguous, are listed under the diff.
  const unplaced = useMemo(() => fileThreads.filter((t) => !attached.some((c) => c.id === githubThreadCommentId(t.id))), [fileThreads, attached]);
  const unplacedList = useRef<HTMLElement>(null);
  const focus = useThreadFocus(workspace);
  useEffect(() => {
    if (!focus) return;
    const inline = mounts.get(githubThreadCommentId(focus.threadId))?.querySelector<HTMLElement>("[data-review-thread]");
    const listed = [...(unplacedList.current?.querySelectorAll<HTMLElement>("[data-review-thread]") ?? [])].find((el) => el.dataset.reviewThread === focus.threadId);
    const target = inline ?? listed;
    if (!target) return;
    target.scrollIntoView?.({ block: "center" });
    target.focus({ preventScroll: true });
    clearThreadFocus(focus.nonce);
  }, [focus, mounts, unplaced]);
  const commentsKey = JSON.stringify(attached);
  const host = useRef<HTMLDivElement>(null);
  const scroll = useRef({ top: 0, left: 0, outerTop: 0, outerLeft: 0 });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    // Always drawn, for the gutter's line numbers and +/− markers; comments only where they can be made or shown.
    const comments = diffComments({ path, base: base ?? "", originalPath, before, after, commentable,
      comments: () => allComments.current,
      start: (anchor) => { if (!latest.current?.busy) latest.current?.start(anchor); },
      selection: setSelection,
      mount: (id, element, old) => queueMicrotask(() => {
        if (!alive) return;
        setMounts((was) => { const next = new Map(was); if (element) next.set(id, element); else if (next.get(id) === old) next.delete(id); return next; });
      }),
    });
    controller.current = comments;
    const common = [raccoonTheme, diffPhrases, raccoonHighlight, languageFor(path), EditorView.editable.of(false), EditorState.readOnly.of(true), lineNumbers(), ...(wrap ? [EditorView.lineWrapping] : [])];
    let dispose: () => void;
    let scroller: HTMLElement;
    if (mode === "split") {
      const a = comments?.extensions("before"), b = comments?.extensions("after");
      const mv = new MergeView({
        a: { doc: before, extensions: [...common, ...(a?.extensions ?? [])] },
        b: { doc: after, extensions: [...common, ...(b?.extensions ?? [])] },
        parent: el,
        collapseUnchanged: { margin: 3, minSize: 4 },
        diffConfig: hideWhitespace ? { override: whitespaceDiff } : undefined,
        highlightChanges: false,
        gutter: true,
      });
      a?.attach(mv.a); b?.attach(mv.b);
      scroller = mv.b.scrollDOM;
      dispose = () => mv.destroy();
    } else {
      const b = comments?.extensions("after", mode === "unified");
      const view = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: after,
          extensions: [
            ...common, ...(b?.extensions ?? []),
            ...(mode === "entire" ? [] : [unifiedMergeView({ original: before, diffConfig: hideWhitespace ? { override: whitespaceDiff } : undefined, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 }, highlightChanges: false })]),
          ],
        }),
      });
      b?.attach(view);
      scroller = view.scrollDOM;
      dispose = () => view.destroy();
    }
    comments?.update(); setSelection(null);
    const frame = requestAnimationFrame(() => {
      el.scrollTop = scroll.current.outerTop;
      el.scrollLeft = scroll.current.outerLeft;
      if (scroll.current.top || scroll.current.left) { scroller.scrollTop = scroll.current.top; scroller.scrollLeft = scroll.current.left; }
    });
    return () => {
      alive = false; comments?.destroy(); controller.current = null; setMounts(new Map());
      cancelAnimationFrame(frame);
      scroll.current = { top: scroller.scrollTop, left: scroller.scrollLeft, outerTop: el.scrollTop, outerLeft: el.scrollLeft };
      dispose();
    };
  }, [path, before, after, mode, wrap, hideWhitespace, enabled, commentable, base, originalPath]);
  useEffect(() => { controller.current?.update(); }, [commentsKey]);
  const draftHere = attached.some((c) => c.id === REVIEW_DRAFT_ID) && mounts.has(REVIEW_DRAFT_ID);
  const placeDraft = review?.placeDraft;
  // Before paint: a slow diff may already show the draft above it, and the two cards must never both be on screen.
  useLayoutEffect(() => draftHere && placeDraft ? placeDraft() : undefined, [draftHere, placeDraft]);
  return <div className={cn("flex flex-col", !stacked && "h-full min-h-0")}>
    {selection && commentable && <div className="flex shrink-0 items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground">
      <Button size="xs" variant="secondary" disabled={review?.busy} onClick={() => review?.start(selection)} title="⌘/Ctrl Shift M on a line also adds a comment; Shift-click + for a range">Comment on selection</Button>
    </div>}
    <div ref={host} className={cn("diff-pane select-text", !stacked && "min-h-0 flex-1 overflow-auto scrollbar-thin")} />
    {unplaced.length > 0 && <section ref={unplacedList} aria-label="Threads without a current diff line" className={cn("shrink-0 space-y-2 border-t border-hairline p-2", !stacked && "max-h-[40%] overflow-auto scrollbar-thin")}>
      <p className="text-xs text-muted-foreground">Outdated threads and threads without a current diff line</p>
      {unplaced.map((thread) => <GitHubThreadComment key={thread.id} workspace={workspace} threadId={thread.id} />)}
    </section>}
    {attached.map((comment) => { const target = mounts.get(comment.id); return target ? createPortal(comment.id === REVIEW_DRAFT_ID ? <ReviewDraftCard inline /> : <ReviewCommentCard comment={comment} workspace={workspace} />, target, comment.id) : null; })}
  </div>;
}
