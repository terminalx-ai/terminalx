import { useState } from "react";
import { GitMerge, Loader2, ShieldCheck, Trash2, Undo2, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/api";
import { openWorkspaceRemove, openWorktreeCleanup } from "@/lib/dialogs";
import { branchOutcome, dismissMergedNotice, holdMergedWorkspace, mergedDue, restoreMergedRemoval, useMergedCleanup, type MergedNotice } from "@/lib/mergedCleanup";

/** How many notices are shown at once; the rest are in Settings → Storage. */
const SHOWN = 3;
/**
 * A notice's card. It floats over the conversation, so its ground is the card colour itself, never the see-through
 * glass one (which in a macOS window lets the text behind it show through).
 */
const NOTICE = "pointer-events-auto rounded-xl bg-(--surface-card) p-3 text-sm text-card-foreground shadow-surface hairline animate-fade-in";

function NoticeCard({ notice }: { notice: MergedNotice }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What an undo could not put back; the notice stays to say it. */
  const [notes, setNotes] = useState<string[] | null>(null);
  const { status } = notice;
  const removed = notice.kind === "removed";
  const kept = notice.kind === "kept";
  const act = (work: () => Promise<string[] | void>) => {
    setBusy(true);
    setError(null);
    work()
      .then((left) => (left?.length ? setNotes(left) : dismissMergedNotice(notice.id)))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const [details, setDetails] = useState(false);
  const Icon = removed ? Trash2 : kept ? ShieldCheck : GitMerge;
  // A kept workspace's reason can list many files: the card says it in two lines, and the rest is a click away.
  const body = notes
    ? notes.join(" ")
    : removed
      ? `Its pull request #${status.pr.number} was merged. ${status.record ? branchOutcome(status.record) : ""}`
      : kept
        ? `Its pull request #${status.pr.number} was merged, but it was not deleted: ${status.reason ?? "it could not be checked"}. ${status.detail ?? ""}`.trim()
        : `The workspace ${status.name} and its branch will be deleted ${mergedDue(status)}.`;
  const long = body.length > 140;
  return (
    <aside role="status" aria-busy={busy} data-testid="merged-notice" className={NOTICE}>
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden className={kept ? "mt-0.5 size-4 shrink-0 text-warning" : "mt-0.5 size-4 shrink-0 text-merged"} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{notes ? `Brought back ${status.name}` : removed ? `Deleted workspace ${status.name}` : kept ? `Kept workspace ${status.name}` : `Pull request #${status.pr.number} merged`}</div>
          <div className={cn("text-xs leading-relaxed break-words text-muted-foreground", long && !details && "line-clamp-2")}>{body}</div>
          {error ? (
            <div role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {notes ? null : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {kept ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    dismissMergedNotice(notice.id);
                    if (status.archiveBlocked && notice.hostId === "local") openWorkspaceRemove({ projectPath: status.projectPath, path: status.path, name: status.name, mode: "settle", archiveNotice: status.detail ?? undefined });
                    else openWorktreeCleanup();
                  }}
                >
                  {status.archiveBlocked && notice.hostId === "local" ? "Review removal" : "Review in clean-up"}
                </Button>
              ) : removed ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => restoreMergedRemoval(notice.hostId, notice.id).then((restored) => restored.notes))}>
                  {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Undo2 aria-hidden />} Undo
                </Button>
              ) : (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => holdMergedWorkspace(notice.hostId, status.path, true))}>
                  {busy ? <Loader2 aria-hidden className="animate-spin" /> : null} Keep workspace
                </Button>
              )}
              {long && (
                <Button size="sm" variant="ghost" className="text-muted-foreground" aria-expanded={details} onClick={() => setDetails(!details)}>
                  {details ? "Less" : "Details"}
                </Button>
              )}
            </div>
          )}
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => dismissMergedNotice(notice.id)}>
          <X />
        </Button>
      </div>
    </aside>
  );
}

/**
 * Notices of the removal that follows a merged pull request, bottom right:
 * one when a workspace is about to go (Keep workspace), one when it has gone
 * (Undo), and one when a newly merged one stays, with why. Mounted once by
 * AppShell.
 */
export function MergedCleanupNotices() {
  // A kept workspace is not urgent: it is said in its session's Branch tab, marked on its sidebar row, and counted
  // under the projects. Only what has a short window to answer pops up: a deletion coming (Keep), or done (Undo).
  const notices = useMergedCleanup().notices.filter((notice) => notice.kind !== "kept");
  if (!notices.length) return null;
  const shown = notices.slice(-SHOWN);
  const more = notices.length - shown.length;
  return (
    <div className="pointer-events-none flex max-h-[50dvh] shrink-0 flex-col gap-2 overflow-y-auto">
      {more > 0 ? (
        <div role="status" className="pointer-events-auto rounded-lg bg-(--surface-card) px-3 py-1.5 text-xs text-muted-foreground shadow-surface hairline">
          {more} more {more === 1 ? "workspace" : "workspaces"}; see Settings → Storage.
        </div>
      ) : null}
      {shown.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
    </div>
  );
}
