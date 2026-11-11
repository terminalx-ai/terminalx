import { Compartment, Text, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, drawSelection, gutter, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { getChunks, uncollapseUnchanged } from "@codemirror/merge";
import { anchorReview, locateReview, normalizeReviewText, reviewInDiff } from "@/lib/reviewAnchors";
import type { ReviewAnchor, ReviewComment, LineCommentSide } from "@/lib/reviewComments";

class CommentWidget extends WidgetType {
  constructor(readonly id: string, readonly mount: (id: string, element: HTMLElement | null, old?: HTMLElement) => void) { super(); }
  eq(other: CommentWidget) { return this.id === other.id; }
  toDOM() { const el = document.createElement("div"); this.mount(this.id, el); return el; }
  destroy(el: HTMLElement) { this.mount(this.id, null, el); }
  ignoreEvent() { return true; }
}
class CommentGutter extends GutterMarker {
  constructor(readonly line: number, readonly side: LineCommentSide, readonly add: (line: number, event: MouseEvent) => void) { super(); }
  eq(other: CommentGutter) { return this.line === other.line && this.side === other.side; }
  toDOM() { return commentButton(this.side, this.line, (e) => this.add(this.line, e)); }
}
function commentButton(side: LineCommentSide, line: number, add: (event: MouseEvent) => void) {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = "+"; button.tabIndex = -1;
  button.className = "cm-review-add inline-block w-5 rounded text-info hover:bg-selected select-none";
  button.setAttribute("aria-label", `Comment on ${side} line ${line}`);
  button.title = "Add comment (Shift-click for a range; ⌘/Ctrl Shift M on a focused line)";
  button.onmousedown = (event) => event.preventDefault();
  button.onclick = (event) => { button.focus({ preventScroll: true }); add(event); };
  return button;
}
interface Pane { view?: EditorView; side: LineCommentSide; unified: boolean; compartment: Compartment }
interface Config {
  path: string; base: string; originalPath?: string; before: string; after: string;
  comments(): ReviewComment[];
  start(anchor: ReviewAnchor): void;
  selection(anchor: ReviewAnchor | null): void;
  mount(id: string, element: HTMLElement | null, old?: HTMLElement): void;
}

/** Extensions of the shared merge renderer; never constructs another editor or diff document. */
export function diffComments(config: Config) {
  const panes: Pane[] = [];
  const original = Text.of(normalizeReviewText(config.before).split("\n"));
  let rangeStart: { side: LineCommentSide; line: number } | undefined;
  let disposed = false, frame = 0;
  const mountedDeleted = new Map<string, HTMLElement>();
  const anchor = (side: LineCommentSide, a: number, b = a) => anchorReview(config.path, config.base, side, config[side], a, b, config.originalPath);
  const add = (pane: Pane, side: LineCommentSide, line: number, event?: MouseEvent) => {
    let from = line, to = line;
    if (event?.shiftKey && rangeStart?.side === side) from = rangeStart.line;
    else {
      const selection = side === pane.side ? pane.view?.state.selection.main : null;
      if (selection && !selection.empty) {
        const doc = pane.view!.state.doc;
        const a = doc.lineAt(selection.from).number, b = doc.lineAt(Math.max(selection.from, selection.to - 1)).number;
        if (line >= a && line <= b) { from = a; to = b; }
      }
      rangeStart = { side, line };
    }
    config.start(anchor(side, from, to));
  };
  let lastComments: ReviewComment[] | undefined;
  let resolved: ReviewComment[] = [];
  const comments = () => {
    const next = config.comments();
    if (next !== lastComments) {
      lastComments = next;
      resolved = next.filter((c) => reviewInDiff(c, config.path, config.base, config.originalPath)).flatMap((c) => {
        const location = locateReview(c, config[c.side]);
        return location.endLine === undefined ? [] : [{ ...c, ...location, startLine: location.startLine!, endLine: location.endLine }];
      });
    }
    return resolved;
  };
  const current = Text.of(normalizeReviewText(config.after).split("\n"));
  // Map LINE offsets, not character offsets: hiding whitespace keeps line
  // boundaries but changes the number of characters in unchanged regions.
  const mapLine = (view: EditorView, side: LineCommentSide, line: number, changedFallback = false) => {
    const source = side === "before" ? original : current, target = view.state.doc;
    const pos = source.line(line).from;
    const numberAt = (doc: Text, at: number) => at > doc.length ? doc.lines + 1 : doc.lineAt(at).number;
    let offset = 0;
    for (const chunk of getChunks(view.state)?.chunks ?? []) {
      const [from, to, targetFrom, targetTo] = side === "before" ? [chunk.fromA, chunk.toA, chunk.fromB, chunk.toB] : [chunk.fromB, chunk.toB, chunk.fromA, chunk.toA];
      if (pos < from) break;
      if (pos < to) return changedFallback ? Math.min(targetFrom, target.length) : null;
      offset = numberAt(target, targetTo) - numberAt(source, to);
    }
    return target.line(Math.min(target.lines, Math.max(1, line + offset))).from;
  };
  const scheduleDeleted = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; decorateDeleted(); });
  };
  const deletedSelection = (pane: Pane) => {
    const selection = window.getSelection();
    const lineOf = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-review-before-line]");
    const first = lineOf(selection?.anchorNode ?? null), last = lineOf(selection?.focusNode ?? null);
    if (!selection?.isCollapsed && first && last && pane.view?.dom.contains(first) && pane.view.dom.contains(last)) {
      const from = Number(first.dataset.reviewBeforeLine), to = Number(last.dataset.reviewBeforeLine);
      config.selection(anchor("before", from, to));
    }
  };
  function decorateDeleted() {
    if (disposed) return;
    const live = new Set<string>();
    const beforeComments = new Map<number, ReviewComment[]>();
    for (const c of comments()) if (c.side === "before") beforeComments.set(c.endLine, [...(beforeComments.get(c.endLine) ?? []), c]);
    for (const pane of panes) {
      const view = pane.view;
      if (!view || !pane.unified) continue;
      const chunks = getChunks(view.state)?.chunks ?? [];
      for (const dom of view.dom.querySelectorAll<HTMLElement>(".cm-deletedChunk")) {
        const pos = view.posAtDOM(dom);
        const chunk = chunks.find((c) => c.fromB === pos && c.fromA < c.toA);
        if (!chunk) continue;
        const start = original.lineAt(chunk.fromA).number;
        const lines = [...dom.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("cm-deletedLine"));
        lines.forEach((el, i) => {
          const line = start + i;
          if (!el.dataset.reviewBeforeLine) {
            el.dataset.reviewBeforeLine = String(line);
            el.prepend(commentButton("before", line, (event) => add(pane, "before", line, event)));
            // One tab stop per deletion chunk; arrows navigate its original lines.
            el.tabIndex = i === 0 ? 0 : -1;
            el.setAttribute("aria-label", `Before line ${line}: ${original.line(line).text}`);
            el.onkeydown = (event) => {
              if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") { event.preventDefault(); config.start(anchor("before", rangeStart?.side === "before" ? rangeStart.line : line, line)); }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const next = lines[i + (event.key === "ArrowDown" ? 1 : -1)];
                if (!next) return;
                event.preventDefault();
                if (!event.shiftKey || rangeStart?.side !== "before") rangeStart = { side: "before", line };
                const nextLine = Number(next.dataset.reviewBeforeLine);
                if (event.shiftKey) config.selection(anchor("before", rangeStart.line, nextLine));
                else { rangeStart = { side: "before", line: nextLine }; config.selection(null); }
                next.focus();
              }
            };
          }
          for (const c of (beforeComments.get(line) ?? [])) {
            live.add(c.id);
            let mount = mountedDeleted.get(c.id);
            if (!mount || mount.parentElement !== dom || mount.dataset.reviewLine !== String(line)) {
              mount?.remove(); mount = document.createElement("div"); mount.className = "cm-review-comment"; mount.dataset.reviewLine = String(line);
              el.after(mount); mountedDeleted.set(c.id, mount); config.mount(c.id, mount);
            }
          }
        });
        dom.onmouseup = () => deletedSelection(pane);
      }
    }
    for (const [id, el] of mountedDeleted) if (!live.has(id)) { el.remove(); mountedDeleted.delete(id); config.mount(id, null, el); }
  }
  const extensions = (side: LineCommentSide, unified = false): { extensions: Extension[]; attach(view: EditorView): void } => {
    const pane: Pane = { side, unified, compartment: new Compartment() };
    panes.push(pane);
    return {
      extensions: [pane.compartment.of([]), drawSelection(),
        EditorView.contentAttributes.of({ tabindex: "0", "aria-label": `${config.path} ${unified ? "unified" : side} diff` }),
        gutter({ class: "cm-review-gutter", lineMarker: (view, line) => new CommentGutter(view.state.doc.lineAt(line.from).number, side, (number, event) => add(pane, side, number, event)) }),
        keymap.of([{ key: "Mod-Shift-m", run: (view) => { add(pane, side, view.state.doc.lineAt(view.state.selection.main.head).number); return true; } }, ...defaultKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) {
            const s = update.state.selection.main, doc = update.state.doc;
            config.selection(s.empty ? null : anchor(side, doc.lineAt(s.from).number, doc.lineAt(Math.max(s.from, s.to - 1)).number));
          }
          if (unified) scheduleDeleted();
        }),
      ],
      attach(view) { pane.view = view; view.dom.querySelectorAll(".cm-gutters").forEach((el) => el.removeAttribute("aria-hidden")); },
    };
  };
  return {
    extensions,
    update() {
      const attached = comments();
      for (const pane of panes) {
        const view = pane.view;
        if (!view) continue;
        const decorations: Range<Decoration>[] = [], positions: number[] = [];
        for (const c of attached) {
          if (!pane.unified && c.side !== pane.side) {
            positions.push(mapLine(view, c.side, c.endLine, true)!);
            continue;
          }
          const pos = pane.unified && c.side === "before" ? mapLine(view, "before", c.endLine) : view.state.doc.line(c.endLine).from;
          if (pos === null) continue;
          const end = view.state.doc.lineAt(pos).to;
          positions.push(end);
          decorations.push(Decoration.widget({ block: true, side: 1, widget: new CommentWidget(c.id, config.mount) }).range(end));
        }
        const expand: ReturnType<typeof uncollapseUnchanged.of>[] = [];
        for (const decoration of view.state.facet(EditorView.decorations)) {
          if (typeof decoration === "function") continue;
          decoration.between(0, view.state.doc.length, (from, to, value) => {
            if (to > from && value.spec.block && positions.some((p) => p >= from && p <= to)) expand.push(uncollapseUnchanged.of(from));
          });
        }
        view.dispatch({ effects: [...expand, pane.compartment.reconfigure(EditorView.decorations.of(Decoration.set(decorations, true)))] });
      }
      scheduleDeleted();
    },
    destroy() { disposed = true; cancelAnimationFrame(frame); mountedDeleted.clear(); },
  };
}
