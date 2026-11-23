import { useState } from "react";
import { Archive, ArchiveRestore, Folder, Loader2, X } from "@/icons";
import { errorMessage } from "@/lib/api";
import { dismissArchiveNotice, restoreArchived, useArchiveNotices, type ArchiveNotice } from "@/lib/archiveNotices";
import { useSessionStore } from "@/lib/sessions";

/**
 * "Archived <title>" with Restore (PRO-386, screen 02.23), bottom right with
 * the other toasts. Mounted once by each window's shell.
 */
export function ArchiveNotices() {
  const notices = useArchiveNotices();
  if (!notices.length) return null;
  return (
    <div className="pointer-events-none flex shrink-0 flex-col gap-2">
      {notices.map((notice) => <ArchiveNoticeCard key={notice.id} notice={notice} />)}
    </div>
  );
}

function ArchiveNoticeCard({ notice }: { notice: ArchiveNotice }) {
  const session = useSessionStore().sessions.find((candidate) => candidate.id === notice.sessionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Brought back some other way, or deleted: there is nothing left to restore.
  if (!session || (!session.archived && !busy)) return null;
  const restore = () => {
    setBusy(true);
    setError(null);
    void restoreArchived(notice).catch((cause: unknown) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <div
      role="status"
      aria-labelledby={`${notice.id}-title`}
      data-testid="archive-notice"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        dismissArchiveNotice(notice.id);
      }}
      className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-popover px-3.5 py-3 text-card-foreground shadow-surface animate-fade-in"
    >
      <Archive aria-hidden className="mt-px size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div id={`${notice.id}-title`} className="break-words text-[13px] font-medium leading-[18px]">Archived {notice.title}</div>
        {notice.project && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs leading-[17px] text-faint">
            <Folder aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{notice.project}{notice.workspaceRemoved ? " · worktree removed, chats kept" : ""}</span>
          </div>
        )}
        {error && <div role="alert" className="mt-1 break-words text-xs text-destructive">Couldn't restore it: {error}</div>}
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={restore}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-foreground px-2.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <ArchiveRestore aria-hidden className="size-3.5" />}
            Restore
          </button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismissArchiveNotice(notice.id)}
        className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
