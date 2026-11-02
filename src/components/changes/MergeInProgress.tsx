import { useState } from "react";
import { GitMerge, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { GitSource } from "@/lib/gitSource";
import type { ChangedFile, UnfinishedMerge } from "@/types/session";

const short = (commit: string) => commit.slice(0, 7);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What is being merged, in a few words: `origin/main`, or `commit 1a2b3c4`. */
export function mergeName(merge: UnfinishedMerge): string {
  return merge.names[0] ?? `commit ${short(merge.mergeHead)}`;
}

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
    { key: "base", title: `From ${mergeName(merge)}, as Git merged them`, files: files.filter((f) => fromBase.has(f.path)) },
  ];
  return groups.filter((group) => group.files.length > 0);
}

/** Up to three paths, then how many more. */
function some(paths: string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

/**
 * A merge started in this checkout and not finished (#736): what it merges,
 * which of the uncommitted files are its own, and Commit merge or Abort merge.
 * Both act on exactly the merge that was read; one that moved on since is refused.
 */
export function MergeInProgress({ source, merge, allChanges, onChanged }: {
  source: GitSource;
  merge: UnfinishedMerge;
  /** The scope shown counts the merge's files as this branch's own work. */
  allChanges: boolean;
  /** The checkout changed: read it again. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"commit" | "abort" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const what = mergeName(merge);
  const conflicts = merge.conflicted.length;
  const canAct = source.canWrite && !!source.commitMerge && !!source.abortMerge;
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
  const parts = [
    merge.fromBase.length > 0 && `${count(merge.fromBase.length, "file", "files")} as Git merged ${merge.fromBase.length === 1 ? "it" : "them"}`,
    merge.changedHere.length > 0 && `${count(merge.changedHere.length, "file", "files")} changed here`,
    conflicts > 0 && `${count(conflicts, "file", "files")} with unresolved conflicts`,
  ].filter(Boolean);
  const changed = [...merge.conflicted, ...merge.changedHere];

  return (
    <section aria-label="Merge in progress" className="mx-3 mt-2 rounded-md bg-warning/10 px-2 py-1.5 text-xs">
      <div className="flex items-start gap-1.5">
        <GitMerge className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-foreground">Merging {what} into this branch: not committed yet.</p>
          <p className="text-muted-foreground">
            {short(merge.mergeHead)} brings in {count(merge.incoming, "commit", "commits")}.{parts.length ? ` ${parts.join(", ")}.` : ""}
          </p>
          {allChanges && <p className="text-muted-foreground">Until it is committed, this counts what the merge brings in as the branch's own work. Uncommitted changes tells them apart.</p>}
          {conflicts > 0 && <p className="text-muted-foreground">Resolve the conflicts and stage them to commit the merge.</p>}
        </div>
      </div>
      {error && <div role="alert" className="mt-1.5 rounded bg-destructive/10 px-2 py-1 text-destructive">{error}</div>}
      {canAct && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-5">
          <Button size="xs" variant="secondary" disabled={conflicts > 0 || !!busy} onClick={() => void act("commit", () => source.commitMerge!(merge))}>
            {busy === "commit" && <Loader2 className="animate-spin" />} Commit merge
          </Button>
          <Button size="xs" variant="ghost" disabled={!!busy} onClick={() => setConfirming(true)}>Abort merge…</Button>
        </div>
      )}
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
    </section>
  );
}
