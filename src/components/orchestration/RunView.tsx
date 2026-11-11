import { useEffect, useMemo, useState, type ReactNode } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { PieceStateMark } from "@/components/orchestration/PieceStateMark";
import {
  Check, CircleAlert, CircleCheck, FileJson, FolderOpen, Gauge, Info, Layers, LoaderCircle, Network, Pencil, Play, ScanSearch,
  Settings, ShieldAlert, ShieldOff, Sparkles, Square, SquareArrowOutUpRight, Terminal, Trash2, UserRoundCheck, X,
} from "@/icons";
import { agent as agentApi, errorMessage, fs, orchestration } from "@/lib/api";
import { cn } from "@/lib/cn";
import { EFFORT_LABEL, effortChoices, modeLabel, modelForTab, modelLabel, modelOptionText, PERMISSION_MODES, useModels } from "@/lib/models";
import {
  budgetText, checksFrom, checkText, estimateText, noteRun, pieceMode, pieceNumbers, planOf, raisesMode, refusalOf, requestOrchestratorSettings,
  RUN_STATE_LABEL, useRun, withoutPiece,
} from "@/lib/orchestration";
import { selectSession, useSessionStore } from "@/lib/sessions";
import { useSessionRowStatuses } from "@/lib/sessionRowStatus";
import { familyNeeds, overBudget, runSpend, sessionSpend, type Need } from "@/lib/runFamily";
import { formatCost } from "@/components/session/SessionCost";
import { SESSION_STATUSES } from "@terminalx/portable/sessionStatus";
import { relativeTime } from "@/lib/time";
import type { Run, RunPiece, RunPlan, RunPlanPiece } from "@/types/orchestration";
import type { SessionEntry } from "@/types/session";

/** What the lead is asked when a person presses Plan a run. The lead decides whether splitting helps at all. */
export const PLAN_A_RUN_PROMPT =
  "Plan an orchestration run for the task we are working on. First decide whether splitting it helps: do not split work whose steps each need the one before, or that fits in one session. If it does help, write the plan as a JSON file and store it with `terminalx runs create --from <plan.json> --json` (the plan's fields and rules are under \"Orchestration runs\" in `terminalx skills get terminalx-cli`). Then tell me the plan is ready and stop: I approve it in the Run view before any worker starts. If splitting does not help, say why and go on in this session.";

const kicker = "text-[10.5px] font-medium uppercase tracking-[.08em] text-faint";
const chip = "inline-flex h-5 items-center rounded-[5px] bg-veil-raised px-1.5 font-mono text-[11px] text-muted-foreground";
const code = "rounded bg-veil-raised px-1 font-mono text-[12px]";
const field = "w-full rounded-md border border-hairline bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
const cellSelect = "h-7 min-w-0 max-w-full rounded-md border border-hairline bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60";

/** A session's Run view: the run it leads, or how to start one. */
export function RunView({ session, onShowChat }: { session: SessionEntry; onShowChat: () => void }) {
  const run = useRun(session.id);
  if (run === undefined) return <div role="status" aria-label="Reading the run" className="flex min-h-0 flex-1" data-testid="run-view" />;
  return (
    <div className="@container/run flex min-h-0 flex-1 flex-col bg-chat" data-testid="run-view" data-run-state={run?.state ?? "none"}>
      {run ? <RunBoard key={run.id} run={run} lead={session} /> : <NoRun session={session} onShowChat={onShowChat} />}
    </div>
  );
}

/** One action at a time, and why the last one was refused. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; piece?: string } | null>(null);
  const act = async (name: string, work: () => Promise<Run | null>) => {
    if (busy) return false;
    setBusy(name);
    setError(null);
    try {
      const run = await work();
      if (run) noteRun(run);
      return true;
    } catch (e) {
      const refusal = refusalOf(e);
      setError({ message: refusal.message, piece: refusal.details?.piece });
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, act, clear: () => setError(null) };
}

const NO_STATUS = SESSION_STATUSES.find((status) => status.id === "no_changes")!;

/** What each worker has cost, the run's spend, and what waits on the person: read from the sessions as they change (PRO-281). */
function useRunLedger(run: Run, lead: SessionEntry) {
  const { sessions } = useSessionStore();
  const byId = useMemo(() => new Map(sessions.map((entry) => [entry.id, entry])), [sessions]);
  const workers = useMemo(() => run.pieces.flatMap((piece) => (piece.worker && byId.get(piece.worker.sessionId) ? [byId.get(piece.worker.sessionId)!] : [])), [run, byId]);
  const statuses = useSessionRowStatuses(useMemo(() => [lead, ...workers], [lead, workers]));
  return useMemo(() => {
    const spend = runSpend(run, byId);
    const costOf = (piece: RunPiece) => (piece.worker ? sessionSpend(byId.get(piece.worker.sessionId)) : null);
    // The lead's own chat is in front of the person already: the Run view lists what its run waits on.
    const needs = familyNeeds({ lead, leadStatus: NO_STATUS, run, workers, statusOf: (id) => statuses[id] ?? NO_STATUS, spend }).filter((need) => need.text !== "The plan waits for your approval");
    return { spend, costOf, needs };
  }, [run, byId, lead, workers, statuses]);
}

