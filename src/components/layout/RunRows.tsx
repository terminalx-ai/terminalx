import { createContext, useContext, useMemo, useRef, useState, type ReactElement } from "react";
import { CircleAlert, GitFork, LoaderCircle, Network, ShieldAlert } from "@/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PieceStateIcon, PIECE_STATE_STYLE } from "@/components/orchestration/PieceStateMark";
import { StatusMarkIcon } from "@/components/ui/SessionStatus";
import { formatCost } from "@/components/session/SessionCost";
import { cn } from "@/lib/cn";
import { isUnread } from "@/lib/dashboard";
import { PIECE_STATE_LABEL } from "@/lib/orchestration";
import { usePrefs } from "@/lib/prefs";
import { useSessionRowStatuses } from "@/lib/sessionRowStatus";
import { conversationTitle, useSessionStore } from "@/lib/sessions";
import { familyNeeds, modelTier, needsMark, orderWorkers, pieceOf, runningWorkers, runProgress, runSpend, workerModel, type Need } from "@/lib/runFamily";
import { SESSION_STATUSES, type StatusDescription } from "@terminalx/portable/sessionStatus";
import type { Run, RunPiece } from "@/types/orchestration";
import type { SessionEntry } from "@/types/session";

/**
 * A project's leads and their workers, as the sidebar nests them (PRO-281):
 * each listed lead's workers by its id, and the run each session leads.
 * Empty while Settings → Experimental → Orchestrator is off, so every row is
 * drawn as before.
 */
export interface RunFamilies {
  workersOf: Record<string, SessionEntry[]>;
  runs: Record<string, Run | null>;
}
export const RunFamiliesContext = createContext<RunFamilies>({ workersOf: {}, runs: {} });

export interface LeadFamily {
  lead: SessionEntry;
  workers: SessionEntry[];
  run: Run | null;
}

/**
 * The family a row stands for when it is a lead's: its workers (of every session it stands for) and its run.
 * A session whose children only record it as their parent has a family with no run ([`leadsRun`] is false):
 * they still nest under it, but it is no run's lead (PRO-337).
 */
export function useLeadFamily(lead: SessionEntry, peers: readonly SessionEntry[]): LeadFamily | null {
  const { workersOf, runs } = useContext(RunFamiliesContext);
  return useMemo(() => {
    const run = peers.map((peer) => runs[peer.id]).find(Boolean) ?? null;
    const workers = orderWorkers(peers.flatMap((peer) => workersOf[peer.id] ?? []), run);
    return workers.length || run ? { lead, workers, run } : null;
  }, [lead, peers, workersOf, runs]);
}

/** The run a worker's piece is in: the run its lead leads. */
export function useWorkerPiece(worker: SessionEntry): { piece: RunPiece | null; run: Run | null } {
  const { runs } = useContext(RunFamiliesContext);
  const run = worker.parent ? runs[worker.parent.sessionId] ?? null : null;
  return { piece: pieceOf(run, worker.id), run };
}

const fallback = SESSION_STATUSES.find((status) => status.id === "no_changes")!;

export type LeadSummary = NonNullable<ReturnType<typeof useLeadSummary>>;

/** What a lead row shows of its family: what waits on the person, what runs, and how far the run is. `null` for any other row. */
export function useLeadSummary(family: LeadFamily | null) {
  const { sessions } = useSessionStore();
  const statuses = useSessionRowStatuses(useMemo(() => (family ? [family.lead, ...family.workers] : []), [family]));
  return useMemo(() => {
    if (!family) return null;
    const statusOf = (id: string): StatusDescription => statuses[id] ?? fallback;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const spend = family.run ? runSpend(family.run, byId) : null;
    const needs = familyNeeds({ lead: family.lead, leadStatus: statusOf(family.lead.id), run: family.run, workers: family.workers, statusOf, spend });
    // A blocked piece is answered in the lead's Run view (PRO-361): the open lead carries it, though the
    // family's list names it once as its worker's question when that worker also asks.
    const own = needs.filter((need) => need.sessionId === family.lead.id);
    const blocked = (family.run?.pieces ?? []).filter((piece) => piece.state === "blocked" && !own.some((need) => need.piece === piece.id));
    return {
      needs,
      /** The lead's own: itself, the run as a whole, and the pieces blocked in it. */
      ownNeeds: [...own, ...blocked.map((piece): Need => ({ kind: "attention", sessionId: family.lead.id, text: `${piece.title}: ${piece.note ?? "blocked"}`, piece: piece.id }))],
      running: runningWorkers(family.workers, family.run, statusOf),
      /** A worker has output not read yet: the folded lead carries the unread mark. */
      unread: family.workers.some(isUnread),
      progress: family.run && family.run.pieces.length ? runProgress(family.run) : null,
      spend,
      statusOf,
    };
  }, [family, statuses, sessions]);
}

