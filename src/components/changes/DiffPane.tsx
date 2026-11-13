import { createPortal } from "react-dom";
import { diffComments } from "./diffComments";
import { ReviewCommentCard, useReviewComments } from "./ReviewComments";
import { GitHubThreadComment } from "./ReviewThreads";
import { clearThreadFocus, githubThreadComment, githubThreadCommentId, useReviewPr, useThreadFocus } from "@/lib/reviewThreads";
import { locateReview, reviewInDiff } from "@/lib/reviewAnchors";
import type { ReviewAnchor } from "@/lib/reviewComments";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { whitespaceDiff } from "@/lib/diffOptions";
import { languageFor, raccoonHighlight, raccoonTheme } from "@/lib/codemirror";

/**
 * A whole-file diff. Unified draws one column with deletions inline; split
 * draws before and after side by side. Both are CodeMirror merge views, so
 * they highlight, collapse unchanged regions and never freeze the page on a
 * large file.
 */
export function DiffPane({ path, before, after, mode, base, originalPath, workspace, wrap = true, hideWhitespace = false }: { base?: string; originalPath?: string; workspace?: string; wrap?: boolean; hideWhitespace?: boolean; path: string; before: string; after: string; mode: "unified" | "split" | "entire" }) {
  const review = useReviewComments();
  const latest = useRef(review); latest.current = review;
  const controller = useRef<ReturnType<typeof diffComments> | null>(null);
  const [mounts, setMounts] = useState(new Map<string, HTMLElement>());
  const [selection, setSelection] = useState<ReviewAnchor | null>(null);
  // GitHub review threads (PRO-234) are line comments of this diff too, anchored by the code they were left on.
  const threads = useReviewPr(workspace)?.snapshot?.threads;
  const fileThreads = useMemo(() => (threads ?? []).filter((t) => t.path === path || (!!originalPath && t.path === originalPath)), [threads, path, originalPath]);
  const github = useMemo(() => base ? fileThreads.flatMap((t) => githubThreadComment(t, { path, base, originalPath }) ?? []) : [], [fileThreads, path, base, originalPath]);
  const all = useMemo(() => [...(review?.comments ?? []), ...github], [review?.comments, github]);
  const allComments = useRef(all); allComments.current = all;
  const enabled = !!base && (!!review || github.length > 0);
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
    const comments = enabled ? diffComments({ path, base: base!, originalPath, before, after,
      comments: () => allComments.current,
      start: (anchor) => { if (!latest.current?.busy) latest.current?.start(anchor); },
      selection: setSelection,
      mount: (id, element, old) => queueMicrotask(() => {
        if (!alive) return;
        setMounts((was) => { const next = new Map(was); if (element) next.set(id, element); else if (next.get(id) === old) next.delete(id); return next; });
      }),
    }) : null;
    controller.current = comments;
    const common = [raccoonTheme, raccoonHighlight, languageFor(path), EditorView.editable.of(false), EditorState.readOnly.of(true), lineNumbers(), ...(wrap ? [EditorView.lineWrapping] : [])];
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
        highlightChanges: true,
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
            ...(mode === "entire" ? [] : [unifiedMergeView({ original: before, diffConfig: hideWhitespace ? { override: whitespaceDiff } : undefined, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 }, highlightChanges: true })]),
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
  }, [path, before, after, mode, wrap, hideWhitespace, enabled, base, originalPath]);
  useEffect(() => { controller.current?.update(); }, [commentsKey]);
  return <div className="flex h-full min-h-0 flex-col">
    {enabled && <div className="flex shrink-0 items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground">
      <span>Select text or Shift-click + for a range. ⌘/Ctrl Shift M adds a comment.</span>
      {selection && <Button size="xs" variant="secondary" disabled={review?.busy} onClick={() => review?.start(selection)}>Comment on selection</Button>}
    </div>}
    <div ref={host} className="diff-pane min-h-0 flex-1 overflow-auto scrollbar-thin select-text" />
    {unplaced.length > 0 && <section ref={unplacedList} aria-label="Threads without a current diff line" className="max-h-[40%] shrink-0 space-y-2 overflow-auto border-t border-hairline p-2 scrollbar-thin">
      <p className="text-xs text-muted-foreground">Outdated threads and threads without a current diff line</p>
      {unplaced.map((thread) => <GitHubThreadComment key={thread.id} workspace={workspace} threadId={thread.id} />)}
    </section>}
    {attached.map((comment) => { const target = mounts.get(comment.id); return target ? createPortal(<ReviewCommentCard comment={comment} workspace={workspace} />, target, comment.id) : null; })}
  </div>;
}