function RunBoard({ run, lead }: { run: Run; lead: SessionEntry }) {
  const ledger = useRunLedger(run, lead);
  const [selected, setSelected] = useState<string | null>(run.pieces[0]?.id ?? null);
  const [editingPlan, setEditingPlan] = useState(false);
  const { busy, error, act, clear } = useAction();
  const waiting = run.state === "awaitingApproval";
  const editable = waiting || run.state === "planned";
  const numbers = useMemo(() => pieceNumbers(run), [run]);
  const piece = run.pieces.find((candidate) => candidate.id === selected) ?? null;
  // In one column the piece opens under the plan: bring it into view when a row is picked.
  const select = (id: string) => {
    setSelected(id);
    requestAnimationFrame(() => document.querySelector('[data-testid="piece-detail"]')?.scrollIntoView?.({ block: "nearest" }));
  };
  const save = (plan: RunPlan) => act("save", () => orchestration.updatePlan(run.id, plan));
  const change = (id: string, patch: Partial<RunPlanPiece>) => {
    const plan = planOf(run);
    return save({ ...plan, pieces: plan.pieces.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate)) });
  };

  return (
    // Wide: the plan and the open piece side by side, each scrolling by itself. Narrow: one column that scrolls as a whole, the piece under the plan.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin @[900px]/run:flex-row @[900px]/run:overflow-hidden">
      <div className="flex min-w-0 shrink-0 flex-col @[900px]/run:min-h-0 @[900px]/run:flex-1 @[900px]/run:shrink @[900px]/run:overflow-y-auto scrollbar-thin">
        <header className="flex flex-wrap items-start gap-x-4 gap-y-3 px-6 pb-4 pt-6">
          <div className="min-w-0 flex-1 basis-[20rem]">
            <div className={cn(kicker, "flex items-center gap-1.5", waiting && "text-accent")}>
              {waiting && <ShieldAlert aria-hidden className="size-3.5" />}
              <span data-testid="run-state">{RUN_STATE_LABEL[run.state]}</span>
            </div>
            <h1 className="mt-0.5 break-words text-[19px] font-semibold leading-7 tracking-tight">{run.goal}</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">{subtitle(run)}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {waiting && <>
              <Button variant="outline" disabled={!!busy} onClick={() => void act("stop", async () => (await orchestration.stop(run.id)).run)}>Discard</Button>
              <Button variant="outline" disabled={!!busy} aria-pressed={editingPlan} onClick={() => setEditingPlan((on) => !on)}><Pencil />Edit plan</Button>
              <Button variant="accent" disabled={!!busy} onClick={() => void act("approve", async () => (await orchestration.approve(run.id)).run)}>
                {busy === "approve" ? <LoaderCircle className="animate-spin" /> : <Play />}Approve and start
              </Button>
            </>}
            {run.state === "planned" && <Button variant="outline" disabled={!!busy} aria-pressed={editingPlan} onClick={() => setEditingPlan((on) => !on)}><Pencil />Edit plan</Button>}
            {(run.state === "running" || run.state === "planned" || run.state === "failed" || run.state === "verifying" || run.state === "merging") && (
              <Button variant="outline" disabled={!!busy} onClick={() => void act("stop", async () => (await orchestration.stop(run.id)).run)}><Square />Stop run</Button>
            )}
          </div>
        </header>
        {error && (
          <div role="alert" className="mx-6 mb-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{error.message}</span>
            <Button size="xs" variant="ghost" onClick={clear}>Dismiss</Button>
          </div>
        )}
        {ledger.needs.length > 0 && <RunNeeds needs={ledger.needs} lead={lead.id} />}
        {run.reason && (run.state === "failed" || run.state === "stopped") && (
          <p role="status" className={cn("mx-6 mb-3 rounded-lg bg-well px-3 py-2 text-xs", run.state === "failed" ? "text-destructive" : "text-muted-foreground")}>{run.reason}</p>
        )}
        {editingPlan && editable && <PlanForm run={run} busy={!!busy} onCancel={() => setEditingPlan(false)} onSave={async (plan) => { if (await save(plan)) setEditingPlan(false); }} />}
        {editable ? <PlanSummary run={run} /> : <RunSummary run={run} spend={ledger.spend} />}
        <PieceTable run={run} numbers={numbers} selected={selected} editable={editable} busy={!!busy} refused={error?.piece} costOf={ledger.costOf} onSelect={select} onChange={change} />
        <p className="flex items-start gap-2 px-6 py-4 text-xs text-faint">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{footnote(run)}</span>
        </p>
      </div>
      {piece && (
        <PieceDetail
          key={piece.id}
          run={run}
          piece={piece}
          number={numbers[piece.id]}
          editable={editable}
          busy={!!busy}
          cost={ledger.costOf(piece)}
          onClose={() => setSelected(null)}
          onSave={(patch) => change(piece.id, patch)}
          onRemove={async () => { if (await save(withoutPiece(planOf(run), piece.id))) setSelected(null); }}
        />
      )}
    </div>
  );
}

function subtitle(run: Run): string {
  const count = `${run.pieces.length} ${run.pieces.length === 1 ? "piece" : "pieces"}`;
  switch (run.state) {
    case "awaitingApproval":
      return `The lead split this into ${count}. Nothing starts until you approve.`;
    case "planned":
      return `The lead split this into ${count}. This repository starts runs without asking: the lead starts it with terminalx runs start.`;
    default: {
      const blocked = run.pieces.filter((piece) => piece.state === "blocked");
      if (blocked.length && run.state === "running") {
        const numbers = pieceNumbers(run);
        const names = blocked.map((piece) => numbers[piece.id]).join(", ");
        const held = run.waiting.filter((entry) => entry.on.some((on) => blocked.some((piece) => piece.id === on))).map((entry) => numbers[entry.piece]);
        const running = run.pieces.some((piece) => piece.state === "running");
        return `${blocked.length === 1 ? `Piece ${names} is` : `Pieces ${names} are`} blocked.${held.length ? ` ${held.length === 1 ? `Piece ${held[0]} waits` : `Pieces ${held.join(", ")} wait`} for ${blocked.length === 1 ? "it" : "them"}${running ? "." : "; nothing else is running."}` : running ? "" : " Nothing else is running."}`;
      }
      if (!run.approval) return `${count} · started without approval, as this repository is set`;
      const since = relativeTime(run.approval.at);
      return `${count} · started ${since === "now" ? "just now" : /^\d/.test(since) ? `${since} ago` : since} · approved by you`;
    }
  }
}