/** One mark for what waits on the person, with how many: "Needs approval" or "Needs you" (PRO-329's row rules). The reasons are its tooltip. */
export function NeedsBadge({ needs, className }: { needs: readonly Need[]; className?: string }) {
  const kind = needsMark(needs);
  if (!kind) return null;
  const Icon = kind === "approval" ? ShieldAlert : CircleAlert;
  const label = kind === "approval" ? "Needs approval" : "Needs you";
  const reasons = needs.map((need) => need.text).join("\n");
  return (
    <span role="img" aria-label={`${label}: ${needs.length}`} title={`${label}\n${reasons}`} data-needs={kind} data-testid="lead-needs"
      className={cn("inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] bg-accent px-1.5 text-[11px] font-medium tabular-nums text-accent-foreground", className)}>
      <Icon aria-hidden className="size-3" />{needs.length}
    </span>
  );
}

/** Whether the family's row is a run's lead: only that row has the lead glyph and the run's summary (PRO-337). */
export function leadsRun(family: LeadFamily | null): family is LeadFamily & { run: Run } {
  return !!family?.run;
}

/** A lead row's mark: the run's glyph, where any other row has its status mark. */
export function LeadGlyph() {
  return <Network aria-hidden data-testid="lead-glyph" className="size-3.5 shrink-0 text-accent" />;
}

/**
 * The quieter mark of a session that started others but leads no run (PRO-337):
 * after its title, the row keeping its own status mark, and no run summary.
 */
export function StarterMark() {
  return (
    <span role="img" aria-label="Started these sessions" title="Started these sessions" data-testid="starter-mark" className="inline-flex shrink-0 text-faint">
      <GitFork aria-hidden className="size-3" />
    </span>
  );
}

/**
 * What follows a lead's title. Folded, its workers' marks come up to it
 * (18.07): what waits on the person, how many run, unread, and pieces done
 * out of total. Open, the workers' rows carry theirs, and the lead shows its
 * own and what the run has cost.
 */
export function LeadTrailing({ family, folded, summary, fallback }: { family: LeadFamily; folded: boolean; summary: LeadSummary; fallback: ReactElement }) {
  const { animations } = usePrefs();
  if (!folded) {
    return <>
      <NeedsBadge needs={summary.ownNeeds} />
      {family.run && summary.spend != null ? <span data-row-meta="spend" className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{formatCost(summary.spend)}</span> : fallback}
    </>;
  }
  return <>
    <NeedsBadge needs={summary.needs} />
    {summary.running > 0 && (
      <span role="img" aria-label={`${summary.running} running`} data-testid="lead-running" className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground">
        <LoaderCircle aria-hidden className={cn("size-3 text-accent", animations && "animate-spin")} />{summary.running}
      </span>
    )}
    {summary.progress
      ? <span data-testid="lead-progress" aria-label={`${summary.progress.done} of ${summary.progress.total} pieces done`} className="shrink-0 whitespace-nowrap font-mono text-[11.5px] tabular-nums text-muted-foreground">{summary.progress.done}/{summary.progress.total}</span>
      : fallback}
  </>;
}

/** How far the card keeps from the sidebar's edge. */
const CARD_GAP = 6;

/**
 * Where the card goes beside its row: past the sidebar's edge rather than the
 * row's button, which ends inside the sidebar, and level with the row's top
 * rather than the button's (18.07, PRO-336).
 */
function besideSidebar(trigger: HTMLElement | null) {
  const button = trigger?.getBoundingClientRect();
  const row = trigger?.parentElement?.getBoundingClientRect();
  const rail = trigger?.closest("[data-testid=sidebar-rail]")?.getBoundingClientRect();
  if (!button || !row || !rail) return { side: CARD_GAP, align: 0 };
  return { side: Math.max(CARD_GAP, rail.right - button.right + CARD_GAP), align: row.top - button.top };
}

