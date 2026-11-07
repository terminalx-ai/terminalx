import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { languageFor, raccoonHighlight, raccoonTheme } from "@/lib/codemirror";

/**
 * A whole-file diff. Unified draws one column with deletions inline; split
 * draws before and after side by side. Both are CodeMirror merge views, so
 * they highlight, collapse unchanged regions and never freeze the page on a
 * large file.
 */
export function DiffPane({ path, before, after, mode }: { path: string; before: string; after: string; mode: "unified" | "split" | "entire" }) {
  const host = useRef<HTMLDivElement>(null);
  const scroll = useRef({ top: 0, left: 0, outerTop: 0, outerLeft: 0 });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const common = [raccoonTheme, raccoonHighlight, languageFor(path), EditorView.editable.of(false), EditorState.readOnly.of(true), lineNumbers(), EditorView.lineWrapping];
    let dispose: () => void;
    let scroller: HTMLElement;
    if (mode === "split") {
      const mv = new MergeView({
        a: { doc: before, extensions: common },
        b: { doc: after, extensions: common },
        parent: el,
        collapseUnchanged: { margin: 3, minSize: 4 },
        highlightChanges: true,
        gutter: true,
      });
      scroller = mv.b.scrollDOM;
      dispose = () => mv.destroy();
    } else {
      const view = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: after,
          extensions: [
            ...common,
            ...(mode === "entire" ? [] : [unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 }, highlightChanges: true })]),
          ],
        }),
      });
      scroller = view.scrollDOM;
      dispose = () => view.destroy();
    }
    const frame = requestAnimationFrame(() => {
      el.scrollTop = scroll.current.outerTop;
      el.scrollLeft = scroll.current.outerLeft;
      if (scroll.current.top || scroll.current.left) { scroller.scrollTop = scroll.current.top; scroller.scrollLeft = scroll.current.left; }
    });
    return () => {
      cancelAnimationFrame(frame);
      scroll.current = { top: scroller.scrollTop, left: scroller.scrollLeft, outerTop: el.scrollTop, outerLeft: el.scrollLeft };
      dispose();
    };
  }, [path, before, after, mode]);
  return <div ref={host} className="diff-pane h-full min-h-0 overflow-auto scrollbar-thin select-text" />;
}