function footnote(run: Run): string {
  const bypass = run.pieces.some((piece) => pieceMode(run, piece) === "bypassPermissions");
  const limits = "Push, merge and deploy stay blocked by deny rules.";
  return bypass ? `In bypass, workers are not asked before edits or commands. ${limits}` : `${limits} Each worker has its own worktree and branch, cut from the lead's.`;
}

/** Before a run starts: what it is expected to use, and what it runs with. */
function PlanSummary({ run }: { run: Run }) {
  const estimate = estimateText(run.estimate);
  const budget = budgetText(run);
  const without = run.unestimated;
  return (
    <section aria-label="Plan summary" className="mx-6 rounded-lg bg-well hairline">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2.5 text-[13px]">
        <Gauge aria-hidden className="size-4 shrink-0 text-faint" />
        <span className="text-muted-foreground">Estimated use</span>
        {estimate ? <>
          <span className="font-mono" data-testid="run-estimate">{estimate}</span>
          <span className="text-muted-foreground">API-equivalent{without > 0 ? `, for ${run.pieces.length - without} of ${run.pieces.length} pieces` : ""}</span>
        </> : <span className="text-muted-foreground" data-testid="run-estimate">not given: the plan carries no estimate</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline px-3.5 py-2.5 text-[13px]">
        <span className="flex items-center gap-2"><span className="text-muted-foreground">Budget</span>{budget ? <span className="inline-flex h-7 items-center rounded-md border border-hairline px-2 font-mono text-xs">{budget}</span> : <span className="text-faint">none set</span>}</span>
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">Workers run in</span>
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline px-2 text-xs"><ShieldOff aria-hidden className="size-3.5 text-accent" />{modeLabel(run.workerMode)}</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-add"><CircleCheck aria-hidden className="size-3.5" />No shared files</span>
      </div>
    </section>
  );
}

/** Once a run has started: how far it is, and what it runs with. */
function RunSummary({ run, spend }: { run: Run; spend: number | null }) {
  const done = run.pieces.filter((piece) => piece.state === "done").length;
  const budget = budgetText(run);
  const estimate = estimateText(run.estimate);
  const dollars = run.budget.dollars;
  const over = overBudget(run, spend);
  return (
    <section aria-label="Run summary" className="mx-6 grid grid-cols-1 gap-3 @[640px]/run:grid-cols-3">
      <div className="rounded-lg bg-well px-3.5 py-3 hairline">
        <div className="text-[11px] text-faint">Pieces</div>
        <div className="mt-1 text-[13px] text-muted-foreground"><span className="text-xl font-semibold text-foreground" data-testid="run-done">{done}</span> of {run.pieces.length} done</div>
        <div className="mt-2 flex gap-1" aria-hidden>
          {run.pieces.map((piece) => <span key={piece.id} className={cn("h-1 flex-1 rounded-full", piece.state === "done" ? "bg-add" : piece.state === "running" ? "bg-accent" : piece.state === "blocked" ? "bg-warning" : piece.state === "failed" ? "bg-destructive" : "bg-veil-strong")} />)}
        </div>
        <div className="mt-2 text-[11px] text-faint">{run.pieces.length - done} left</div>
      </div>
      <div className="rounded-lg bg-well px-3.5 py-3 hairline">
        <div className="text-[11px] text-faint">Spend{budget ? " · budget" : ""}</div>
        {/* Workers' cost as their sessions record it (PRO-273), against the dollars the plan allows. A points budget is shown as set: a run's share of a usage window is not measured. */}
        <div className="mt-1 text-[13px] text-muted-foreground" data-testid="run-spend">
          <span className={cn("text-xl font-semibold", over ? "text-destructive" : "text-foreground")}>{formatCost(spend ?? 0)}</span>
          {dollars != null ? ` of $${dollars.toFixed(2)}` : budget ? ` · budget ${budget}` : " spent"}
        </div>
        {dollars != null && dollars > 0 && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-veil-strong" aria-hidden>
            <div className={cn("h-full rounded-full", over ? "bg-destructive" : "bg-accent")} style={{ width: `${Math.min(100, ((spend ?? 0) / dollars) * 100)}%` }} />
          </div>
        )}
        <div className="mt-2 text-[11px] text-faint">{over ? "Over budget" : estimate ? `Estimated ${estimate} API-equivalent` : "The plan carries no estimate"}</div>
      </div>
      <div className="rounded-lg bg-well px-3.5 py-3 hairline">
        <div className="text-[11px] text-faint">Workers</div>
        <div className="mt-1 flex items-center gap-1.5 text-[13px]"><ShieldOff aria-hidden className="size-3.5 text-accent" />{modeLabel(run.workerMode)}</div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">{run.approval ? <><UserRoundCheck aria-hidden className="size-3" />Plan approved</> : "No approval asked"} · push, merge, deploy denied</div>
      </div>
    </section>
  );
}

