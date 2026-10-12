import { useLayoutEffect, useRef } from "react";
import type { CleanupStep } from "@terminalx/portable/workspace";
import { Cloud, Loader2, Monitor } from "lucide-react";
import { DialogScrollArea } from "@/components/ui/dialog";
import { summarize, type CleanupRun, type CleanupRunSummary } from "@/lib/cleanupRun";
import { formatSize } from "@/lib/workspaceSizes";
import { candidateKey, type CleanupOutcome } from "@/lib/worktreeCleanup";

const OUTCOME_LABEL: Record<CleanupOutcome["outcome"], string> = {
  removed: "Removed",
  alreadyRemoved: "Already removed",
  skipped: "Skipped",
  failed: "Failed",
  unknown: "Not known",
};

const STEP_LABEL: Record<CleanupStep, string> = {
  measuring: "Measuring",
  checking: "Checking it again",
  removing: "Removing",
  sessions: "Updating sessions",
};

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "3.2 GB", or "about 3.2 GB" when some of it is what the review measured. */
export function freedText(sum: Pick<CleanupRunSummary, "freedBytes" | "freedEstimated">): string {
  return `${sum.freedEstimated ? "about " : ""}${formatSize(sum.freedBytes)}`;
}

/** What is freed so far against what the review expected: "3.2 GB of about 11 GB". */
export function reclaimedText(sum: CleanupRunSummary): string {
  const freed = formatSize(sum.freedBytes);
  // Nothing was measured in the review: there is no total to hold it against.
  if (sum.unsized === sum.total) return `${freed} freed so far`;
  return `${freed} of ${sum.unsized ? "at least" : "about"} ${formatSize(sum.expectedBytes)} freed`;
}

/** The sentence a finished run is summed up in. */
export function resultText(sum: CleanupRunSummary): string {
  return `Removed ${sum.removed} and freed ${freedText(sum)}. ${sum.skipped} skipped, ${sum.failed} failed.`;
}

/**
 * A clean-up run, as the dialog shows it: how far it is and what each
 * worktree came to while it runs, and the same list as its result once it
 * is over.
 */
export function CleanupRunView({ run }: { run: CleanupRun }) {
  const sum = summarize(run);
  const running = run.status === "running";
  const item = (key: string) => run.items.find((entry) => entry.key === key);
  const current = run.current ? item(run.current.key) : undefined;
  const list = useRef<HTMLDivElement>(null);
  // The newest outcome stays in view unless the person scrolled up to read an earlier one.
  const follow = useRef(true);
  useLayoutEffect(() => {
    const area = list.current;
    if (area && running && follow.current) area.scrollTop = area.scrollHeight;
  }, [running, run.outcomes.length]);

  return (
    <>
      {running ? (
        <div className="mb-3 shrink-0">
          <div
            role="progressbar"
            aria-label="Worktrees cleaned up"
            aria-valuemin={0}
            aria-valuemax={sum.total}
            aria-valuenow={sum.done}
            aria-valuetext={`${sum.done} of ${plural(sum.total, "worktree", "worktrees")} done`}
            className="h-1.5 overflow-hidden rounded-full bg-well"
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${sum.total ? (sum.done / sum.total) * 100 : 0}%` }} />
          </div>
          <div role="status" className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
            <span className="text-foreground">
              {sum.done} of {plural(sum.total, "worktree", "worktrees")} done
            </span>
            <span className="tabular-nums text-muted-foreground">{reclaimedText(sum)}</span>
            <span className="tabular-nums text-muted-foreground">
              {sum.removed} removed · {sum.skipped} skipped · {sum.failed} failed
            </span>
          </div>
          <div aria-label="Being cleaned up now" className="mt-2 flex min-h-9 items-start gap-2 rounded-lg bg-well px-3 py-2 text-xs">
            <Loader2 aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
            {run.stopping && !current ? (
              <span className="text-muted-foreground">Stopping…</span>
            ) : current ? (
              <>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-foreground">{current.name}</span>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                      {current.hostKind === "cloud" ? <Cloud aria-hidden className="size-3" /> : <Monitor aria-hidden className="size-3" />}
                      on {current.hostName}
                    </span>
                  </span>
                  <span className="block truncate font-mono text-[11px] text-faint">{current.path}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">{run.current?.step ? STEP_LABEL[run.current.step] : "Working"}…</span>
              </>
            ) : (
              <span className="text-muted-foreground">Starting…</span>
            )}
          </div>
          {run.stopping && (
            <p role="status" className="mt-2 text-[11px] text-muted-foreground">
              Stopping. The worktree being removed is finished first; the rest are left as they are.
            </p>
          )}
        </div>
      ) : (
        <p role="status" className="mb-2 shrink-0 text-xs text-foreground">
          {resultText(sum)}
        </p>
      )}
      <DialogScrollArea
        ref={list}
        aria-label="Results, scrollable"
        onScroll={(event) => {
          const area = event.currentTarget;
          follow.current = area.scrollHeight - area.scrollTop - area.clientHeight < 32;
        }}
      >
        {running && run.outcomes.length === 0 && <p className="rounded-lg bg-well px-3 py-2 text-[11px] text-muted-foreground">Each worktree is listed here as soon as it is done.</p>}
        <ul aria-label="Results" className="flex flex-col divide-y divide-hairline rounded-lg bg-well">
          {run.outcomes.map((outcome) => {
            const key = candidateKey(outcome.hostId, outcome.path);
            const row = item(key);
            const good = outcome.outcome === "removed" || outcome.outcome === "alreadyRemoved";
            return (
              <li key={key} className="px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className={`shrink-0 text-xs ${good ? "text-foreground" : outcome.outcome === "skipped" ? "text-warning" : "text-destructive"}`}>{OUTCOME_LABEL[outcome.outcome]}</span>
                  <span className="truncate text-xs text-foreground">{row?.name ?? outcome.path}</span>
                  {row && <span className="shrink-0 text-[11px] text-muted-foreground">on {row.hostName}</span>}
                  {outcome.freedBytes > 0 && (
                    <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                      {outcome.freedEstimated ? "about " : ""}
                      {formatSize(outcome.freedBytes)}
                    </span>
                  )}
                </div>
                {outcome.reason && <div className="text-[11px] text-muted-foreground">{outcome.reason}</div>}
                {good && (
                  <div className="text-[11px] text-muted-foreground">
                    {[
                      outcome.keptBranch && `Branch ${outcome.keptBranch} kept`,
                      outcome.sessionsKept.length > 0 && `${plural(outcome.sessionsKept.length, "conversation", "conversations")} kept`,
                      outcome.sessionsDeleted.length > 0 && `${plural(outcome.sessionsDeleted.length, "conversation", "conversations")} deleted`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </DialogScrollArea>
    </>
  );
}
