import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Archive, GitMerge } from "@/icons";
import { api, errorMessage } from "@/lib/api";
import { bytesText } from "@/lib/cloudResources";
import { cn } from "@/lib/cn";
import { openWorkspaceDelete, openWorkspaceRemove } from "@/lib/dialogs";
import { holdMergedWorkspace, LOCAL_HOST, mergedDue, useMergedStatus } from "@/lib/mergedCleanup";

/**
 * The branch's last step, once its pull request has merged: archiving the session (design 05.12). Archiving runs the
 * archive script and removes the worktree; the chats stay searchable. It is said here, in the Branch tab, where the
 * reader already follows the branch to done, rather than in a notice over the conversation (docs/CLEANUP-PLACEMENT.md).
 *
 * Where clean-up archives merged sessions by itself, this says where that stands: archiving soon, skipped and why,
 * or kept by you; each button says what it does: Keep (clean-up stops asking), Archive anyway / Archive (the remove
 * dialog, which says what would be lost), Let clean-up archive it (undo a keep). Where it does not, `onArchive`
 * offers the same archive by hand.
 *
 * `embedded`: under the merged pull request's WHAT NEXT, which already says it merged.
 */
export function MergedWorkspaceStep({ cwd, embedded = false, onArchive }: { cwd: string; embedded?: boolean; onArchive?: () => void }) {
  const status = useMergedStatus(LOCAL_HOST, cwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What archiving frees, for good: its whole folder, build output included. Measured once it has merged.
  const [size, setSize] = useState<number | null>(null);
  const measured = status && status.phase !== "removed" ? `${status.projectPath}\n${status.path}` : null;
  useEffect(() => {
    setSize(null);
    if (!measured || !status) return;
    let live = true;
    api.workspaceSize(status.projectPath, status.path).then((bytes) => { if (live) setSize(bytes); }).catch(() => {});
    return () => { live = false; };
  }, [measured]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!status || status.phase === "removed") {
    if (!onArchive) return null;
    return <ArchiveCard onArchive={onArchive} />;
  }
  const frees = size && size >= 1024 * 1024 ? bytesText(size) : null;
  const hold = (held: boolean) => {
    setBusy(true);
    setError(null);
    holdMergedWorkspace(status.hostId, status.path, held)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const keep = (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => hold(true)} title="Clean-up stops asking about it; the session stays until you archive it">
      Keep
    </Button>
  );
  const archive = (label: string) => (
    <Button
      size="sm"
      className="bg-merged font-medium text-merged-foreground hover:bg-merged/90"
      disabled={busy}
      // A workspace whose conversations could not be filed away first: the remove dialog that settles that.
      onClick={() => status.archiveBlocked && status.hostId === LOCAL_HOST
        ? openWorkspaceRemove({ projectPath: status.projectPath, path: status.path, name: status.name, mode: "settle", archiveNotice: status.detail ?? undefined })
        : openWorkspaceDelete(status.projectPath, status.path, status.name)}
    >
      {label}
    </Button>
  );
  const state =
    status.phase === "kept"
      ? {
          tone: "warn" as const,
          label: `Archive on merge skipped: ${status.reason ?? "it could not be checked"}.`,
          body: `${status.detail ? `${status.detail} The session was kept so nothing is lost.` : "The session was kept because archiving it could lose something."}${frees ? ` Archiving it frees ${frees}.` : ""}`,
          actions: <>{archive("Archive anyway")}{keep}</>,
        }
      : status.phase === "scheduled"
        ? {
            tone: "muted" as const,
            label: `Archiving ${mergedDue(status)}`,
            body: `Runs the archive script and removes the worktree${frees ? `, freeing ${frees}` : ""}. Chats stay searchable.`,
            actions: <>{archive("Archive now")}{keep}</>,
          }
        : {
            tone: "muted" as const,
            label: "Kept by you",
            body: `Clean-up leaves the session until you archive it.${frees ? ` Archiving it frees ${frees}.` : ""}`,
            actions: <>{archive("Archive")}<Button size="sm" variant="ghost" disabled={busy} onClick={() => hold(false)}>Let clean-up archive it</Button></>,
          };
  return (
    <section aria-label="Archive the session" data-testid="merged-workspace-step" data-tone={state.tone} className="flex flex-col gap-2.5 rounded-lg border border-hairline bg-raised p-3">
      {!embedded && (
        <div className="flex min-w-0 items-center gap-2">
          <GitMerge aria-hidden className="size-4 shrink-0 text-merged" />
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">Pull request #{status.pr.number} merged</span>
        </div>
      )}
      <div className="flex min-w-0 items-start gap-2.5">
        <Archive aria-hidden className={cn("mt-0.5 size-4 shrink-0", state.tone === "warn" ? "text-warning" : "text-muted-foreground")} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("text-[12.5px] font-medium", state.tone === "warn" ? "text-warning" : "text-foreground")}>{state.label}</span>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">{state.body}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{state.actions}</div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </section>
  );
}

/** Where clean-up does not archive merged sessions: the archive offered by hand. */
function ArchiveCard({ onArchive }: { onArchive: () => void }) {
  return (
    <section aria-label="Archive the session" data-testid="merged-archive" className="flex min-w-0 items-start gap-2.5 rounded-lg border border-hairline bg-raised p-3">
      <Archive aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-foreground">Archive the session</div>
        <div className="text-[11.5px] text-faint">Runs the archive script and removes the worktree. Chats stay searchable.</div>
      </div>
      <Button size="sm" className="shrink-0 bg-merged font-medium text-merged-foreground hover:bg-merged/90" onClick={onArchive}>Archive</Button>
    </section>
  );
}