/** A piece's first check, and how many more it has: a command by its terminal mark, a review point by its own. */
function DoneWhenCell({ piece }: { piece: RunPiece }) {
  const first = piece.doneChecks[0];
  if (!first) return <span className="text-faint">–</span>;
  const Icon = first.type === "command" ? Terminal : ScanSearch;
  return <>
    <Icon aria-label={first.type === "command" ? "Command" : first.type === "vote" ? "Vote" : "Review"} className="size-3.5 shrink-0 text-faint" />
    <span className="truncate">{checkText(first)}</span>
    {piece.doneChecks.length > 1 && <span className="shrink-0 text-faint">+{piece.doneChecks.length - 1}</span>}
  </>;
}

/** Where a piece's worker will act without being asked, when that needs saying. */
function modeWarning(run: Run, piece: RunPiece): { short: string; full: string } | null {
  const mode = pieceMode(run, piece);
  if (piece.readsUntrusted && mode === "bypassPermissions") return { short: "outside text · bypass", full: "Reads text from outside the repository, and will run in bypass" };
  if (piece.readsUntrusted) return { short: "outside text", full: "Reads text from outside the repository" };
  if (raisesMode(run, piece)) return { short: `runs in ${modeLabel(mode).toLowerCase()}`, full: `Asks for more than this repository's workers run in: ${modeLabel(mode)}` };
  return null;
}

function PieceTable({ run, numbers, selected, editable, busy, refused, costOf, onSelect, onChange }: {
  run: Run;
  numbers: Record<string, number>;
  selected: string | null;
  editable: boolean;
  busy: boolean;
  /** The piece the last refused change names. */
  refused?: string;
  /** What a piece's worker has cost so far; `null` with no worker or no price. */
  costOf: (piece: RunPiece) => number | null;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<RunPlanPiece>) => void;
}) {
  // The plan's columns before it starts; the run's once it has.
  const columns = editable
    ? "grid-cols-[minmax(0,1fr)_13.5rem] @[760px]/run:grid-cols-[minmax(0,1.4fr)_13.5rem_minmax(0,1fr)_3.5rem_5.5rem]"
    : "grid-cols-[minmax(0,1.5fr)_6.5rem_1.75rem] @[760px]/run:grid-cols-[minmax(0,1.5fr)_minmax(0,0.9fr)_6.5rem_3rem_4rem_minmax(0,1.2fr)_1.75rem]";
  const wide = "hidden @[760px]/run:block";
  const heads = editable ? [["Piece", ""], ["Model and effort", ""], ["Done when", wide], ["After", wide], ["Estimate", wide]] : [["Piece", ""], ["Model", wide], ["State", ""], ["Tries", wide], ["Cost", wide], ["Report", wide], ["", ""]];
  return (
    <div role="table" aria-label={editable ? "Plan" : "Pieces"} className="mt-4 border-t border-hairline">
      <div role="row" className={cn("grid items-center gap-x-4 border-b border-hairline px-6 py-2.5", columns)}>
        {heads.map(([label, visibility], index) => <div key={index} role="columnheader" className={cn(kicker, visibility)}>{label || <span className="sr-only">Worker</span>}</div>)}
      </div>
      {run.pieces.map((piece) => {
        const warning = modeWarning(run, piece);
        const after = piece.dependsOn.map((id) => numbers[id]).filter(Boolean).join(", ");
        return (
          <div
            key={piece.id}
            role="row"
            aria-selected={selected === piece.id}
            data-piece={piece.id}
            data-piece-state={piece.state}
            className={cn("grid cursor-default items-center gap-x-4 border-b border-hairline px-6 py-2", columns, selected === piece.id ? "bg-selected" : "hover:bg-veil-card", refused === piece.id && "shadow-[inset_2px_0_0_var(--destructive)]")}
            onClick={() => onSelect(piece.id)}
          >
            <div role="cell" className="flex min-w-0 items-center gap-3">
              <span className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-veil-raised text-[11px] text-muted-foreground">{numbers[piece.id]}</span>
              <span className="min-w-0">
                <button type="button" className="block max-w-full truncate text-left text-[13px] outline-none focus-visible:underline" onClick={() => onSelect(piece.id)}>{piece.title}</button>
                {/* What it owns is in its brief; a row with something to warn of says that instead. */}
                {warning
                  ? <span role="note" aria-label={warning.full} title={warning.full} className="flex min-w-0 items-center gap-1 text-[11.5px] text-warning"><ShieldAlert aria-hidden className="size-3 shrink-0" /><span className="truncate">{warning.short}</span></span>
                  : <span className="block truncate font-mono text-[11.5px] text-faint">{[piece.kind, piece.owns.length ? piece.owns.join(", ") : "changes no files"].filter(Boolean).join(" · ")}</span>}
              </span>
            </div>
            {editable ? (
              <div role="cell" className="min-w-0"><ModelAndEffort piece={piece} disabled={busy} onChange={(patch) => onChange(piece.id, patch)} /></div>
            ) : (
              <div role="cell" className={cn("min-w-0 truncate text-[13px]", wide)}><ModelName piece={piece} /></div>
            )}
            {editable ? <>
              <div role="cell" className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", wide, "@[760px]/run:flex")}><DoneWhenCell piece={piece} /></div>
              <div role="cell" className={cn("font-mono text-xs text-muted-foreground", wide)}>{after || "–"}</div>
              <div role="cell" className={cn("font-mono text-xs", wide)}>{estimateText(piece.estimate) ?? <span className="text-faint">–</span>}</div>
            </> : <>
              <div role="cell"><PieceStateMark state={piece.state} /></div>
              <div role="cell" className={cn("font-mono text-xs text-muted-foreground", wide)}>{piece.attempts || "–"}</div>
              <div role="cell" data-testid="piece-cost" className={cn("font-mono text-xs", wide)}>{piece.worker ? formatCost(costOf(piece)) : <span className="text-faint">–</span>}</div>
              <div role="cell" title={piece.note} className={cn("min-w-0 truncate text-xs", piece.state === "blocked" ? "text-warning" : piece.state === "failed" ? "text-destructive" : "text-muted-foreground", wide)}>{piece.note ?? (piece.state === "queued" && after ? `Waits for ${after}` : "")}</div>
              <div role="cell" className="flex justify-end">
                {piece.worker && (
                  <Button variant="ghost" size="icon-xs" aria-label={`Open the worker of ${piece.title}`} title="Open worker" onClick={(event) => { event.stopPropagation(); selectSession(piece.worker!.sessionId); }}>
                    <SquareArrowOutUpRight />
                  </Button>
                )}
              </div>
            </>}
          </div>
        );
      })}
    </div>
  );
}

