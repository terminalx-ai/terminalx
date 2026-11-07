import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Compartment, EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, drawSelection, gutter, keymap } from "@codemirror/view";
import { MergeView, uncollapseUnchanged } from "@codemirror/merge";
import { languageFor, raccoonHighlight, raccoonTheme } from "@/lib/codemirror";
import { normalizeReviewText, reviewSelection, unifiedReviewLines, type ReviewLine } from "@/lib/reviewDiff";
import type { ReviewAnchor, ReviewComment, ReviewSide } from "@/lib/reviewComments";
import { Button } from "@/components/ui/button";
import { ReviewCommentCard, useReviewComments } from "./ReviewComments";

class CommentWidget extends WidgetType {
  constructor(readonly id: string, readonly mount: (id: string, element: HTMLElement | null, old?: HTMLElement) => void) { super(); }
  eq(other: CommentWidget) { return this.id === other.id; }
  toDOM() { const el = document.createElement("div"); this.mount(this.id, el); return el; }
  destroy(el: HTMLElement) { this.mount(this.id, null, el); }
  ignoreEvent() { return true; }
}
class CollapseWidget extends WidgetType {
  constructor(readonly count: number, readonly expand: () => void) { super(); }
  toDOM() {
    const button = document.createElement("button");
    button.type = "button"; button.className = "cm-collapsedLines w-full text-left";
    button.textContent = `Show ${this.count} unchanged lines`;
    button.onclick = this.expand;
    return button;
  }
  ignoreEvent() { return true; }
}
class ReviewGutter extends GutterMarker {
  constructor(readonly row: ReviewLine, readonly add: (event: MouseEvent) => void) { super(); }
  eq(other: ReviewGutter) { return this.row === other.row; }
  toDOM() {
    const el = document.createElement("span");
    const numbers = document.createElement("span");
    numbers.className = "inline-block min-w-16 px-1 text-right";
    numbers.textContent = `${this.row.before ?? ""} ${this.row.after ?? ""}`;
    el.append(numbers);
    const button = document.createElement("button");
    button.type = "button"; button.textContent = "+";
    button.className = "inline-block w-5 rounded text-info hover:bg-selected";
    button.setAttribute("aria-label", `Comment on ${this.row.after != null ? "after" : "before"} line ${this.row.after ?? this.row.before}`);
    button.title = "Add comment (Shift-click to select a range)";
    button.onclick = this.add;
    el.append(button);
    return el;
  }
}

interface Pane { view: EditorView; lines: ReviewLine[]; side?: ReviewSide; comments: Compartment; expanded: Set<number> }

