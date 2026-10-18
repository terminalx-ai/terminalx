import { Cloud, Laptop, Link2, Users } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { ago, linkText, stateText, useOthersOnIssue, warningText, workerLabel, type IssueWorker } from "@/lib/issueWork";
import type { SessionEntry } from "@/types/session";

function PlaceIcon({ worker, className }: { worker: IssueWorker; className?: string }) {
  const Icon = worker.place === "this" ? Link2 : worker.place === "team" ? Users : worker.place === "cloud" ? Cloud : Laptop;
  return <Icon className={cn("size-3 shrink-0", className)} />;
}

/** One person's work on the issue: who and where, the session, its branch and state, and when it was last active. */
function WorkerRow({ worker, now }: { worker: IssueWorker; now: number }) {
  const where = worker.place === "this" ? "this Mac" : worker.place === "machine" ? worker.machine : worker.place === "cloud" || worker.cloud ? "cloud" : null;
  return (
    <li className={cn("flex min-w-0 items-start gap-2", worker.phase === "faded" && "opacity-70")} data-testid="issue-worker">
      <PlaceIcon worker={worker} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-foreground">
          {worker.person}
          {where && <span className="text-muted-foreground"> · {where}</span>}
        </div>
        <div className="truncate text-muted-foreground">{worker.title}</div>
        {worker.branch && <div className="truncate font-mono text-[11px] text-faint">{worker.branch}</div>}
        <div className="text-faint">
          {worker.phase === "faded" ? `Was working on this, ${ago(worker.lastActive, now)}` : `${stateText(worker.state)} · last active ${ago(worker.lastActive, now)}`}
          {worker.link && ` · ${linkText(worker.link).toLowerCase()}`}
        </div>
      </div>
    </li>
  );
}

export function IssueWorkList({ workers, now = Date.now(), className }: { workers: IssueWorker[]; now?: number; className?: string }) {
  return (
    <ul className={cn("flex flex-col gap-2 text-[11px]", className)}>
      {workers.map((worker) => (
        <WorkerRow key={worker.key} worker={worker} now={now} />
      ))}
    </ul>
  );
}

/**
 * Who is working on an issue, as a chip: the first of them, and "+N" for the
 * rest. Hovering shows each one: person, their own machine's name, session,
 * branch, state and when it was last active.
 */
export function IssueWorkChip({ workers, now = Date.now(), className }: { workers: IssueWorker[]; now?: number; className?: string }) {
  const first = workers[0];
  if (!first) return null;
  const faded = first.phase === "faded";
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span
          className={cn("flex min-w-0 items-center gap-1", faded ? "text-faint" : first.place === "this" ? "text-info" : "text-warning", className)}
          data-testid="issue-work-chip"
          aria-label={workers.map((worker) => workerLabel(worker, now)).join(", ")}
        >
          <PlaceIcon worker={first} />
          <span className="truncate">{workerLabel(first, now)}</span>
          {workers.length > 1 && <span className="shrink-0 rounded-sm bg-veil-strong px-1 text-[10px] text-muted-foreground">+{workers.length - 1}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-72 items-start">
        <IssueWorkList workers={workers} now={now} />
      </TooltipContent>
    </Tooltip>
  );
}

/** The detail pane's section: everyone working on the open issue. */
export function IssueWorkPanel({ workers, now = Date.now(), note }: { workers: IssueWorker[]; now?: number; note?: string | null }) {
  if (!workers.length && !note) return null;
  return (
    <section aria-label="Who is working on this" className="flex flex-col gap-1.5 rounded-md bg-well px-3 py-2" data-testid="issue-work-panel">
      {workers.length > 0 && (
        <>
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-faint">Working on this</h3>
          <IssueWorkList workers={workers} now={now} />
        </>
      )}
      {note && <p className="text-[11px] text-faint">{note}</p>}
    </section>
  );
}

/**
 * Before a session starts on an issue someone works on now: say who, where
 * and since when. A warning, never a lock: starting anyway stays possible.
 */
export function TakenIssueDialog({
  workers,
  now = Date.now(),
  onStart,
  onOpen,
  onCancel,
}: {
  workers: IssueWorker[];
  now?: number;
  onStart: () => void;
  /** The existing session, when it is on this Mac. */
  onOpen: ((sessionId: string) => void) | null;
  onCancel: () => void;
}) {
  const first = workers[0];
  if (!first) return null;
  const local = workers.find((worker) => worker.place === "this" && worker.sessionId);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent width="max-w-[28rem]" onEscapeKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Someone is working on this issue</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground" data-testid="taken-issue-warning">
            {warningText(first, now)}
            {workers.length > 1 && ` ${workers.length - 1} other session${workers.length === 2 ? " works" : "s work"} on it too.`}
          </DialogDescription>
        </DialogHeader>
        <IssueWorkList workers={workers} now={now} className="max-h-48 overflow-y-auto rounded-md bg-well px-3 py-2" />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          {local && onOpen && (
            <Button variant="secondary" onClick={() => onOpen(local.sessionId!)}>
              Open the existing session
            </Button>
          )}
          <Button variant="accent" onClick={onStart}>Start anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Beside a session's issue chip: who else works on that issue now, if anyone. */
export function SessionIssueWork({ session, sessions, className }: { session: SessionEntry; sessions: SessionEntry[]; className?: string }) {
  const { workers, now } = useOthersOnIssue(session, sessions);
  if (!workers.length) return null;
  return <IssueWorkChip workers={workers} now={now} className={cn("rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px]", className)} />;
}