function ModelName({ piece }: { piece: RunPiece }) {
  return <>
    <span>{piece.model ? modelLabel(piece.agent, piece.model) : `${piece.agent === "codex" ? "Codex" : "Claude"} default`}</span>{" "}
    <span className="text-muted-foreground">{piece.effort ? EFFORT_LABEL[piece.effort] ?? piece.effort : "Default"}</span>
  </>;
}

/** A piece's model and effort, changed where they are read: each change is saved as part of the plan. */
function ModelAndEffort({ piece, disabled, onChange }: { piece: RunPiece; disabled: boolean; onChange: (patch: Partial<RunPlanPiece>) => void }) {
  const models = useModels(piece.agent);
  const current = modelForTab(models, piece.model);
  const listed = models.some((model) => model.id === piece.model);
  const efforts = effortChoices(current, piece.effort);
  return (
    <span className="flex min-w-0 items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
      <select aria-label={`Model of ${piece.title}`} className={cn(cellSelect, "flex-1")} value={piece.model} disabled={disabled}
        onChange={(event) => {
          const next = modelForTab(models, event.target.value);
          // An effort the new model does not have goes back to that model's default.
          onChange({ model: event.target.value, effort: piece.effort && next?.efforts.includes(piece.effort) ? piece.effort : undefined });
        }}>
        <option value="">{piece.agent === "codex" ? "Codex" : "Claude"} default</option>
        {piece.model && !listed && <option value={piece.model}>{modelLabel(piece.agent, piece.model)}</option>}
        {models.map((model) => <option key={model.id} value={model.id} title={modelOptionText(model, models)}>{model.label}</option>)}
      </select>
      <select aria-label={`Effort of ${piece.title}`} className={cn(cellSelect, "w-[5.25rem] shrink-0")} value={piece.effort ?? ""} disabled={disabled} onChange={(event) => onChange({ effort: event.target.value || undefined })}>
        <option value="">Default</option>
        {efforts.map((effort) => <option key={effort} value={effort}>{EFFORT_LABEL[effort] ?? effort}</option>)}
      </select>
    </span>
  );
}

