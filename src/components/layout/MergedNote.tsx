import { useState } from "react";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { holdMergedWorkspace, mergedNote, type HostedStatus } from "@/lib/mergedCleanup";

const TONE: Record<HostedStatus["phase"], string> = { scheduled: "text-merged", kept: "text-warning", held: "text-faint", removed: "text-faint" };

/**
 * What the removal that follows a merged pull request says of one workspace,
 * under its row: why it is still there, or when it goes, with the reader's
 * way to keep it. Nothing when its pull request has not merged or the
 * setting is off for its project.
 */
export function MergedNote({ status, className }: { status: HostedStatus | undefined; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  if (!status) return null;
  const hold = (held: boolean) => {
    setBusy(true);
    setError(null);
    holdMergedWorkspace(status.hostId, status.path, held)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const about = [`Pull request #${status.pr.number} was merged.`, status.phase === "held" ? "You chose to keep this workspace." : status.detail].filter(Boolean).join(" ");
  const action = status.phase === "scheduled" ? { label: "Keep", held: true } : status.phase === "held" ? { label: "Stop keeping", held: false } : null;
  // A reason cut short in a narrow row can be read in full (#476).
  const explains = status.phase === "kept" && Boolean(status.detail);
  const link = "shrink-0 rounded-sm text-muted-foreground underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60";
  return (
    <div data-testid="merged-note" className={cn("min-w-0 text-[11px] leading-tight", className)}>
      {/* One line in a narrow sidebar: the words give way, the button does not. */}
      <div className="flex min-w-0 items-baseline gap-x-1.5">
        <span className={cn("min-w-0 truncate", TONE[status.phase])} title={about}>
          {mergedNote(status)}
        </span>
        {action ? (
          <button type="button" disabled={busy} onClick={() => hold(action.held)} className={link}>
            {action.label}
          </button>
        ) : null}
        {explains ? (
          <button type="button" aria-expanded={why} onClick={() => setWhy((open) => !open)} className={link}>
            Why
          </button>
        ) : null}
      </div>
      {why && explains ? <div className="mt-0.5 whitespace-normal break-words text-muted-foreground">{about}</div> : null}
      {error ? (
        <div role="alert" className="text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
