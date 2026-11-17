import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { GitSource } from "@/lib/gitSource";
import type { ChangedFile, ChangeStatus } from "@/types/session";

/** The file a discard is asked about: its path, and what the list knows of its change. */
export interface DiscardTarget {
  path: string;
  oldPath?: string;
  status?: ChangeStatus;
  additions?: number;
  deletions?: number;
}

const lines = (count: number) => (count === 1 ? "line" : "lines");

/**
 * What discarding does, in the design's words (17.01): "4 added and 1 removed
 * line go back to the last commit. This can't be undone." The counts are the
 * file list's own; a change it has no counts for (a binary file, a mode
 * change, an older runtime) is said without them.
 */
export function discardSummary(file: DiscardTarget, base?: string | null): string {
  const to = base ? "the comparison’s starting version" : "the last commit";
  const added = file.additions ?? 0;
  const removed = file.deletions ?? 0;
  let what: string;
  if (added > 0 && removed > 0) what = `${added} added and ${removed} removed ${lines(removed)} go back to ${to}.`;
  else if (added > 0) what = `${added} added ${lines(added)} ${added === 1 ? "goes" : "go"} back to ${to}.`;
  else if (removed > 0) what = `${removed} removed ${lines(removed)} ${removed === 1 ? "goes" : "go"} back to ${to}.`;
  else what = `Its changes, staged ones included, go back to ${to}.`;
  // What the counts alone do not say: a file that version does not have is deleted, and a rename is undone.
  if (file.status === "added") what += " The file is not in that version, so it is deleted.";
  else if (file.oldPath) what += ` It goes back to ${file.oldPath}.`;
  return `${what} This can’t be undone.`;
}

/**
 * What discarding `path` from the working tree undoes. A discard puts the index and the file both back to the last
 * commit, so it is described from both sides of the index, not from whichever list the row came from.
 *
 * A file on one side only is that record: its counts are the file's against the last commit. A file on both sides
 * (staged, then edited again) has no such count: the staged one is commit to index and the other index to file, and
 * neither is what goes back. None is claimed then, and what the index knows is kept: a file staged as new is not in
 * the last commit, so it is deleted, and a staged rename is undone to its old path.
 */
export function workingDiscardTarget(path: string, staged: ChangedFile[], unstaged: ChangedFile[]): DiscardTarget | null {
  const inIndex = staged.find((file) => file.path === path);
  const inTree = unstaged.find((file) => file.path === path);
  if (!inIndex || !inTree) return inIndex ?? inTree ?? null;
  return {
    path,
    oldPath: inIndex.oldPath ?? inTree.oldPath,
    status: inIndex.status === "added" || inIndex.status === "renamed" ? inIndex.status : "modified",
  };
}

/** Shared by the file list and the diff header. The base is exactly the one being reviewed. */
export function DiscardDialog({ source, file, base, onClose, onDiscarded }: {
  source: GitSource;
  file: DiscardTarget | null;
  base?: string | null;
  onClose: () => void;
  onDiscarded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The card names its file while it animates out, after the caller has let go of it.
  const last = useRef(file);
  if (file) last.current = file;
  const shown = file ?? last.current;
  const discard = async () => {
    if (!file || !source.discard || busy) return;
    setBusy(true);
    setError(null);
    try {
      await source.discard(file.path, base, file.oldPath);
      window.dispatchEvent(new Event("workspace-files-changed"));
      onDiscarded();
      onClose();
    } catch (e) { setError(source.errorMessage(e)); }
    finally { setBusy(false); }
  };
  return (
    <ConfirmDialog
      open={!!file}
      title={`Discard changes to ${shown?.path ?? "this file"}?`}
      action={busy ? "Discarding…" : "Discard"}
      destructive
      busy={busy}
      error={error}
      onAction={() => void discard()}
      onCancel={() => { setError(null); onClose(); }}
    >
      {shown ? discardSummary(shown, base) : null}
    </ConfirmDialog>
  );
}

export function DiscardButton({ path, onClick }: { path: string; onClick: () => void }) {
  return <Button size="sm" variant="ghost" aria-label={`Discard changes to ${path}`} onClick={onClick}>Discard</Button>;
}