/** The run's own fields: what Edit plan changes. A piece is edited from its brief. */
function PlanForm({ run, busy, onCancel, onSave }: { run: Run; busy: boolean; onCancel: () => void; onSave: (plan: RunPlan) => void }) {
  const [goal, setGoal] = useState(run.goal);
  const [points, setPoints] = useState(run.budget.points == null ? "" : String(run.budget.points));
  const [dollars, setDollars] = useState(run.budget.dollars == null ? "" : String(run.budget.dollars));
  const amount = (text: string) => (text.trim() === "" || !Number.isFinite(Number(text)) || Number(text) < 0 ? undefined : Number(text));
  return (
    <form aria-label="Edit plan" className="mx-6 mb-3 flex flex-col gap-3 rounded-lg bg-well p-3.5 hairline" onSubmit={(event) => { event.preventDefault(); onSave({ ...planOf(run), goal, budget: { points: amount(points), dollars: amount(dollars) } }); }}>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">Goal
        <textarea className={cn(field, "min-h-[3.5rem] resize-y text-[13px] text-foreground")} value={goal} onChange={(event) => setGoal(event.target.value)} />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Budget, points
          <input type="number" min={0} step="any" className={cn(field, "w-28 text-foreground")} value={points} onChange={(event) => setPoints(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Budget, dollars
          <input type="number" min={0} step="any" className={cn(field, "w-28 text-foreground")} value={dollars} onChange={(event) => setDollars(event.target.value)} />
        </label>
        <span className="ml-auto flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || !goal.trim()}>Save plan</Button>
        </span>
      </div>
      <p className="text-[11px] text-faint">The budget is recorded with the run and shown here. To change a piece, open it and edit its brief.</p>
    </form>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <div className={kicker}>{title}</div>
      <div className="mt-1 text-[12.5px] leading-[19px]">{children}</div>
    </section>
  );
}

function Lines({ lines, empty }: { lines: string[]; empty: string }) {
  if (!lines.length) return <span className="text-faint">{empty}</span>;
  return lines.length === 1 ? <>{lines[0]}</> : <ul className="list-disc pl-4">{lines.map((line) => <li key={line}>{line}</li>)}</ul>;
}

/** One piece: its brief as its worker is sent it, and once it has a worker, where that stands. */
function PieceDetail({ run, piece, number, editable, busy, cost, onClose, onSave, onRemove }: {
  run: Run;
  piece: RunPiece;
  number: number;
  editable: boolean;
  busy: boolean;
  cost: number | null;
  onClose: () => void;
  onSave: (patch: Partial<RunPlanPiece>) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const mode = pieceMode(run, piece);
  const brief = piece.brief;
  return (
    <aside aria-label={`Piece ${number}: ${piece.title}`} data-testid="piece-detail" className="flex w-full shrink-0 flex-col border-t border-hairline bg-background @[900px]/run:min-h-0 @[900px]/run:w-[min(24rem,36%)] @[900px]/run:border-l @[900px]/run:border-t-0">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <span className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-veil-raised text-[11px] text-muted-foreground">{number}</span>
        <h2 className="min-w-0 truncate text-[13px] font-medium">{piece.title}</h2>
        <span className="shrink-0 text-xs text-faint">{editable ? "brief" : "piece"}</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close piece" onClick={onClose}><X /></Button>
      </header>
      {editing && editable ? (
        <BriefForm piece={piece} run={run} busy={busy} onCancel={() => setEditing(false)} onSave={async (patch) => { if (await onSave(patch)) setEditing(false); }} />
      ) : <>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scrollbar-thin">
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {editable ? (piece.kind ? <span className={chip}>{piece.kind}</span> : null) : <PieceStateMark state={piece.state} />}
            <span className="ml-auto text-[13px]"><ModelName piece={piece} /></span>
          </div>
          {!editable && (
            <Section title={piece.state === "done" ? "Result" : "Where it stands"}>
              {piece.note ?? (piece.state === "queued" ? (piece.dependsOn.length ? `Waits for ${piece.dependsOn.join(", ")}.` : "Not started yet.") : piece.state === "running" ? "Its worker is working." : "No report.")}
              {piece.branch && <div className="mt-1.5 break-all font-mono text-[11.5px] text-faint">{piece.branch}</div>}
            </Section>
          )}
          <Section title="Goal">{brief.goal}</Section>
          <Section title="Why">{brief.why || <span className="text-faint">The plan gives no reason beyond the run's goal.</span>}</Section>
          <Section title="Scope">
            {brief.scope && <div>{brief.scope}</div>}
            {piece.owns.length ? <div className="mt-1 flex flex-wrap gap-1.5">{piece.owns.map((path) => <code key={path} className={code}>{path}</code>)}</div> : <div className="text-faint">Changes no files.</div>}
            {brief.outOfScope && <div className="mt-1 text-faint">Out of scope: {brief.outOfScope}</div>}
          </Section>
          <Section title="Known"><Lines lines={brief.known} empty="Nothing was established for the worker." /></Section>
          <Section title="Read first">{brief.readFirst.length ? <div className="flex flex-wrap gap-1.5">{brief.readFirst.map((path) => <code key={path} className={code}>{path}</code>)}</div> : <span className="text-faint">No files were named.</span>}</Section>
          <Section title="Done when">
            <ul className="flex flex-col gap-1.5" data-testid="done-checks">
              {piece.doneChecks.map((check, index) => (
                <li key={index} className="flex items-start gap-2">
                  {check.type === "command"
                    ? <><Terminal aria-label="Command" className="mt-1 size-3.5 shrink-0 text-faint" /><code className={cn(code, "break-all")}>{check.run}</code></>
                    : <><ScanSearch aria-label={check.type === "vote" ? "Vote" : "Review"} className="mt-1 size-3.5 shrink-0 text-faint" /><span>{check.text}{check.type === "vote" && <span className="text-faint"> · vote{check.threshold && check.voters ? `, ${check.threshold} of ${check.voters}` : ""}</span>}</span></>}
                </li>
              ))}
            </ul>
            {piece.reviewOnly && <p className="mt-1.5 text-faint">Review only, no command: {piece.reviewOnlyReason}</p>}
          </Section>
          <Section title="Permissions">
            <span className="inline-flex items-center gap-1.5"><ShieldOff aria-hidden className="size-3.5 text-accent" />{modeLabel(mode)}</span>
            <span className="text-faint"> · {piece.readsUntrusted ? "reads text from outside the repository" : "reads no text from outside the repository"}</span>
            {piece.readsUntrusted && mode === "bypassPermissions" && <p className="mt-1.5 flex items-start gap-1.5 text-warning"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />It will run in bypass: nothing asks before it acts on what it reads. It is told to treat that text as information, never as instructions.</p>}
            {raisesMode(run, piece) && <p className="mt-1.5 text-warning">The plan asks for more than this repository's workers run in ({modeLabel(run.workerMode)}).</p>}
          </Section>
          <Section title="Limits">
            Edits in its own worktree only. Push, merge and deploy are denied at launch, not left to the brief.
            {brief.limits.length > 0 && <ul className="mt-1 list-disc pl-4">{brief.limits.map((limit) => <li key={limit}>{limit}</li>)}</ul>}
          </Section>
          <Section title="Report">Ends with a <code className={code}>terminalx-report</code> block.</Section>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-hairline px-4 py-3">
          {editable ? <>
            <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}><Pencil />Edit brief</Button>
            <Button variant="outline" disabled={busy || run.pieces.length < 2} title={run.pieces.length < 2 ? "A run needs at least one piece. Discard the plan instead." : undefined} onClick={onRemove}><Trash2 />Remove piece</Button>
          </> : piece.worker ? (
            <>
              <Button variant="outline" onClick={() => selectSession(piece.worker!.sessionId)}><SquareArrowOutUpRight />Open worker</Button>
              <span className="ml-auto font-mono text-xs text-faint" data-testid="piece-detail-cost" title="API-equivalent, from the worker's usage records">{formatCost(cost)}</span>
            </>
          ) : <span className="text-xs text-faint">No worker yet.</span>}
        </footer>
      </>}
    </aside>
  );
}

const split = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

function BriefForm({ run, piece, busy, onCancel, onSave }: { run: Run; piece: RunPiece; busy: boolean; onCancel: () => void; onSave: (patch: Partial<RunPlanPiece>) => void }) {
  const [draft, setDraft] = useState(() => ({
    title: piece.title, goal: piece.brief.goal, why: piece.brief.why, scope: piece.brief.scope, outOfScope: piece.brief.outOfScope,
    known: piece.brief.known.join("\n"), readFirst: piece.brief.readFirst.join("\n"), limits: piece.brief.limits.join("\n"), owns: piece.owns.join("\n"),
    commands: piece.doneChecks.filter((check) => check.type === "command").map(checkText).join("\n"),
    reviews: piece.doneChecks.filter((check) => check.type === "review").map(checkText).join("\n"),
    reviewOnly: !!piece.reviewOnly, reviewOnlyReason: piece.reviewOnlyReason ?? "",
    permissionMode: piece.permissionMode ?? "", readsUntrusted: piece.readsUntrusted,
  }));
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((before) => ({ ...before, [key]: value }));
  const text = (key: "title" | "goal" | "why" | "scope" | "outOfScope" | "known" | "readFirst" | "limits" | "owns" | "commands" | "reviews" | "reviewOnlyReason", label: string, hint?: string, rows = 2) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">{label}
      {rows === 1
        ? <input className={cn(field, "text-foreground")} value={draft[key]} onChange={(event) => set(key, event.target.value)} />
        : <textarea rows={rows} className={cn(field, "resize-y text-foreground")} value={draft[key]} onChange={(event) => set(key, event.target.value)} />}
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  );
  return (
    <form aria-label={`Edit the brief of ${piece.title}`} className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => {
      event.preventDefault();
      onSave({
        title: draft.title, goal: draft.goal, why: draft.why, scope: draft.scope, outOfScope: draft.outOfScope, known: split(draft.known), readFirst: split(draft.readFirst),
        limits: split(draft.limits), owns: split(draft.owns),
        doneChecks: checksFrom(draft.commands, draft.reviews, piece.doneChecks), reviewOnly: draft.reviewOnly || undefined, reviewOnlyReason: draft.reviewOnly ? draft.reviewOnlyReason : undefined,
        permissionMode: draft.permissionMode || undefined, readsUntrusted: draft.readsUntrusted,
      });
    }}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 scrollbar-thin">
        {text("title", "Title", undefined, 1)}
        {text("goal", "Goal")}
        {text("why", "Why")}
        {text("scope", "Scope")}
        {text("owns", "Files it owns", "One path a line. A directory means everything in it; no other piece may own the same file.", 3)}
        {text("outOfScope", "Out of scope")}
        {text("known", "Known", "One fact a line.", 3)}
        {text("readFirst", "Read first", "One path a line.")}
        {text("commands", "Done when: commands", "One a line. Each is run in the worker's worktree and must exit 0; checking by command uses no model.")}
        {text("reviews", "Done when: review points", "One a line. What a reviewer must confirm from the diff.")}
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input type="checkbox" className="mt-0.5" checked={draft.reviewOnly} onChange={(event) => set("reviewOnly", event.target.checked)} />
          <span>No command can prove this piece: check it by review alone</span>
        </label>
        {draft.reviewOnly && text("reviewOnlyReason", "Why no command can", "A piece with no command and no reason is refused.", 1)}
        {text("limits", "Limits of this piece", "One a line. Push, merge and deploy are denied whatever is written here.")}
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Permission mode
          <select className={cn(field, "text-foreground")} value={draft.permissionMode} onChange={(event) => set("permissionMode", event.target.value)}>
            <option value="">This repository's ({modeLabel(run.workerMode)})</option>
            {PERMISSION_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
          </select>
        </label>
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input type="checkbox" className="mt-0.5" checked={draft.readsUntrusted} onChange={(event) => set("readsUntrusted", event.target.checked)} />
          <span>Reads text from outside the repository (issues, web pages, logs from elsewhere)</span>
        </label>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-hairline px-4 py-3">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy || !draft.title.trim()}>Save brief</Button>
      </footer>
    </form>
  );
}

/** What the run waits on the person for (PRO-281): a blocked piece, a worker's question, spend past the budget. Each opens where it is answered. */
function RunNeeds({ needs, lead }: { needs: Need[]; lead: string }) {
  return (
    <section role="status" aria-label="Needs you" data-testid="run-needs" className="mx-6 mb-3 rounded-lg bg-accent/10 px-3 py-2 text-xs hairline">
      <div className="flex items-center gap-1.5 font-medium text-accent">
        {needs.every((need) => need.kind === "approval") ? <ShieldAlert aria-hidden className="size-3.5" /> : <CircleAlert aria-hidden className="size-3.5" />}
        {needs.every((need) => need.kind === "approval") ? "Needs approval" : "Needs you"}
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {needs.map((need) => (
          <li key={need.text} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={need.text}>{need.text}</span>
            {need.sessionId !== lead && <button type="button" className="shrink-0 text-muted-foreground outline-none hover:text-foreground focus-visible:underline" onClick={() => selectSession(need.sessionId)}>Open worker</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const SPLIT_WHEN: [boolean, string][] = [
  [true, "The pieces touch different files and can run at the same time"],
  [true, "The reading alone would fill one session's context"],
  [false, "Each step needs the one before it"],
  [false, "The whole task fits in one session"],
];

/** A session that leads no run: what a run is, the two ways to start one, and what this repository allows. */
function NoRun({ session, onShowChat }: { session: SessionEntry; onShowChat: () => void }) {
  const [limits, setLimits] = useState<{ requireApproval: boolean; pieceLimit: number; workerMode: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A session's tabs are its agents; the first is the one a run's lead is.
  const lead = session.tabs[0];
  useEffect(() => {
    let live = true;
    orchestration.limits(session.projectPath).then((loaded) => live && setLimits(loaded)).catch(() => null);
    return () => {
      live = false;
    };
  }, [session.projectPath]);

  const ask = async () => {
    if (!lead || busy) return;
    setBusy("ask");
    setError(null);
    try {
      await agentApi.send(session.id, lead.id, PLAN_A_RUN_PROMPT);
      onShowChat();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const choose = async () => {
    if (busy) return;
    setError(null);
    try {
      const path = await openFile({ multiple: false, directory: false, defaultPath: session.cwd, filters: [{ name: "Plan", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      setBusy("file");
      const file = await fs.readText(path);
      let plan: unknown;
      try {
        plan = JSON.parse(file.content);
      } catch (e) {
        throw new Error(`${path} is not JSON: ${errorMessage(e)}`);
      }
      noteRun(await orchestration.create(session.id, plan));
    } catch (e) {
      const refusal = refusalOf(e);
      setError(refusal.details?.piece && !refusal.message.includes(refusal.details.piece) ? `${refusal.message} (piece ${refusal.details.piece})` : refusal.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10 scrollbar-thin">
      <div className="mx-auto flex w-full max-w-[44.5rem] flex-col gap-6">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-veil-raised text-accent"><Network aria-hidden className="size-5" /></span>
          <div className="min-w-0">
            <h1 className="text-[19px] font-semibold leading-7 tracking-tight">This session has no run</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">A run splits one goal into pieces and gives each piece to a worker session on its own branch. This session becomes the lead: it plans the pieces, starts the workers and reads what they report.</p>
          </div>
        </div>
        <div className="rounded-lg bg-well hairline">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-veil-raised text-muted-foreground"><Sparkles aria-hidden className="size-4" /></span>
            <div className="min-w-0 flex-1 basis-[14rem]">
              <div className="text-[13px] font-medium">Ask the lead to plan a run</div>
              <div className="text-xs text-muted-foreground">It reads the task, decides whether splitting helps, and writes a plan for you to approve</div>
            </div>
            <Button variant="accent" disabled={!lead || !!busy} title={lead ? undefined : "This session has no agent to ask."} onClick={() => void ask()}>{busy === "ask" ? <LoaderCircle className="animate-spin" /> : <Play />}Plan a run</Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline px-4 py-3.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-veil-raised text-muted-foreground"><FileJson aria-hidden className="size-4" /></span>
            <div className="min-w-0 flex-1 basis-[14rem]">
              <div className="text-[13px] font-medium">Start from a plan file</div>
              <div className="mt-0.5"><code className={code}>terminalx runs create --from plan.json</code></div>
            </div>
            <Button variant="outline" disabled={!!busy} onClick={() => void choose()}>{busy === "file" ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}Choose file</Button>
          </div>
        </div>
        {error && <p role="alert" className="-mt-2 text-xs text-destructive">{error}</p>}
        <div className="grid grid-cols-1 gap-x-5 gap-y-6 @[640px]/run:grid-cols-2">
          <section aria-labelledby="run-split-when">
            <div id="run-split-when" className={cn(kicker, "flex h-6 items-center")}>Split when</div>
            <ul className="mt-2 flex flex-col gap-2.5 rounded-lg bg-well px-4 py-3.5 text-[13px] hairline">
              {SPLIT_WHEN.map(([split, line]) => (
                <li key={line} className="flex items-start gap-2.5">
                  {split ? <Check aria-label="Split" className="mt-0.5 size-3.5 shrink-0 text-add" /> : <X aria-label="Do not split" className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="run-in-project">
            <div className="flex h-6 items-center justify-between">
              <div id="run-in-project" className={kicker}>A run in this project</div>
              <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline" onClick={requestOrchestratorSettings}><Settings aria-hidden className="size-3" />Settings</button>
            </div>
            <dl className="mt-2 divide-y divide-hairline rounded-lg bg-well text-[13px] hairline" data-testid="run-limits">
              {([
                [ShieldAlert, "Waits for your approval", limits ? (limits.requireApproval ? "On" : "Off") : ""],
                [Layers, "Pieces, at most", limits ? String(limits.pieceLimit) : ""],
                [ShieldOff, "Workers run in", limits ? modeLabel(limits.workerMode) : ""],
              ] as const).map(([Icon, label, value]) => (
                <div key={label} className="flex items-center gap-2.5 px-4 py-2.5">
                  <Icon aria-hidden className="size-3.5 shrink-0 text-faint" />
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="ml-auto font-mono text-xs">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
