import { useEffect, useRef } from "react";
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
export function DiffPane({ path, before, after, mode, wrap = true, hideWhitespace = false }: { wrap?: boolean; hideWhitespace?: boolean; path: string; before: string; after: string; mode: "unified" | "split" }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const common = [raccoonTheme, raccoonHighlight, languageFor(path), EditorView.editable.of(false), EditorState.readOnly.of(true), lineNumbers(), ...(wrap ? [EditorView.lineWrapping] : [])];
    let dispose: () => void;
    if (mode === "split") {
      const mv = new MergeView({
        a: { doc: before, extensions: common },
        b: { doc: after, extensions: common },
        parent: el,
        collapseUnchanged: { margin: 3, minSize: 4 },
        diffConfig: hideWhitespace ? { override: whitespaceDiff } : undefined,
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
            unifiedMergeView({ original: before, diffConfig: hideWhitespace ? { override: whitespaceDiff } : undefined, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 }, highlightChanges: true }),
          ],
        }),
      });
      dispose = () => view.destroy();
    }
    return () => dispose();
  }, [path, before, after, mode, wrap, hideWhitespace]);
  return <div ref={host} className="diff-pane h-full min-h-0 overflow-auto scrollbar-thin select-text" />;
}
