import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { AlertTriangle, FolderOpen, Save } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Segmented } from "@/components/ui/controls";
import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { registerLiveEditor } from "@/lib/editorViews";
import { languageFor, raccoonHighlight, raccoonTheme } from "@/lib/codemirror";
import { diffLines } from "@/lib/diff";
import { clearJump, editorLinkContext, getEditors, isMarkdown, setEditorDirty, setViewMode, type EditorEntry, type ViewMode } from "@/lib/editors";
import { changedSince, fileErrorText, isConflict, stashBuffer, takeStashedBuffer, useFileSource, type FileState } from "@/lib/workspaceFiles";
import { keycaps } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";
import { FindBar, findPanel, type FindPanelHandle } from "./FindPanel";

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
 * differs from disk. A local file's mtime is compared with the one last read
 * every two seconds; a cloud workspace's file (PRO-24) is re-checked when
 * the runtime reports it changed, and after every reconnect. A clean buffer
 * follows the file silently, a dirty one shows a banner and lets the reader
 * choose. A cloud save is conditional on the content the buffer was based
 * on, so an edit made meanwhile (by an agent, or another device) is never
 * overwritten without an explicit choice, and an unsaved cloud buffer
 * survives reconnects and the workspace page closing.
 */
export function EditorPane({ entry, visible }: { entry: EditorEntry; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedDoc = useRef<string>("");
  const fileState = useRef<FileState>({ version: "" });
  const headDoc = useRef<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "binary" | "error" | "offline">("loading");
  const [error, setError] = useState<string | null>(null);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  // A cloud save was refused: the file changed since the buffer was read.
  const [conflict, setConflict] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  // The ⌘F bar while it is open; its element belongs to CodeMirror, its contents to React.
  const [find, setFind] = useState<FindPanelHandle | null>(null);
  // The buffer as text, for the markdown preview; refreshed a beat after edits.
  const [docText, setDocText] = useState("");
  const source = useFileSource(entry.source, entry.root);
  const cloud = source?.kind === "cloud";
  const readOnly = !!source?.readOnly;
  const abs = `${entry.root}/${entry.rel}`;
  const markdown = isMarkdown(entry.rel);
  const preview = markdown && entry.viewMode === "preview";
  const linkContext = useMemo(() => editorLinkContext(entry), [entry]);
  const describeError = useCallback((e: unknown) => (cloud ? fileErrorText(e) : String(e)), [cloud]);

  const updateMarks = useCallback(() => {
    const view = viewRef.current;
    if (!view || headDoc.current == null) return;
    view.dispatch({ effects: setMarks.of(gitMarks(headDoc.current, view.state.doc.toString())) });
  }, []);

  const markSaved = useCallback(
    (text: string, state: FileState) => {
      fileState.current = state;
      savedDoc.current = text;
      setDirty(false);
      setEditorDirty(entry.id, false);
      setChangedOnDisk(false);
      setConflict(false);
      setError(null);
    },
    [entry.id],
  );

  /** `base`: the content hash the save is conditional on (null: the file must not exist). */
  const write = useCallback(
    async (base: string | null | undefined) => {
      const view = viewRef.current;
      if (!view || !source || source.readOnly) return;
      const text = view.state.doc.toString();
      try {
        markSaved(text, await source.writeText(entry.rel, text, base));
      } catch (e) {
        if (isConflict(e)) setConflict(true);
        else setError(describeError(e));
      }
    },
    [source, entry.rel, markSaved, describeError],
  );

  const save = useCallback(() => write(fileState.current.etag), [write]);

  /**
   * Resolve a conflict in favour of the buffer: overwrite what is there now,
   * knowingly — still conditional on that version, so a change after this
   * choice is another conflict, never lost.
   */
  const overwrite = useCallback(async () => {
    if (!source) return;
    try {
      const now = await source.stat(entry.rel, { etag: true });
      if (now && source.kind === "cloud" && !now.etag) {
        setError("The file in the workspace is too large to compare; it was not overwritten.");
        return;
      }
      // Gone meanwhile: recreate it, refusing if it reappears first (a
      // cloud save conditional on "must not exist").
      await write(now ? now.etag : null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [source, entry.rel, write, describeError]);

  const reloadFromDisk = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !source) return;
    try {
      const f = await source.readText(entry.rel);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content } });
      setDocText(f.content);
      markSaved(f.content, { version: f.version, etag: f.etag });
      updateMarks();
    } catch (e) {
      setError(describeError(e));
    }
  }, [source, entry.rel, markSaved, updateMarks, describeError]);

  // Mount: read the file (or restore an unsaved cloud buffer), build the
  // editor, fetch HEAD for the gutter.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (!source) {
      setStatus("offline");
      return;
    }
    let cancelled = false;
    let markTimer: number | undefined;
    let unregister: (() => void) | undefined;
    (async () => {
      try {
        const stash = source.kind === "cloud" ? takeStashedBuffer(entry.id) : undefined;
        let doc: string;
        if (stash) {
          doc = stash.text;
          savedDoc.current = stash.saved;
          fileState.current = stash.state;
        } else {
          const f = await source.readText(entry.rel);
          if (cancelled) return;
          if (f.binary) {
            setStatus("binary");
            return;
          }
          doc = f.content;
          savedDoc.current = f.content;
          fileState.current = { version: f.version, etag: f.etag };
          setTruncated(f.truncated);
        }
        setDocText(doc);
        const restoredDirty = doc !== savedDoc.current;
        setDirty(restoredDirty);
        setEditorDirty(entry.id, restoredDirty);
        let textTimer: number | undefined;
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
          findPanel(setFind),
          languageFor(entry.rel),
          EditorState.readOnly.of(source.readOnly),
          EditorView.editable.of(!source.readOnly),
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
            window.clearTimeout(textTimer);
            textTimer = window.setTimeout(() => setDocText(u.state.doc.toString()), 150);
          }),
        ];
        const view = new EditorView({ parent: el, state: EditorState.create({ doc, extensions }) });
        viewRef.current = view;
        unregister = registerLiveEditor(abs, { view, isDirty: () => view.state.doc.toString() !== savedDoc.current, save });
        setStatus("ready");
        if (stash) {
          // Restored after being away: the file may have moved on meanwhile.
          const now = await source.stat(entry.rel).catch(() => fileState.current);
          if (!cancelled && changedSince(fileState.current, now)) setChangedOnDisk(true);
        }
        if (source.kind !== "local") return;
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
          setError(describeError(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(markTimer);
      unregister?.();
      const view = viewRef.current;
      // A cloud buffer with unsaved text outlives its view while its editor
      // is still open (the workspace page closed, or the source went away).
      if (view && source.kind === "cloud" && view.state.doc.toString() !== savedDoc.current && getEditors().editors.some((e) => e.id === entry.id)) {
        stashBuffer(entry.id, { text: view.state.doc.toString(), saved: savedDoc.current, state: fileState.current });
      }
      view?.destroy();
      viewRef.current = null;
      setFind(null);
    };
  }, [abs, entry.id, entry.rel, entry.root, source, save, updateMarks, describeError]);

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
    if (visible && status === "ready" && !preview) requestAnimationFrame(() => viewRef.current?.focus());
  }, [visible, status, preview]);

  // Follow the file: a clean buffer reloads, a dirty one asks.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const checkForChange = useCallback(async () => {
    if (!source) return;
    const now = await source.stat(entry.rel).catch(() => undefined);
    if (now === undefined) return;
    if (now === null) {
      // Gone (deleted, or mid-rename by another tool). A local file keeps
      // its buffer quietly until it is back; a cloud one says so.
      if (source.kind === "cloud") setChangedOnDisk(true);
      return;
    }
    if (!changedSince(fileState.current, now)) return;
    if (!dirtyRef.current) void reloadFromDisk();
    else setChangedOnDisk(true);
  }, [source, entry.rel, reloadFromDisk]);

  // A local file is polled while visible; a cloud one is re-checked when the
  // runtime says it changed, or after a reconnect (`null`: changes missed).
  useEffect(() => {
    if (status !== "ready" || !source) return;
    if (source.watch) {
      return source.watch((paths) => {
        if (paths === null || paths.includes(entry.rel)) void checkForChange();
      });
    }
    if (!visible) return;
    const t = window.setInterval(() => void checkForChange(), 2000);
    return () => window.clearInterval(t);
  }, [visible, status, source, entry.rel, checkForChange]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-xs">
        <span className="truncate text-muted-foreground" title={abs}>
          {entry.rel}
        </span>
        {truncated && <span className="text-warning">first 4 MB shown</span>}
        {cloud && <span className="text-faint" data-testid="editor-cloud-file">cloud workspace</span>}
        <span className="ml-auto flex items-center gap-1">
          {readOnly && <span className="text-faint">read-only</span>}
          {dirty && <span className="text-faint">unsaved</span>}
          {markdown && (
            <Segmented<ViewMode>
              aria-label="View"
              value={entry.viewMode}
              onChange={(m) => setViewMode(entry.id, m)}
              options={[
                { value: "preview", label: "Preview" },
                { value: "source", label: "Source" },
              ]}
            />
          )}
          {!cloud && (
            <Button variant="ghost" size="icon-xs" aria-label="Reveal in Finder" onClick={() => void revealItemInDir(abs).catch(() => {})}>
              <FolderOpen />
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={() => void save()} disabled={!dirty || readOnly || !source} aria-label="Save">
            <Save className="size-3.5" />
            Save
            <kbd className="ml-1 text-[10px] text-faint">{keycaps("mod+s").join("")}</kbd>
          </Button>
        </span>
      </div>
      {conflict && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 bg-destructive/10 px-3 py-1.5 text-xs text-foreground" data-testid="editor-conflict">
          <AlertTriangle className="size-3.5 text-destructive" />
          Not saved: this file changed in the workspace since you opened it. Your changes are still here.
          <span className="ml-auto flex gap-1">
            <Button variant="outline" size="xs" onClick={() => void overwrite()}>
              Overwrite with mine
            </Button>
            <Button variant="outline" size="xs" onClick={() => void reloadFromDisk()}>
              Discard mine and reload
            </Button>
            <Button variant="ghost" size="xs" onClick={() => void navigator.clipboard?.writeText(viewRef.current?.state.doc.toString() ?? "").catch(() => {})}>
              Copy mine
            </Button>
          </span>
        </div>
      )}
      {changedOnDisk && !conflict && (
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
      {status === "binary" && (
        <div className="p-4 text-sm text-muted-foreground">
          Cannot preview {entry.name}. {cloud ? "It is binary or not UTF-8 text." : "This binary format is unsupported. Use Reveal in Finder to open it externally."}
        </div>
      )}
      {status === "loading" && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
      {status === "offline" && (
        <div className="p-4 text-sm text-muted-foreground">Open the cloud workspace to read {entry.name}. Unsaved changes are kept until then.</div>
      )}
      {preview && status === "ready" && (
        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin px-6 py-4 select-text">
          <Markdown
            text={docText}
            className="prose-chat"
            linkContext={cloud ? undefined : linkContext}
          />
        </div>
      )}
      <div ref={host} className={cn("editor-pane min-h-0 flex-1 overflow-auto scrollbar-thin select-text", (status !== "ready" || preview) && "hidden")} />
      {find && createPortal(<FindBar handle={find} />, find.dom)}
    </div>
  );
}
