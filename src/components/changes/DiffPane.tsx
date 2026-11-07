import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { languageFor, raccoonHighlight, raccoonTheme } from "@/lib/codemirror";
import { ReviewPatchPane, type ReviewDiff } from "./ReviewPatchPane";

/**
 * A whole-file diff. Unified draws one column with deletions inline; split
 * draws before and after side by side. Both are CodeMirror merge views, so
 * they highlight, collapse unchanged regions and never freeze the page on a
 * large file.
 */
type WholeFileDiff = { path: string; before: string; after: string; mode: "unified" | "split" };
export function DiffPane(props: WholeFileDiff | { review: ReviewDiff; mode: "unified" | "split" }) {
  return "review" in props ? <ReviewPatchPane {...props} /> : <WholeFileDiffPane {...props} />;
}

function WholeFileDiffPane({ path, before, after, mode }: WholeFileDiff) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const common = [raccoonTheme, raccoonHighlight, languageFor(path), EditorView.editable.of(false), EditorState.readOnly.of(true), lineNumbers(), EditorView.lineWrapping];
    let dispose: () => void;
    if (mode === "split") {
      const mv = new MergeView({
        a: { doc: before, extensions: common },
        b: { doc: after, extensions: common },
        parent: el,
        collapseUnchanged: { margin: 3, minSize: 4 },
        highlightChanges: true,
        gutter: true,
      });
      dispose = () => mv.destroy();
    } else {
      const view = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: after,
          extensions: [
            ...common,
            unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 }, highlightChanges: true }),
          ],
        }),
      });
      dispose = () => view.destroy();
    }
    return () => dispose();
  }, [path, before, after, mode]);
  return <div ref={host} className="diff-pane h-full min-h-0 overflow-auto scrollbar-thin select-text" />;
}