export function ReviewDiffPane({ path, before, after, mode, base, originalPath }: { path: string; before: string; after: string; mode: "unified" | "split"; base?: string; originalPath?: string }) {
  const review = useReviewComments()!;
  const latest = useRef(review);
  latest.current = review;
  const host = useRef<HTMLDivElement>(null);
  const panes = useRef<Pane[]>([]);
  const [mounts, setMounts] = useState(new Map<string, HTMLElement>());
  const [selection, setSelection] = useState<ReviewAnchor | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const redraw = useRef<() => void>(() => {});
  const fileComments = review.comments.filter((c) => c.path === path);
  const commentsKey = JSON.stringify(fileComments);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let alive = true;
    const mount = (id: string, element: HTMLElement | null, old?: HTMLElement) => queueMicrotask(() => {
      if (!alive) return;
      setMounts((was) => {
        const next = new Map(was);
        if (element) next.set(id, element); else if (next.get(id) === old) next.delete(id);
        return next;
      });
    });
    let rangeStart: { pane: Pane; line: number } | null = null;
    const add = (pane: Pane, line: number, event: MouseEvent) => {
      if (latest.current.busy) return;
      let from = line, to = line;
      if (event.shiftKey && rangeStart?.pane === pane) from = rangeStart.line;
      else {
        const selected = pane.view.state.selection.main;
        if (!selected.empty) {
          const a = pane.view.state.doc.lineAt(selected.from).number;
          const b = pane.view.state.doc.lineAt(Math.max(selected.from, selected.to - 1)).number;
          if (line >= a && line <= b) { from = a; to = b; }
        }
        rangeStart = { pane, line };
      }
      const anchor = reviewSelection(path, pane.lines, from, to, pane.side);
      if (anchor) { setSelectionError(null); latest.current.start(anchor.side === "before" ? { ...anchor, base, originalPath } : anchor); }
      else setSelectionError("Select a range on one side of the diff.");
    };
    const common = [raccoonTheme, raccoonHighlight, languageFor(path), EditorView.editable.of(false), EditorState.readOnly.of(true), EditorView.lineWrapping, drawSelection(), EditorView.theme({
      ".cm-review-before": { backgroundColor: "color-mix(in oklab, var(--destructive) 12%, transparent)" },
      ".cm-review-after": { backgroundColor: "color-mix(in oklab, var(--accent-add) 12%, transparent)" },
      ".cm-review-gutter .cm-gutterElement": { padding: "0 2px" },
    })];
    const extensions = (pane: Pane) => [
      ...common, pane.comments.of([]), EditorView.contentAttributes.of({ tabindex: "0", "aria-label": `${path} ${pane.side ?? "unified"} diff` }),
      gutter({ class: "cm-review-gutter", lineMarker: (view, line) => {
        const number = view.state.doc.lineAt(line.from).number;
        const row = pane.lines[number - 1];
        return row && (row.before != null || row.after != null) ? new ReviewGutter(row, (event) => add(pane, number, event)) : null;
      } }),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet) return;
        const selected = update.state.selection.main;
        setSelection(selected.empty ? null : reviewSelection(path, pane.lines,
          update.state.doc.lineAt(selected.from).number, update.state.doc.lineAt(Math.max(selected.from, selected.to - 1)).number, pane.side));
      }),
      keymap.of([{ key: "Mod-Shift-m", run: (view) => { add(pane, view.state.doc.lineAt(view.state.selection.main.head).number, new MouseEvent("click")); return true; } }]),
    ];
    const makePane = (lines: ReviewLine[], side?: ReviewSide): Pane => ({ view: null!, lines, side, comments: new Compartment(), expanded: new Set() });
    const unified = unifiedReviewLines(before, after);
    const linePairs = new Map<string, ReviewLine>();
    for (const line of unified) {
      if (line.before != null) linePairs.set(`before:${line.before}`, line);
      if (line.after != null) linePairs.set(`after:${line.after}`, line);
    }
    let destroy: () => void;
    if (mode === "split") {
      const oldText = normalizeReviewText(before), newText = normalizeReviewText(after);
      const changedA = new Set(unified.filter((l) => l.kind === "before").map((l) => l.before));
      const changedB = new Set(unified.filter((l) => l.kind === "after").map((l) => l.after));
      const a = makePane(oldText.split("\n").map((text, i) => ({ text, before: i + 1, kind: changedA.has(i + 1) ? "before" : "same" })), "before");
      const b = makePane(newText.split("\n").map((text, i) => ({ text, after: i + 1, kind: changedB.has(i + 1) ? "after" : "same" })), "after");
      const view = new MergeView({ a: { doc: oldText, extensions: extensions(a) }, b: { doc: newText, extensions: extensions(b) }, parent, highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 4 } });
      a.view = view.a; b.view = view.b; panes.current = [a, b];
      destroy = () => view.destroy();
    } else {
      const pane = makePane(unified);
      pane.view = new EditorView({ parent, doc: pane.lines.map((l) => l.text).join("\n"), extensions: extensions(pane) });
      panes.current = [pane];
      destroy = () => pane.view.destroy();
    }
    // CodeMirror hides decorative gutters by default; these contain real controls.
    for (const pane of panes.current) pane.view.dom.querySelectorAll(".cm-gutters").forEach((el) => el.removeAttribute("aria-hidden"));
    const update = () => {
      const comments = latest.current.comments.filter((c) => c.path === path);
      for (const pane of panes.current) {
        const decorations: Range<Decoration>[] = [];
        const attached = new Map<number, ReviewComment[]>();
        const visible = new Set<number>();
        for (const c of comments) {
          if (pane.side && pane.side !== c.side) {
            const siblingLine = linePairs.get(`${c.side}:${c.endLine}`)?.[pane.side];
            if (siblingLine != null) visible.add(siblingLine - 1);
            continue;
          }
          let index = pane.lines.findIndex((l) => l[c.side] === c.endLine);
          // A removed range remains at the end with its original quotation and location.
          if (index < 0) index = pane.lines.length - 1;
          attached.set(index, [...(attached.get(index) ?? []), c]);
          visible.add(index);
        }
        pane.lines.forEach((line, index) => {
          const at = pane.view.state.doc.line(index + 1);
          if (!pane.side && line.kind !== "same") decorations.push(Decoration.line({ class: `cm-review-${line.kind}` }).range(at.from));
          for (const change of line.changes ?? []) decorations.push(Decoration.mark({ class: line.kind === "before" ? "cm-deletedText" : "cm-changedText" }).range(at.from + change.from, at.from + change.to));
          for (const c of attached.get(index) ?? []) decorations.push(Decoration.widget({ block: true, side: 1, widget: new CommentWidget(c.id, mount) }).range(at.to));
        });
        // Keep native split alignment; unified folds only unchanged spans that have no notes.
        if (!pane.side) {
          for (let i = 0; i < pane.lines.length;) {
            if (pane.lines[i].kind !== "same") { i++; continue; }
            const start = i;
            while (i < pane.lines.length && pane.lines[i].kind === "same") i++;
            const from = start + 3, to = i - 3;
            if (to - from < 4 || pane.expanded.has(start) || [...attached.keys()].some((n) => n >= from && n < to)) continue;
            decorations.push(Decoration.replace({ block: true, widget: new CollapseWidget(to - from, () => { pane.expanded.add(start); update(); }) }).range(pane.view.state.doc.line(from + 1).from, pane.view.state.doc.line(to).to));
          }
        }
        // Public decoration facets expose the start of native collapsed ranges. Expand
        // any holding a comment, in both siblings, so its inline card stays visible.
        const expand: ReturnType<typeof uncollapseUnchanged.of>[] = [];
        if (pane.side) for (const decoration of pane.view.state.facet(EditorView.decorations)) {
          if (typeof decoration === "function") continue;
          decoration.between(0, pane.view.state.doc.length, (from, to, value) => {
            if (to > from && value.spec.block && [...visible].some((index) => {
              const position = pane.view.state.doc.line(index + 1).to;
              return position >= from && position <= to;
            })) expand.push(uncollapseUnchanged.of(from));
          });
        }
        pane.view.dispatch({ effects: [...expand, pane.comments.reconfigure(EditorView.decorations.of(Decoration.set(decorations, true)))] });
      }
    };
    redraw.current = update;
    update(); setSelection(null); setSelectionError(null);
    return () => { alive = false; destroy(); panes.current = []; redraw.current = () => {}; setMounts(new Map()); };
  }, [path, before, after, mode, base, originalPath]);
  useEffect(() => { redraw.current(); }, [commentsKey]);

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground">
      <span>Select text or Shift-click + for a range.</span>
      {selection && <Button size="xs" variant="secondary" disabled={review.busy} onClick={() => review.start(selection.side === "before" ? { ...selection, base, originalPath } : selection)}>Comment on selection</Button>}
      {selectionError && <span role="alert">{selectionError}</span>}
    </div>
    <div ref={host} className="diff-pane min-h-0 flex-1 overflow-auto scrollbar-thin select-text" />
    {fileComments.map((comment) => { const target = mounts.get(comment.id); return target ? createPortal(<ReviewCommentCard comment={comment} />, target, comment.id) : null; })}
  </div>;
}
