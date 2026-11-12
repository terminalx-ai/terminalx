import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, Sparkles, TriangleAlert } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { closeEditor, setConflictCount, type ConflictEditorEntry } from "@/lib/editors";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { relativeTime } from "@/lib/time";
import { changedSince, useFileSource, type FileSource, type FileState } from "@/lib/workspaceFiles";
import type { ConflictChoice, ConflictFile, ConflictHunk, ConflictSide, UnfinishedMerge } from "@/types/session";
import { combineConflictPrompt } from "./conflictPrompts";
import { useAgentTab } from "./useAgentTab";

/** What "Ask the agent to combine them" sends, said plainly: the agent's answer cannot be predicted here. */
export const COMBINE_SENDS = "Sends this conflict, both sides and their branches to the agent. Other conflicts and staging stay with you.";

/** The lines of a piece of the file, without their endings; a final line ending starts no new line. */
function lines(text: string): string[] {
  if (!text) return [];
  const all = text.split(/\r?\n/);
  if (all[all.length - 1] === "") all.pop();
  return all;
}

/** "2h ago", "just now", or the date for an older commit. */
function age(seconds: number): string {
  const said = relativeTime(new Date(seconds * 1000).toISOString());
  return said === "now" ? "just now" : /^\d+[mhd]$/.test(said) ? `${said} ago` : said;
}

function yoursMeta(side: ConflictSide): string {
  return [side.branch, side.commit && age(side.commit.time)].filter(Boolean).join(" · ");
}

function theirsMeta(side: ConflictSide): string {
  const commit = side.commit;
  return [side.branch, commit && (commit.pr != null ? `#${commit.pr} ${commit.subject}` : commit.subject), commit?.author].filter(Boolean).join(" · ");
}

type Row = { kind: "line"; line: number; text: string } | { kind: "conflict"; hunk: ConflictHunk; position: number; at: number };

/**
 * The file as rows, numbered as it reads with every conflict marker gone
 * and yours kept: both sides of a conflict start on the line it takes, and
 * the text after it goes on from the end of yours (the 05.11 screen).
 */
function rowsOf(file: ConflictFile): Row[] {
  const rows: Row[] = [];
  let line = 1;
  let position = 0;
  for (const segment of file.segments) {
    if (segment.kind === "text") {
      for (const text of lines(segment.text)) rows.push({ kind: "line", line: line++, text });
      continue;
    }
    rows.push({ kind: "conflict", hunk: segment.hunk, position: position++, at: line });
    line += lines(segment.hunk.ours).length;
  }
  return rows;
}

function CodeLine({ line, text, className }: { line: number; text: string; className?: string }) {
  return <div className={cn("flex font-mono text-xs leading-5", className)}>
    <span aria-hidden className="w-12 shrink-0 select-none pr-3 text-right text-faint tabular-nums">{line}</span>
    <span className="min-w-0 whitespace-pre-wrap break-all text-foreground/90">{text || " "}</span>
  </div>;
}

function SideBlock({ label, meta, text, at, tone, action }: { label: string; meta: string; text: string; at: number; tone: "ours" | "theirs"; action?: ReactNode }) {
  const body = lines(text);
  return <section aria-label={label} className={cn("overflow-hidden rounded-md border", tone === "ours" ? "border-info/40" : "border-merged/40")}>
    <div className={cn("flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-0.5 text-xs", tone === "ours" ? "bg-info/15 text-info" : "bg-merged/15 text-merged")}>
      <span className="font-medium">{label}</span>
      <span className="min-w-0 flex-1 truncate text-faint" title={meta}>{meta}</span>
      {action}
    </div>
    <div className={tone === "ours" ? "bg-info/5" : "bg-merged/5"}>
      {body.length ? body.map((text, i) => <CodeLine key={i} line={at + i} text={text} />)
        : <p className="py-0.5 pl-12 text-xs italic text-faint">Nothing on this side</p>}
    </div>
  </section>;
}

/**
 * A conflicted file of the merge in progress, in a centre tab (PRO-293):
 * the file with its line numbers, each conflict as Yours and Theirs, kept
 * one side, both, or combined by the agent, and staged with Mark resolved.
 *
 * Every write names the version of the file it was read at; one the file
 * moved on from is refused, said, and the file read again. A change on disk
 * (the agent, another editor) reads it again too, so no write goes out
 * against a version known to be old.
 */