/**
 * Hovering a folded lead (18.07): the run in a line, then each piece that is
 * not done with its state and whether it waits on the person, and how many
 * are. A lead with no run lists the workers that are not idle. The card sits
 * outside the sidebar, beside the row, and is opaque like every tooltip, so
 * the rows it passes over never show through it.
 */
export function LeadHoverCard({ family, summary, title, children }: { family: LeadFamily; summary: LeadSummary; title: string; children: ReactElement }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [offset, setOffset] = useState({ side: CARD_GAP, align: 0 });
  const waiting = new Set(summary.needs.map((need) => need.sessionId));
  const run = family.run;
  const open = run ? run.pieces.filter((piece) => piece.state !== "done") : [];
  const done = run ? run.pieces.length - open.length : 0;
  const head = [run && summary.progress ? `${summary.progress.done} of ${summary.progress.total}` : `${family.workers.length} ${family.workers.length === 1 ? "worker" : "workers"}`, summary.spend != null ? formatCost(summary.spend) : null].filter(Boolean).join(" · ");
  return (
    <Tooltip delayDuration={500} onOpenChange={(open) => { if (open) setOffset(besideSidebar(trigger.current)); }}>
      <TooltipTrigger asChild ref={trigger}>{children}</TooltipTrigger>
      <TooltipContent side="right" align="start" sideOffset={offset.side} alignOffset={offset.align} className="block w-72 p-0" data-testid="lead-hover">
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{head}</span>
        </div>
        <ul className="flex flex-col gap-1.5 px-3 py-2">
          {run ? <>
            {open.map((piece) => {
              const { icon: Icon, className } = PIECE_STATE_STYLE[piece.state];
              const needsYou = (piece.worker && waiting.has(piece.worker.sessionId)) || piece.state === "blocked";
              return (
                <li key={piece.id} className="flex min-w-0 items-center gap-2">
                  <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />
                  <span className={cn("shrink-0", className)}>{piece.state === "queued" && piece.dependsOn.length ? "Waiting" : PIECE_STATE_LABEL[piece.state]}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{piece.title}</span>
                  {needsYou && <span className="shrink-0 text-accent">needs you</span>}
                </li>
              );
            })}
            {done > 0 && <li className="flex items-center gap-2"><PieceStateIcon state="done" /><span className="text-add">Done</span><span className="text-muted-foreground">{done} {done === 1 ? "piece" : "pieces"}</span></li>}
            {summary.needs.filter((need) => need.sessionId === family.lead.id).map((need) => (
              <li key={need.text} className="flex items-center gap-2 text-accent"><CircleAlert aria-hidden className="size-3.5 shrink-0" /><span className="min-w-0 truncate">{need.text}</span></li>
            ))}
          </> : family.workers.map((worker) => {
            const status = summary.statusOf(worker.id);
            return (
              <li key={worker.id} className="flex min-w-0 items-center gap-2">
                <StatusMarkIcon status={status} decorative />
                <span className="shrink-0 text-muted-foreground">{status.label}</span>
                <span className="min-w-0 flex-1 truncate">{conversationTitle(worker)}</span>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-hairline px-3 py-1.5 text-[11px] text-faint">{run ? "Click to open the run · the chevron unfolds it" : "Click to open the lead · the chevron unfolds it"}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/** A worker row's mark: its session's when it waits on the person (one "Needs approval" mark), else its piece's state, else its session's. */
export function WorkerMark({ piece, status }: { piece: RunPiece | null; status: StatusDescription }) {
  if (piece && status.label !== "Needs approval" && status.label !== "Needs you") return <PieceStateIcon state={piece.state} />;
  return <StatusMarkIcon status={status} decorative={false} />;
}

/** A worker row's metadata: its model as one word, coloured by tier (18.07). */
export function WorkerTier({ piece, session }: { piece: RunPiece | null; session: SessionEntry }) {
  const { agent, model } = workerModel(piece, session);
  const tier = modelTier(agent, model);
  return <span data-row-meta="model" className={cn("shrink-0 font-mono text-[10.5px]", tier.className)}>{tier.text}</span>;
}
