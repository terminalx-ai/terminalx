import { useEffect, useMemo, useState } from "react";
import { Columns2, RefreshCw, Rows2 } from "@/icons";
import { DiffPane } from "@/components/changes/DiffPane";
import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { editorLinkContext, fileKind, isMarkdown, setDiffMode, updateDiffRange, type DiffEditorEntry, type DiffMode, type FileEditorEntry } from "@/lib/editors";
import { localGitSource } from "@/lib/gitSource";
import { changedSince, useFileSource } from "@/lib/workspaceFiles";
import { EditorPane } from "./EditorPane";
import { MediaPane } from "./MediaPane";

/** Keep each surface mounted: mode switches preserve the diff's scroll and the editor's buffer/undo. */
export function DiffEditorPane({ entry, visible }: { entry: DiffEditorEntry; visible: boolean }) {
  const { range, mode, scope, target, uncommitted, oldPath } = entry.diff;
  const source = useMemo(() => localGitSource(entry.root), [entry.root]);
  const files = useFileSource(undefined, entry.root);
  const kind = fileKind(entry.rel);
  const media = kind !== "text";
  const [pair, setPair] = useState<{ before: string; after: string; deleted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [changed, setChanged] = useState(false);
  const [split, setSplit] = useState(false);
  const [entire, setEntire] = useState(mode === "entire");
  const [editing, setEditing] = useState(mode === "edit");
  const [previewed, setPreviewed] = useState(mode === "preview");
  useEffect(() => { if (mode === "entire") setEntire(true); if (mode === "edit") setEditing(true); if (mode === "preview") setPreviewed(true); }, [mode]);
  const fileEntry: FileEditorEntry = { ...entry, kind, name: entry.rel.split("/").pop() ?? entry.rel, viewMode: "source" };

  useEffect(() => {
    if (!range || media) return;
    let cancelled = false;
    setPair(null);
    setError(null);
    void (async () => {
      const next = await source.fileContentsAt(entry.rel, range.base, range.head);
      // Turn chips carry a path, not Git's rename metadata. Recover the old
      // name when the destination did not exist at the start of the turn.
      const previousPath = oldPath ?? (next.before === null && next.after !== null
        ? (await source.changesBetween(range.base, range.head)).find((file) => file.path === entry.rel)?.oldPath
        : undefined);
      const before = previousPath ? (await source.fileContentsAt(previousPath, range.base, range.head)).before : next.before;
      if (before === null && next.after === null) throw new Error("This file is not present in either snapshot.");
      if (!cancelled) setPair({ before: before ?? "", after: next.after ?? "", deleted: next.after === null });
    })().catch((e) => { if (!cancelled) setError(source.errorMessage(e)); });
    return () => { cancelled = true; };
  }, [source, entry.rel, range?.base, range?.head, oldPath, media]);

  // Warn as soon as a snapshot differs from the working file, and when it moves on later.
  useEffect(() => {
    if (!visible || !files) return;
    let cancelled = false;
    let checking = false;
    let initial: Awaited<ReturnType<typeof files.stat>> | undefined;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const now = await files.stat(entry.rel);
        if (initial === undefined) {
          initial = now;
          let differs = false;
          if (pair && !media) {
            if (now === null) differs = !pair.deleted;
            else if (pair.after !== "<file too large to show>") {
              const working = await files.readText(entry.rel);
              differs = !working.truncated && !working.binary && working.content !== pair.after;
            }
          }
          if (!cancelled) setChanged(!!differs);
        } else if (!cancelled && (initial === null ? now !== null : changedSince(initial, now))) setChanged(true);
      } catch { /* The file surface reports read failures when opened. */ }
      finally { checking = false; }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    window.addEventListener("focus", check);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", check); };
  }, [visible, files, entry.rel, pair, media]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const next = await source.reviewRange(target ?? null, uncommitted ?? false);
      const changes = await source.changesBetween(next.base, next.head);
      updateDiffRange(entry.id, next, changes.find((f) => f.path === entry.rel)?.oldPath);
    } catch (e) { setError(source.errorMessage(e)); }
    finally { setRefreshing(false); }
  };
  const binary = pair?.before.includes("\0") || pair?.after.includes("\0");
  const canEdit = !media && !binary && !!pair && !pair.deleted;
  const modes: { value: DiffMode; label: string }[] = [{ value: "diff", label: "Diff" }, { value: "entire", label: "Entire file" }];
  if (media || isMarkdown(entry.rel)) modes.push({ value: "preview", label: "Preview" });
  if (canEdit) modes.push({ value: "edit", label: "Edit" });

  return <div className="flex h-full min-h-0 flex-col" data-testid="diff-editor">
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-hairline px-3 py-1">
      <Segmented aria-label="Diff view" value={mode} onChange={(next) => void setDiffMode(entry.id, next)} options={modes} />
      <span className="ml-auto truncate text-xs text-faint" title={entry.rel}>{entry.rel}</span>
      {mode === "diff" && !media && <Button variant="ghost" size="icon-xs" aria-label={split ? "Unified diff" : "Split diff"} onClick={() => setSplit((v) => !v)}>{split ? <Rows2 /> : <Columns2 />}</Button>}
      {scope === "all" && <Button variant="ghost" size="icon-xs" aria-label="Refresh diff" disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={cn(refreshing && "animate-spin")} /></Button>}
    </div>
    {changed && <div role="status" className="shrink-0 bg-warning/10 px-3 py-2 text-xs">This file changed on disk or differs from this snapshot. Edit and media preview use the current file.</div>}
    {error && <div role="alert" className="px-3 py-2 text-xs text-destructive">{error}</div>}
    <div className="relative min-h-0 flex-1">
      {(["diff", ...(entire ? ["entire" as const] : [])] as const).map((surface) => <div key={surface} className={cn("absolute inset-0", mode !== surface && "hidden")}>
        {!range ? <p className="p-4 text-sm text-muted-foreground">No snapshots are available for this turn. Open All changes in the Changes panel to review the workspace.</p>
          : media || binary ? <p className="p-4 text-sm text-muted-foreground">Binary file changed.{media && " Choose Preview to view the current file."}</p>
          : pair ? <DiffPane path={entry.rel} before={pair.before} after={pair.after} mode={surface === "entire" ? "entire" : split ? "split" : "unified"} />
          : !error && <p role="status" className="p-4 text-sm text-muted-foreground">Loading file diff…</p>}
      </div>)}
      {previewed && <div className={cn("absolute inset-0", mode !== "preview" && "hidden")}>
        {media ? <MediaPane entry={fileEntry} visible={visible && mode === "preview"} /> : <div className="h-full overflow-auto scrollbar-thin px-6 py-4 select-text"><Markdown text={pair?.after ?? ""} className="prose-chat" linkContext={editorLinkContext(entry)} /></div>}
      </div>}
      {editing && <div className={cn("absolute inset-0", mode !== "edit" && "hidden")}><EditorPane entry={fileEntry} visible={visible && mode === "edit"} embedded /></div>}
    </div>
  </div>;
}
