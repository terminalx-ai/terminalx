import { useState } from "react";
import { GitMerge, Loader2, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { branchOutcome, dismissMergedNotice, holdMergedWorkspace, mergedDue, restoreMergedRemoval, useMergedCleanup, type MergedNotice } from "@/lib/mergedCleanup";

/** How many notices are shown at once; the rest are in Settings → Storage. */
const SHOWN = 3;

function NoticeCard({ notice }: { notice: MergedNotice }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What an undo could not put back; the notice stays to say it. */
  const [notes, setNotes] = useState<string[] | null>(null);
  const { status } = notice;
  const removed = notice.kind === "removed";
  const act = (work: () => Promise<string[] | void>) => {
    setBusy(true);
    setError(null);
    work()
      .then((left) => (left?.length ? setNotes(left) : dismissMergedNotice(notice.id)))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const Icon = removed ? Trash2 : GitMerge;
  return (
    <aside role="status" aria-busy={busy} data-testid="merged-notice" className="pointer-events-auto rounded-xl bg-popover glass p-3 text-sm text-popover-foreground shadow-surface hairline animate-fade-in">
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-merged" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{notes ? `Brought back ${status.name}` : removed ? `Deleted workspace ${status.name}` : `Pull request #${status.pr.number} merged`}</div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {notes
              ? notes.join(" ")
              : removed
                ? `Its pull request #${status.pr.number} was merged. ${status.record ? branchOutcome(status.record) : ""}`
                : `The workspace ${status.name} and its branch will be deleted ${mergedDue(status)}.`}
          </div>
          {error ? (
            <div role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {notes ? null : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {removed ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => restoreMergedRemoval(notice.hostId, notice.id).then((restored) => restored.notes))}>
                  {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Undo2 aria-hidden />} Undo
                </Button>
              ) : (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => holdMergedWorkspace(notice.hostId, status.path, true))}>
                  {busy ? <Loader2 aria-hidden className="animate-spin" /> : null} Keep workspace
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
 * (Undo). Mounted once by AppShell.
 */
export function MergedCleanupNotices() {
  const { notices } = useMergedCleanup();
  if (!notices.length) return null;
  const shown = notices.slice(-SHOWN);
  const more = notices.length - shown.length;
  return (
    <div className="pointer-events-none flex max-h-[50dvh] shrink-0 flex-col gap-2 overflow-y-auto">
      {more > 0 ? (
        <div role="status" className="pointer-events-auto rounded-lg bg-popover glass px-3 py-1.5 text-xs text-muted-foreground shadow-surface hairline">
          {more} more {more === 1 ? "workspace" : "workspaces"}; see Settings → Storage.
        </div>
      ) : null}
      {shown.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
    </div>
  );
}
