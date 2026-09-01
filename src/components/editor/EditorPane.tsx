import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { AlertTriangle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, fs } from "@/lib/api";
import { languageFor, raccoonHighlight, raccoonTheme } from "@/lib/codemirror";
import { diffLines } from "@/lib/diff";
import { clearJump, setEditorDirty, type EditorEntry } from "@/lib/editors";
import { keycaps } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";

// ---- git gutter: which lines differ from HEAD

type Mark = "added" | "modified" | "deleted";
const setMarks = StateEffect.define<Map<number, Mark>>();
const marksField = StateField.define<Map<number, Mark>>({
  create: () => new Map(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    return value;
  },
});

class GitMarker extends GutterMarker {
  constructor(private kind: Mark) {
    super();
  }
  eq(other: GitMarker) {
    return other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-git-mark cm-git-${this.kind}`;
    return el;
  }
}
const markers: Record<Mark, GitMarker> = { added: new GitMarker("added"), modified: new GitMarker("modified"), deleted: new GitMarker("deleted") };

const gitGutter = [
  marksField,
  gutter({
    class: "cm-git-gutter",
    lineMarker(view, line) {
      const n = view.state.doc.lineAt(line.from).number;
      const kind = view.state.field(marksField).get(n);
      return kind ? markers[kind] : null;
    },
    lineMarkerChange: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(setMarks))),
  }),
];

/**
 * Per-line status against the committed text. Each run of changed lines is
 * read as a whole: adds beside deletes are a modification, adds alone are
 * new lines, deletes alone leave a marker where the lines used to be.
 */
function gitMarks(head: string, now: string): Map<number, Mark> {
  const out = new Map<number, Mark>();
  let lastNew = 0;
  let adds: number[] = [];
  let dels = 0;
  const close = () => {
    if (adds.length) for (const n of adds) out.set(n, dels ? "modified" : "added");
    else if (dels) out.set(lastNew + 1, "deleted");
    adds = [];
    dels = 0;
  };
  for (const l of diffLines(head, now, 3000)) {
    if (l.kind === "add" && l.newNo) adds.push(l.newNo);
    else if (l.kind === "del") dels++;
    else if (l.newNo) {
      close();
      lastNew = l.newNo;
    }
  }
  close();
  return out;
}

/**
 * A file open for editing. ⌘S saves; the tab shows a dot while the buffer
 * differs from disk. Every two seconds the file's mtime is compared with the
 * one last read: a clean buffer follows the disk silently, a dirty one shows
 * a banner and lets the reader choose.
 */
export function EditorPane({ entry, visible }: { entry: EditorEntry; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedDoc = useRef<string>("");
  const mtime = useRef<number>(0);
  const headDoc = useRef<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "binary" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const abs = `${entry.root}/${entry.rel}`;

  const updateMarks = useCallback(() => {
    const view = viewRef.current;
    if (!view || headDoc.current == null) return;
    view.dispatch({ effects: setMarks.of(gitMarks(headDoc.current, view.state.doc.toString())) });
  }, []);

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    try {
      mtime.current = await fs.writeText(abs, text);
      savedDoc.current = text;
      setDirty(false);
      setEditorDirty(entry.id, false);
      setChangedOnDisk(false);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [abs, entry.id]);

  const reloadFromDisk = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    try {
      const f = await fs.readText(abs);
      mtime.current = f.mtimeMs;
      savedDoc.current = f.content;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content } });
      setDirty(false);
      setEditorDirty(entry.id, false);
      setChangedOnDisk(false);
      updateMarks();
    } catch (e) {
      setError(String(e));
    }
  }, [abs, entry.id, updateMarks]);

  // Mount: read the file, build the editor, fetch HEAD for the gutter.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let markTimer: number | undefined;
    (async () => {
      try {
        const f = await fs.readText(abs);
        if (cancelled) return;
        if (f.binary) {
          setStatus("binary");
          return;
        }
        mtime.current = f.mtimeMs;
        savedDoc.current = f.content;
        setTruncated(f.truncated);
        const extensions: Extension[] = [
          raccoonTheme,
          raccoonHighlight,
          lineNumbers(),
          gitGutter,
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          languageFor(entry.rel),
          keymap.of([
            { key: "Mod-s", run: () => (void save(), true) },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const d = u.state.doc.toString() !== savedDoc.current;
            setDirty(d);
            setEditorDirty(entry.id, d);
            window.clearTimeout(markTimer);
            markTimer = window.setTimeout(updateMarks, 250);
          }),
        ];
        const view = new EditorView({ parent: el, state: EditorState.create({ doc: f.content, extensions }) });
        viewRef.current = view;
        setStatus("ready");
        try {
          const tree = await api.headTree(entry.root);
          if (cancelled || !tree) return;
          const pair = await api.fileContentsAt(entry.root, entry.rel, tree, null);
          if (cancelled) return;
          headDoc.current = pair.before ?? "";
          updateMarks();
        } catch {
          headDoc.current = null;
        }
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(markTimer);
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [abs, entry.id, entry.rel, entry.root, save, updateMarks]);

  // Jump to a line when asked (from search results or the tree).
  useEffect(() => {
    const view = viewRef.current;
    const j = entry.jump;
    if (!view || !j || status !== "ready") return;
    const line = Math.max(1, Math.min(view.state.doc.lines, j.line));
    const info = view.state.doc.line(line);
    const pos = Math.min(info.to, info.from + (j.col ?? 0));
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
    clearJump(entry.id);
  }, [entry.jump, entry.id, status]);

  // Focus when shown.
  useEffect(() => {
    if (visible && status === "ready") requestAnimationFrame(() => viewRef.current?.focus());
  }, [visible, status]);

  // Watch the disk while visible.
  useEffect(() => {
    if (!visible || status !== "ready") return;
    const t = window.setInterval(async () => {
      const m = await fs.mtime(abs).catch(() => null);
      if (m == null || m === mtime.current) return;
      if (!dirty) void reloadFromDisk();
      else setChangedOnDisk(true);
    }, 2000);
    return () => window.clearInterval(t);
  }, [visible, status, abs, dirty, reloadFromDisk]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-xs">
        <span className="truncate text-muted-foreground" title={abs}>
          {entry.rel}
        </span>
        {truncated && <span className="text-warning">first 4 MB shown</span>}
        <span className="ml-auto flex items-center gap-1">
          {dirty && <span className="text-faint">unsaved</span>}
          <Button variant="ghost" size="xs" onClick={() => void save()} disabled={!dirty} aria-label="Save">
            <Save className="size-3.5" />
            Save
            <kbd className="ml-1 text-[10px] text-faint">{keycaps("mod+s").join("")}</kbd>
          </Button>
        </span>
      </div>
      {changedOnDisk && (
        <div className="flex shrink-0 items-center gap-2 bg-warning/10 px-3 py-1.5 text-xs text-foreground">
          <AlertTriangle className="size-3.5 text-warning" />
          This file changed on disk while you were editing.
          <Button variant="outline" size="xs" className="ml-auto" onClick={() => void reloadFromDisk()}>
            Reload from disk
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setChangedOnDisk(false)}>
            Keep mine
          </Button>
        </div>
      )}
      {error && <div className="shrink-0 px-3 py-1.5 text-xs text-destructive">{error}</div>}
      {status === "binary" && <div className="p-4 text-sm text-muted-foreground">Binary file, not shown.</div>}
      {status === "loading" && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
      <div ref={host} className={cn("editor-pane min-h-0 flex-1 overflow-auto scrollbar-thin select-text", status !== "ready" && "hidden")} />
    </div>
  );
}
