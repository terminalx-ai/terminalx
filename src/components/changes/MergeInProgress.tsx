import { useState } from "react";
import { GitMerge, Info, Loader2, Sparkles, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import type { GitSource } from "@/lib/gitSource";
import { dirName, fileName } from "@/lib/paths";
import type { ChangedFile, UnfinishedMerge } from "@/types/session";
import { mergeInto, mergeName, resolveMergePrompt } from "./conflictPrompts";
import { useAgentTab } from "./useAgentTab";

export { mergeName } from "./conflictPrompts";

const short = (commit: string) => commit.slice(0, 7);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface MergeGroup {
  key: "conflicted" | "here" | "base";
  title: string;
  files: ChangedFile[];
}

/**
 * The uncommitted files of a merge in progress, by what they are. Only a
 * file the merge was read as taking unchanged from the base is said to come
 * from it; any other, one the merge was read without included, is changed here.
 */
export function mergeGroups(merge: UnfinishedMerge, files: ChangedFile[]): MergeGroup[] {
  const conflicted = new Set(merge.conflicted);
  const fromBase = new Set(merge.fromBase);
  const groups: MergeGroup[] = [
    { key: "conflicted", title: "Unresolved conflicts", files: files.filter((f) => conflicted.has(f.path)) },
    { key: "here", title: "Changed here", files: files.filter((f) => !conflicted.has(f.path) && !fromBase.has(f.path)) },
    { key: "base", title: "Brought in by the merge", files: files.filter((f) => fromBase.has(f.path)) },
  ];
  return groups.filter((group) => group.files.length > 0);
}

/** Up to three paths, then how many more. */
function some(paths: string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

const LETTER: Record<ChangedFile["status"], { letter: string; tone: string; word: string }> = {
  added: { letter: "A", tone: "text-add", word: "Added" },
  modified: { letter: "M", tone: "text-warning", word: "Modified" },
  deleted: { letter: "D", tone: "text-destructive", word: "Deleted" },
  renamed: { letter: "R", tone: "text-info", word: "Renamed" },
};

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[.08em] text-faint">{children}</h3>;
}

/** A row of the merge's lists: badge, name, directory, and what is on the right. Clickable when it opens something. */
function Row({ badge, path, title, trailing, onOpen, current = false }: { badge: React.ReactNode; path: string; title: string; trailing: React.ReactNode; onOpen?: () => void;
  /** Its tab is the one being looked at. */
  current?: boolean }) {
  const inner = <>
    {badge}
    <span className="min-w-0 shrink truncate font-mono text-[12.5px]">{fileName(path)}</span>
    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{dirName(path)}</span>
    <span className="ml-auto shrink-0 whitespace-nowrap">{trailing}</span>
  </>;
  const className = "flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left";
  return onOpen
    ? <button type="button" title={title} aria-current={current ? "page" : undefined}
      className={cn(className, "outline-none focus-visible:ring-2 focus-visible:ring-ring/40", current ? "bg-selected" : "hover:bg-selected/50")} onClick={onOpen}>{inner}</button>
    : <div title={title} className={className}>{inner}</div>;
}

function FileRows({ files, onOpenFile }: { files: ChangedFile[]; onOpenFile?: (file: ChangedFile) => void }) {
  return <div className="flex flex-col">{files.map((file) => {
    const status = LETTER[file.status];
    return <Row key={file.path} path={file.path} title={`${status.word} · ${file.path}`} onOpen={onOpenFile && (() => onOpenFile(file))}
      badge={<span className={cn("w-3 shrink-0 font-mono text-[11px]", status.tone)} aria-label={status.word}>{status.letter}</span>}
      trailing={<span className="font-mono text-xs tabular-nums">
        {file.additions > 0 && <span className="text-add">+{file.additions}</span>}{" "}
        {file.deletions > 0 && <span className="text-destructive">−{file.deletions}</span>}
      </span>} />;
  })}</div>;
}

/**
 * A merge started in this checkout and not finished (#736, PRO-293): what it
 * merges into which branch, its conflicted files with how many conflicts each
 * holds (each opens in a centre tab to resolve), what was changed here, what
 * it brought in, and Ask the agent to resolve, Commit merge or Abort merge.
 * Both act on exactly the merge that was read; one that moved on since is refused.
 */
export function MergeInProgress({ source, merge, files, allChanges, sessionId, onChanged, onOpenConflict, onOpenFile, openPath = null }: {
  source: GitSource;
  merge: UnfinishedMerge;
  /** The uncommitted files, as Git reports them against HEAD. */
  files: ChangedFile[];
  /** The scope shown counts the merge's files as this branch's own work. */
  allChanges: boolean;
  /** The session whose agent tab is asked to resolve; none for a checkout without one. */
  sessionId?: string;
  /** The checkout changed: read it again. */
  onChanged: () => void;
  /** Open a conflicted file to resolve it; absent where the source cannot. */
  onOpenConflict?: (path: string) => void;
  onOpenFile?: (file: ChangedFile) => void;
  /** The conflicted file whose tab is being looked at, to mark its row. */
  openPath?: string | null;
}) {
  const [busy, setBusy] = useState<"commit" | "abort" | "agent" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const ask = useAgentTab(sessionId);
  const what = mergeName(merge);
  const conflicts = merge.conflicted.length;
  const canAct = source.canWrite && !!source.commitMerge && !!source.abortMerge;
  const resolvesHere = source.canWrite && !!source.conflictFile;
  const act = async (which: "commit" | "abort", work: () => Promise<void>) => {
    setBusy(which);
    setError(null);
    try {
      await work();
      setConfirming(false);
    } catch (e) {
      setError(source.errorMessage(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  const askToResolve = async () => {
    if (busy || ask.unavailable) return;
    setBusy("agent");
    setError(null);
    setSent(null);
    try {
      const { queued } = await ask.send(resolveMergePrompt(merge));
      setSent(queued ? "Queued in the agent tab." : "Sent to the agent tab.");
    } catch (e) {
      setError(source.errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const changed = [...merge.conflicted, ...merge.changedHere];
  const groups = mergeGroups(merge, files);
  const here = groups.find((group) => group.key === "here")?.files ?? [];
  const base = groups.find((group) => group.key === "base")?.files ?? [];

  return <div className="text-xs">
    <section aria-label="Merge in progress" className="mx-3 mt-2 grid gap-1.5 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <GitMerge className="size-3.5 shrink-0 text-warning" aria-hidden />
        <span className="text-[13px] font-medium text-foreground">Merge in progress</span>
      </div>
      <p className="-mt-1 truncate pl-[22px] font-mono text-xs text-faint" title={`${what} → ${mergeInto(merge)}`}>{what} → {mergeInto(merge)}</p>
      <p className="text-xs text-muted-foreground">{conflicts > 0
        ? resolvesHere ? "Resolve the conflicts and stage them to commit the merge, or ask the agent to do it." : "Resolve the conflicts and stage them to commit the merge."
        : "Every conflict is resolved. Commit the merge to finish it."}</p>
      {allChanges && <p className="text-xs text-muted-foreground">Until it is committed, this counts what the merge brings in as the branch's own work. Uncommitted changes tells them apart.</p>}
      {error && <div role="alert" className="rounded bg-destructive/10 px-2 py-1 text-destructive">{error}</div>}
      {sent && <div role="status" className="rounded bg-well px-2 py-1 text-muted-foreground">{sent}</div>}
      {(canAct || (resolvesHere && conflicts > 0)) && <div className="mt-1 flex flex-wrap gap-2">
        {conflicts > 0 && resolvesHere && <Button size="sm" disabled={!!busy || !!ask.unavailable} title={ask.unavailable ?? undefined} onClick={() => void askToResolve()}>
          {busy === "agent" ? <Loader2 className="animate-spin" /> : <Sparkles />} Ask the agent to resolve
        </Button>}
        {canAct && (conflicts === 0 || !resolvesHere) && <Button size="sm" variant={conflicts === 0 ? "default" : "outline"} className="border" disabled={conflicts > 0 || !!busy} onClick={() => void act("commit", () => source.commitMerge!(merge))}>
          {busy === "commit" ? <Loader2 className="animate-spin" /> : <GitMerge />} Commit merge
        </Button>}
        {canAct && <Button size="sm" variant="outline" className="border" disabled={!!busy} onClick={() => setConfirming(true)}><X /> Abort merge…</Button>}
      </div>}
      {conflicts > 0 && resolvesHere && ask.unavailable && <p className="text-xs text-faint">{ask.unavailable}</p>}
    </section>

    {conflicts > 0 && <section aria-label="Unresolved conflicts">
      <Heading>Unresolved conflicts · {conflicts}</Heading>
      <div className="flex flex-col">{merge.conflicted.map((path) => {
        const n = merge.conflictCounts[path] ?? 0;
        return <Row key={path} path={path} title={`Unresolved · ${path}`} onOpen={onOpenConflict && (() => onOpenConflict(path))} current={!!onOpenConflict && openPath === path}
          badge={<span className="w-3 shrink-0 font-mono text-[11px] text-destructive" aria-label="Unresolved">U</span>}
          trailing={<span className="text-[11.5px] text-warning">{n > 0 ? count(n, "conflict", "conflicts") : "Whole file"}</span>} />;
      })}</div>
    </section>}
    {here.length > 0 && <section aria-label="Changed here">
      <Heading>Changed here · {here.length}</Heading>
      <FileRows files={here} onOpenFile={onOpenFile} />
    </section>}
    {base.length > 0 && <section aria-label="Brought in by the merge">
      <Heading>Brought in by the merge · {base.length}</Heading>
      <FileRows files={base} onOpenFile={onOpenFile} />
    </section>}
    {canAct && <p className="mx-3 mt-3 flex items-start gap-1.5 text-[11.5px] text-faint">
      <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>Aborting puts the branch back at {short(merge.head)} and keeps your uncommitted work.</span>
    </p>}

    <Dialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Abort the merge of {what}?</DialogTitle>
          <DialogDescription>The checkout goes back to {short(merge.head)}, as it was before the merge (git merge --abort).</DialogDescription>
        </DialogHeader>
        <ul aria-label="What aborting does" className="ml-5 list-disc space-y-1 text-[13px]">
          {changed.length > 0 && <li className="text-warning">What was done while merging is lost, in {some(changed)}.</li>}
          {merge.fromBase.length > 0 && <li>{count(merge.fromBase.length, "file", "files")} from {what} leave the checkout. {what} still has them.</li>}
          <li className="text-muted-foreground">Untracked files stay. Git changes nothing if aborting would throw away an edit it cannot put back.</li>
        </ul>
        {error && <div role="alert" className="mt-3 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" disabled={!!busy} onClick={() => setConfirming(false)}>Keep the merge</Button>
          <Button variant="destructive" disabled={!!busy} onClick={() => void act("abort", () => source.abortMerge!(merge))}>
            {busy === "abort" && <Loader2 className="animate-spin" />} Abort merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
