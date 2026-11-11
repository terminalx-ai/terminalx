import { useEffect, useState } from "react";
import { api, errorMessage, type TurnCheckpoint, type TurnUndoResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { openChatLink, type ChatLinkContext } from "@/lib/chatLinks";
import { openDiff, reviewPath } from "@/lib/editors";
import type { ChangeRange } from "@/lib/changes";
import { fileName, shortPath } from "@/lib/paths";
import type { TurnFileChange } from "@/lib/turnChanges";
import { File } from "@/icons";
import { useDisclosure } from "./disclosures";

/** Chips shown before the rest fold into "+N more"; a list one longer than this shows whole. */
const SHOWN = 2;

/**
 * What a finished turn changed, under its answer: a chip per file with its
 * lines added and removed, the rest folded into one "+N more" chip that
 * shows them. A file's chip opens its turn diff in a centre tab, deleted files
 * included; without the turn's snapshots it opens the file. A setting turns the row off.
 */
export function TurnChanges({ changes: fallback, cwd, linkContext, checkpoint, range = null }: { changes: TurnFileChange[]; cwd?: string; linkContext?: ChatLinkContext; checkpoint?: { sessionId: string; tabId: string; seq: number }; range?: ChangeRange | null }) {
  const [saved, setSaved] = useState<TurnCheckpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlap, setOverlap] = useState<(TurnUndoResult & { action: "undo" | "restore" }) | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setError(null);
    setOverlap(null);
    if (checkpoint) void api.turnCheckpoint(checkpoint.sessionId, checkpoint.tabId, checkpoint.seq)
      .then((value) => { if (!cancelled) setSaved(value); })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, [checkpoint?.sessionId, checkpoint?.tabId, checkpoint?.seq]);
  const changes: TurnFileChange[] = saved ? saved.files.map((f) => ({ path: f.path, kind: f.status === "added" ? "create" : f.status === "deleted" ? "delete" : "update", added: f.additions, removed: f.deletions })) : fallback;
  const review = async (action: "keep" | "undo" | "restore", confirmed: string | null = null) => {
    if (!checkpoint || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { sessionId, tabId, seq } = checkpoint;
      let backupRef: string | null = null;
      if (action === "keep") await api.keepTurn(sessionId, tabId, seq);
      else {
        const result = await (action === "restore" ? api.restoreUndo : api.undoTurn)(sessionId, tabId, seq, confirmed);
        if (!result.undone) { setOverlap({ ...result, action }); return; }
        backupRef = result.backupRef ?? null;
        window.dispatchEvent(new Event("workspace-files-changed"));
      }
      setOverlap(null);
      setSaved((value) => value ? { ...value, reviewed: true, undone: action === "undo", restored: action === "restore", backupRef } : value);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const [all, setAll] = useDisclosure("changes");
  if (!changes.length && !error && !saved?.unavailableReason) return null;
  const folded = !all && changes.length > SHOWN + 1;
  const shown = folded ? changes.slice(0, SHOWN) : changes;
  const rest = changes.slice(SHOWN);
  const sum = (list: TurnFileChange[], key: "added" | "removed") => list.reduce((n, c) => n + c[key], 0);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="turn-changes" aria-label="Files changed in this turn">
      {shown.map((change) => {
        const rel = linkContext ? reviewPath(linkContext.cwd, change.path) : null;
        const diffable = !!rel && !!range;
        const label = `${shortPath(change.path, cwd)}${change.kind === "create" ? " (new)" : change.kind === "delete" ? " (deleted)" : ""}`;
        return (
          <Chip
            key={change.path}
            title={label}
            icon={<FileTypeIcon name={fileName(change.path)} isDir={false} size={14} />}
            name={fileName(change.path)}
            added={change.added}
            removed={change.removed}
            deleted={change.kind === "delete"}
            onClick={linkContext && (diffable || change.kind !== "delete") ? () => {
              setError(null);
              try {
                if (rel && range) openDiff(linkContext.sessionId, linkContext.cwd, rel, { scope: "turn", range, turnLabel: "Turn" });
                else void openChatLink({ kind: "local", href: change.path, path: change.path }, linkContext).catch((e) => setError(errorMessage(e)));
              } catch (e) { setError(errorMessage(e)); }
            } : undefined}
          />
        );
      })}
      {saved && changes.length > 0 && !saved.reviewed && !saved.unavailableReason && <div className="flex gap-1">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void review("undo")}>Undo</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void review("keep")}>Keep</Button>
      </div>}
      {saved?.reviewed && <span role="status" className="text-xs text-muted-foreground">{saved.undone ? "Undone" : saved.restored ? "Restored" : "Kept"}</span>}
      {saved?.undone && saved.backupRef && <Button size="sm" variant="ghost" disabled={busy} title={`Backup: ${saved.backupRef}`} onClick={() => void review("restore")}>Restore what Undo removed</Button>}
      {saved?.unavailableReason && <p role="status" className="w-full text-xs text-muted-foreground">{saved.unavailableReason}</p>}
      {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
      <Dialog open={!!overlap} onOpenChange={(open) => { if (!open && !busy) setOverlap(null); }}>
        <DialogContent showClose={!busy}>
          <DialogTitle>{overlap?.action === "restore" ? "Restore what Undo removed?" : `Undo turn ${saved?.number}?`}</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">{overlap?.action === "restore"
            ? "These files changed after Undo. Restoring the backup will replace those newer changes."
            : "Other tabs or sessions worked on these files during this turn, or later turns or your own edits changed them. Undo will replace those changes with the versions from before this turn."}</DialogDescription>
          <ul className="mt-3 max-h-48 overflow-auto text-sm font-mono">{overlap?.overlap.map((path) => <li key={path}>{path}</li>)}</ul>
          {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setOverlap(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => overlap && void review(overlap.action, overlap.token)}>{overlap?.action === "restore" ? "Restore anyway" : "Undo anyway"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {folded && (
        <Chip
          icon={<File className="size-3.5 text-muted-foreground" />}
          name={`+${rest.length} more`}
          added={sum(rest, "added")}
          removed={sum(rest, "removed")}
          onClick={() => setAll(true)}
        />
      )}
    </div>
  );
}

function Chip({ icon, name, added, removed, deleted, title, onClick }: { title?: string; icon: React.ReactNode; name: string; added: number; removed: number; deleted?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={!onClick}
      className="flex h-7 max-w-[16rem] items-center gap-1.5 rounded-md px-2 text-[12.5px] ring-1 ring-hairline-strong transition-colors enabled:hover:bg-veil-raised disabled:cursor-default"
    >
      {icon}
      <span className={deleted ? "min-w-0 truncate text-muted-foreground line-through" : "min-w-0 truncate text-muted-foreground"}>{name}</span>
      <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
        {added > 0 && <span className="text-add">+{added}</span>}
        {added > 0 && removed > 0 && " "}
        {removed > 0 && <span className="text-destructive">−{removed}</span>}
      </span>
    </button>
  );
}