export function ConflictView({ entry, visible, source: given, files: givenFiles }: {
  entry: ConflictEditorEntry;
  visible: boolean;
  /** The checkout's Git; the local one at `entry.root` when absent. */
  source?: GitSource;
  /** Its files, to notice a change on disk; the local checkout's when absent. */
  files?: FileSource;
}) {
  const source = useMemo(() => given ?? localGitSource(entry.root), [given, entry.root]);
  const localFiles = useFileSource(undefined, entry.root);
  const files = givenFiles ?? localFiles;
  const ask = useAgentTab(entry.sessionId);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; merge: UnfinishedMerge; file: ConflictFile }
    /** The merge it was opened for is not in progress any more (committed, aborted, or another one started). */
    | { kind: "gone" }
    /** The file is no longer conflicted: staged here or elsewhere. */
    | { kind: "resolved"; merge: UnfinishedMerge }
    | { kind: "unsupported-source" }
    | { kind: "failed"; error: string }
  >({ kind: "loading" });
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState<"write" | "mark" | "agent" | null>(null);
  /** Reading the file again after it changed: until that answers, nothing is written. */
  const [rereading, setRereading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  /** Only the newest read or write may set what is shown. */
  const generation = useRef(0);
  const disk = useRef<FileState | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const { head, mergeHead } = entry.conflict;
  const supported = !!source.unfinishedMerge && !!source.conflictFile && !!source.resolveConflict && !!source.markResolved;

  const baseline = useCallback(async () => {
    disk.current = files ? await files.stat(entry.rel).catch(() => null) : null;
  }, [files, entry.rel]);

  const show = useCallback((merge: UnfinishedMerge, file: ConflictFile) => {
    setState({ kind: "ready", merge, file });
    setConflictCount(entry.id, file.conflicts);
    setCurrent((at) => Math.max(0, Math.min(at, file.conflicts - 1)));
  }, [entry.id]);

  const read = useCallback(async () => {
    if (!supported) { setState({ kind: "unsupported-source" }); return; }
    const mine = ++generation.current;
    setRereading(true);
    try {
      const merge = await source.unfinishedMerge!();
      if (mine !== generation.current) return;
      if (!merge || merge.head !== head || merge.mergeHead !== mergeHead) { setState({ kind: "gone" }); return; }
      if (!merge.conflicted.includes(entry.rel)) { setState({ kind: "resolved", merge }); return; }
      const file = await source.conflictFile!(merge, entry.rel);
      await baseline();
      if (mine !== generation.current) return;
      show(merge, file);
    } catch (e) {
      if (mine === generation.current) setState({ kind: "failed", error: source.errorMessage(e) });
    } finally {
      if (mine === generation.current) setRereading(false);
    }
  }, [supported, source, head, mergeHead, entry.rel, baseline, show]);

  useEffect(() => { void read(); }, [read]);

  // The file changed on disk: the watcher says so, or (a local checkout) its stat moves while shown. Focus reads it again.
  useEffect(() => {
    if (!files) return;
    const check = async () => {
      const now = await files.stat(entry.rel).catch(() => undefined);
      if (now === undefined) return;
      if (!disk.current || changedSince(disk.current, now)) void read();
    };
    if (files.watch) return files.watch((paths) => { if (paths === null || paths.includes(entry.rel)) void read(); });
    if (!visible) return;
    const id = window.setInterval(() => void check(), 2000);
    return () => window.clearInterval(id);
  }, [files, entry.rel, visible, read]);
  useEffect(() => {
    if (!visible) return;
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, read]);

  const ready = state.kind === "ready" ? state : null;
  const rows = useMemo(() => ready ? rowsOf(ready.file) : [], [ready?.file]);
  const total = ready?.file.conflicts ?? 0;

  useEffect(() => {
    body.current?.querySelector(`[data-conflict="${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, ready?.file.version]);

  const keep = async (hunk: ConflictHunk, choice: ConflictChoice) => {
    if (!ready || busy || rereading) return;
    const mine = ++generation.current;
    setBusy("write");
    setError(null);
    try {
      const next = await source.resolveConflict!(ready.merge, ready.file, hunk.index, choice);
      await baseline();
      if (mine === generation.current) show(ready.merge, next);
      // Changes reads the merge again: the card's count for this file follows.
      window.dispatchEvent(new Event("workspace-files-changed"));
    } catch (e) {
      // Refused (the file moved on since it was read) or failed: say so, and never keep the old version in use.
      setError(source.errorMessage(e));
      void read();
    } finally {
      setBusy(null);
    }
  };

  const markResolved = async () => {
    if (!ready || busy || rereading) return;
    setBusy("mark");
    setError(null);
    try {
      await source.markResolved!(ready.merge, ready.file);
    } catch (e) {
      setError(source.errorMessage(e));
    } finally {
      setBusy(null);
      // Changes reads the merge again: the card counts one file fewer.
      window.dispatchEvent(new Event("workspace-files-changed"));
      void read();
    }
  };

  const noAgent = ask.unavailable;
  const combine = async (hunk: ConflictHunk) => {
    if (!ready || busy || noAgent) return;
    setBusy("agent");
    setError(null);
    setSent(null);
    try {
      const result = await ask.send(combineConflictPrompt(ready.file, hunk));
      setSent(result.queued ? `Conflict ${hunk.index + 1} queued in the agent tab.` : `Conflict ${hunk.index + 1} sent to the agent tab.`);
    } catch (e) {
      setError(source.errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const canMark = !!ready && ready.file.conflicts === 0 && ready.file.unsupported === null;
  const writing = !!busy || rereading;

  return <div className="flex h-full min-h-0 flex-col bg-background" data-testid="conflict-view">
    <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-3 py-1.5">
      <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 truncate font-mono text-[12.5px]" title={entry.rel}>{entry.rel}</span>
      {ready && <span className="min-w-0 truncate text-xs text-faint">{ready.file.theirs.branch} into {ready.file.ours.branch}</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {ready && total > 0 && <>
          <span className="whitespace-nowrap text-xs text-muted-foreground" aria-live="polite">Conflict {Math.min(current, total - 1) + 1} of {total}</span>
          <Button variant="ghost" size="icon-xs" aria-label="Previous conflict" disabled={current <= 0} onClick={() => setCurrent((at) => Math.max(0, at - 1))}><ChevronUp /></Button>
          <Button variant="ghost" size="icon-xs" aria-label="Next conflict" disabled={current >= total - 1} onClick={() => setCurrent((at) => Math.min(total - 1, at + 1))}><ChevronDown /></Button>
        </>}
        {ready && total === 0 && <span className="whitespace-nowrap text-xs text-muted-foreground">No conflicts left</span>}
        <Button variant={canMark ? "default" : "outline"} size="sm" className="border" disabled={!canMark || writing}
          title={!ready ? undefined : ready.file.unsupported ? "This file is resolved as a whole, not here." : !canMark ? "Resolve every conflict first." : undefined}
          onClick={() => void markResolved()}>
          {busy === "mark" ? <Loader2 className="animate-spin" /> : <Check />} Mark resolved
        </Button>
      </div>
    </header>
    {error && <div role="alert" className="mx-3 mt-2 shrink-0 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
    {sent && <div role="status" className="mx-3 mt-2 shrink-0 rounded-md bg-well px-2 py-1 text-xs text-muted-foreground">{sent}</div>}
    <div ref={body} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2 scrollbar-thin">
      {state.kind === "loading" && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Reading the conflicts…</p>}
      {state.kind === "failed" && <div role="alert" className="mx-3 space-y-2 text-xs">
        <p className="text-destructive">The conflicts could not be read: {state.error}</p>
        <Button size="sm" variant="outline" className="border" onClick={() => void read()}>Read again</Button>
      </div>}
      {state.kind === "unsupported-source" && <p className="px-3 py-2 text-xs text-muted-foreground">This workspace cannot resolve conflicts in the app. Resolve them in its terminal.</p>}
      {state.kind === "gone" && <Ended entryId={entry.id} text="The merge this file was conflicted in is no longer in progress: it was committed or aborted." />}
      {state.kind === "resolved" && <Ended entryId={entry.id} text={`${entry.rel} is resolved and staged. Commit the merge from Changes once every conflict is resolved.`} />}
      {ready && ready.file.unsupported && <div role="note" className="mx-3 mb-2 flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-xs">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        <span>This file cannot be resolved conflict by conflict: {ready.file.unsupported}. Resolve it in the terminal, or ask the agent from Changes.</span>
      </div>}
      {ready && rows.map((row) => row.kind === "line" ? <CodeLine key={`l${row.line}`} line={row.line} text={row.text} /> : (() => {
        const { hunk, position } = row;
        const on = position === Math.min(current, total - 1);
        const file = ready.file;
        return <div key={`c${hunk.index}:${hunk.line}`} data-conflict={position} aria-label={`Conflict ${position + 1} of ${total}, line ${row.at}`} role="group"
          className={cn("mx-3 my-1 grid gap-2", !on && "cursor-pointer opacity-70")} onClick={on ? undefined : () => setCurrent(position)}>
          <SideBlock label="Yours" tone="ours" at={row.at} text={hunk.ours} meta={on ? yoursMeta(file.ours) : file.ours.branch}
            action={on && <Button variant="outline" size="sm" className="ml-auto border" disabled={writing} onClick={() => void keep(hunk, "ours")}>Keep yours</Button>} />
          <SideBlock label="Theirs" tone="theirs" at={row.at} text={hunk.theirs} meta={on ? theirsMeta(file.theirs) : file.theirs.branch}
            action={on && <Button variant="outline" size="sm" className="ml-auto border" disabled={writing} onClick={() => void keep(hunk, "theirs")}>Keep theirs</Button>} />
          {on && <div className="flex flex-wrap items-center gap-2 py-0.5">
            <Button variant="outline" size="sm" className="border" disabled={writing} onClick={() => void keep(hunk, "both")}>Keep both</Button>
            <Button size="sm" disabled={writing || !!noAgent} title={noAgent ?? undefined} onClick={() => void combine(hunk)}>
              {busy === "agent" ? <Loader2 className="animate-spin" /> : <Sparkles />} Ask the agent to combine them
            </Button>
            <span className="min-w-0 basis-60 flex-1 text-xs text-faint">{noAgent ?? COMBINE_SENDS}</span>
          </div>}
        </div>;
      })())}
    </div>
  </div>;
}

function Ended({ entryId, text }: { entryId: string; text: string }) {
  return <div role="status" className="mx-3 space-y-2 py-2 text-xs text-muted-foreground">
    <p>{text}</p>
    <Button size="sm" variant="outline" className="border" onClick={() => void closeEditor(entryId)}>Close tab</Button>
  </div>;
}
