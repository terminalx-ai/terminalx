import { useEffect, useMemo, useState, type ReactNode } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { PieceStateMark } from "@/components/orchestration/PieceStateMark";
import {
  Check, CircleAlert, CircleCheck, CircleDashed, CircleX, Clock, FileJson, FolderOpen, Gauge, Info, Layers, LoaderCircle, Network, Pause, Pencil, Play, ScanSearch,
  Settings, ShieldAlert, ShieldOff, Sparkles, Square, SquareArrowOutUpRight, Terminal, Trash2, TriangleAlert, UserRoundCheck, X,
} from "@/icons";
import { agent as agentApi, errorMessage, fs, orchestration } from "@/lib/api";
import { cn } from "@/lib/cn";
import { EFFORT_LABEL, effortChoices, modeLabel, modelForTab, modelLabel, modelOptionText, PERMISSION_MODES, useModels } from "@/lib/models";
import {
  budgetText, checksFrom, checkText, costText, durationText, estimateText, fellShort, GATE_LABEL, GATE_ORDER, gaveUp, holdText, mainWindow, noteRun, pieceCheck, pieceMode, pieceNumbers,
  planOf, raisesMode, refusalOf, requestOrchestratorSettings, resetClock, reviewTokens, RUN_STATE_LABEL, TIER_DOT, tokensText, TRY_OUTCOME_LABEL, TRY_STEP_LABEL, useRun, verifyingText,
  windowLine, windowName, withoutPiece,
} from "@/lib/orchestration";
import { selectSession, useSessionStore } from "@/lib/sessions";
import { useSessionRowStatuses } from "@/lib/sessionRowStatus";
import { familyNeeds, overBudget, pieceSpend, runSpend, type Need } from "@/lib/runFamily";
import { formatCost } from "@/components/session/SessionCost";
import { SESSION_STATUSES } from "@terminalx/portable/sessionStatus";
import { relativeTime } from "@/lib/time";
import type { CommandRun, GateResult, PieceTry, Run, RunLimits, RunPiece, RunPlan, RunPlanPiece, RunReview, RunVerification, RunVerifier, Tier } from "@/types/orchestration";
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

/**
 * What each piece has cost, the run's spend, and what waits on the person: the
 * run's record of each try (PRO-275), with a current worker read from its
 * session as that changes (PRO-281).
 */
function useRunLedger(run: Run, lead: SessionEntry) {
  const { sessions } = useSessionStore();
  const byId = useMemo(() => new Map(sessions.map((entry) => [entry.id, entry])), [sessions]);
  const workers = useMemo(() => run.pieces.flatMap((piece) => (piece.worker && byId.get(piece.worker.sessionId) ? [byId.get(piece.worker.sessionId)!] : [])), [run, byId]);
  const statuses = useSessionRowStatuses(useMemo(() => [lead, ...workers], [lead, workers]));
  return useMemo(() => {
    const spend = runSpend(run, byId);
    const spent = new Map(run.pieces.map((piece) => [piece.id, pieceSpend(piece, byId)]));
    // `$0.61`, `$0.61+` when a model's tokens are not in it, `null` before any cost was read.
    const costOf = (piece: RunPiece) => {
      const { cost, unpriced } = spent.get(piece.id) ?? { cost: null, unpriced: [] };
      return cost == null ? null : `${formatCost(cost)}${unpriced.length ? "+" : ""}`;
    };
    const unpriced = [...spent.values()].some((piece) => piece.unpriced.length > 0) || !!run.costUnpricedModels?.length;
    // The lead's own chat is in front of the person already: the Run view lists what its run waits on.
    const needs = familyNeeds({ lead, leadStatus: NO_STATUS, run, workers, statusOf: (id) => statuses[id] ?? NO_STATUS, spend }).filter((need) => need.text !== "The plan waits for your approval");
    return { spend, unpriced, costOf, needs };
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
            {(run.state === "running" || run.state === "planned" || run.state === "needsYou" || run.state === "failed" || run.state === "verifying" || run.state === "merging") && (
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
        {run.state === "needsYou" && <PausedNotice run={run} busy={!!busy} act={act} />}
        {ledger.needs.length > 0 && <RunNeeds needs={ledger.needs} lead={lead.id} />}
        {run.reason && (run.state === "failed" || run.state === "stopped") && (
          <p role="status" className={cn("mx-6 mb-3 rounded-lg bg-well px-3 py-2 text-xs", run.state === "failed" ? "text-destructive" : "text-muted-foreground")}>{run.reason}</p>
        )}
        {editingPlan && editable && <PlanForm run={run} busy={!!busy} onCancel={() => setEditingPlan(false)} onSave={async (plan) => { if (await save(plan)) setEditingPlan(false); }} />}
        {editable ? <PlanSummary run={run} busy={!!busy} act={act} /> : <RunSummary run={run} spend={ledger.spend} unpriced={ledger.unpriced} />}
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
      // A run held up by a blocked piece, with nothing else running, says so (18.03); while workers run, the Needs you list names it.
      const blocked = run.pieces.filter((piece) => piece.state === "blocked");
      if (blocked.length && run.state === "running" && !run.pieces.some((piece) => piece.state === "running")) {
        const numbers = pieceNumbers(run);
        const names = blocked.map((piece) => numbers[piece.id]).join(", ");
        const held = run.waiting.filter((entry) => entry.on.some((on) => blocked.some((piece) => piece.id === on))).map((entry) => numbers[entry.piece]);
        return `${blocked.length === 1 ? `Piece ${names} is` : `Pieces ${names} are`} blocked.${held.length ? ` ${held.length === 1 ? `Piece ${held[0]} waits` : `Pieces ${held.join(", ")} wait`} for ${blocked.length === 1 ? "it" : "them"}; nothing else is running.` : " Nothing else is running."}`;
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
  const dollars = run.usage?.subscription && !run.usage.apiKey ? " Dollar figures are API-equivalent, not billed." : "";
  // Said once there are results to check: a plan that waits has none.
  const checked = run.state === "awaitingApproval" || run.state === "planned" ? "" : " A piece is done once its result has passed its checks.";
  return (bypass ? `In bypass, workers are not asked before edits or commands. ${limits}${checked}` : `${limits} Each worker has its own worktree and branch, cut from the lead's.${checked}`) + dollars;
}

/** The defaults of a run stored by a runtime older than PRO-280, which sends no limits. */
const DEFAULT_LIMITS: RunLimits = { workers: 4, dollars: 15, points: 25, ceiling: 85 };
const limitsOf = (run: Run): RunLimits => run.limits ?? DEFAULT_LIMITS;

type Act = (name: string, work: () => Promise<Run | null>) => Promise<boolean>;

/** The budget a run holds to, in the forms its workers' logins draw on. `null` when its runtime sends no limits. */
function heldBudget(run: Run): string | null {
  if (!run.limits || !run.usage) return null;
  const parts = [
    run.usage.subscription ? `${run.limits.points} points` : null,
    run.usage.apiKey ? `$${run.limits.dollars.toFixed(2)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** A number typed into a field: saved when the field is left or Enter is pressed, only when it is in range. */
function LimitField({ label, value, min, max, step = 1, prefix, suffix, disabled, onSave }: {
  label: string; value: number; min: number; max: number; step?: number; prefix?: string; suffix?: string; disabled: boolean; onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = Number(draft.trim());
    setDraft(null);
    if (draft.trim() !== "" && Number.isFinite(next) && next >= min && next <= max && next !== value) onSave(next);
  };
  return (
    <label className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline px-2 font-mono text-xs focus-within:ring-2 focus-within:ring-ring/40">
      {prefix && <span className="text-faint">{prefix}</span>}
      <input
        type="number" inputMode="decimal" aria-label={label} min={min} max={max} step={step} disabled={disabled}
        className="w-12 bg-transparent text-right tabular-nums outline-none disabled:opacity-60"
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
      {suffix && <span className="text-faint">{suffix}</span>}
    </label>
  );
}

/** This run's own worker limit and budget: the project's settings until the person changes them here. */
function LimitsEditor({ run, busy, act }: { run: Run; busy: boolean; act: Act }) {
  const limits = limitsOf(run);
  const save = (patch: Partial<RunLimits>) => void act("limits", () => orchestration.setLimits(run.id, { ...limits, ...patch }));
  const usage = run.usage;
  // Before any login is known (an old runtime), both forms are offered.
  const subscription = usage ? !!usage.subscription || !usage.apiKey : true;
  const apiKey = usage ? !!usage.apiKey || !usage.subscription : true;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Limits for this run" role="group">
      <span className="flex items-center gap-2 text-[13px]">
        <span className="text-muted-foreground">Workers at once</span>
        <LimitField label="Workers at once in this run" value={limits.workers} min={1} max={50} disabled={busy} onSave={(workers) => save({ workers })} />
      </span>
      {subscription && <>
        <span className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">Subscription</span>
          <LimitField label="Points of a window this run may use" value={limits.points} min={1} max={100} suffix="pts" disabled={busy} onSave={(points) => save({ points })} />
        </span>
        <span className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">Pause past</span>
          <LimitField label="Pause when a window passes" value={limits.ceiling} min={1} max={100} suffix="%" disabled={busy} onSave={(ceiling) => save({ ceiling })} />
        </span>
      </>}
      {apiKey && (
        <span className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">API key</span>
          <LimitField label="Dollars this run may spend" value={limits.dollars} min={0.01} max={10000} step={0.01} prefix="$" disabled={busy} onSave={(dollars) => save({ dollars })} />
        </span>
      )}
    </div>
  );
}

/** A run that reached its budget: why, and what the person can do. */
function PausedNotice({ run, busy, act }: { run: Run; busy: boolean; act: Act }) {
  const [raising, setRaising] = useState(false);
  const pause = run.pause;
  const resetsAt = pause?.window?.resetsAt;
  const resumeAt = pause?.resumeAt;
  return (
    <section role="status" aria-label="Run paused" className="mx-6 mb-3 flex flex-col gap-2.5 rounded-lg bg-warning/10 px-3.5 py-3 hairline" data-testid="run-paused">
      <div className="flex items-start gap-2 text-[13px]">
        <Pause aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{pause?.window ? `Paused: the ${windowName(pause.window)} window` : pause?.kind === "dollars" ? "Paused: the dollar budget" : "Paused"}</div>
          <p className="mt-0.5 text-muted-foreground">{pause?.message ?? run.reason}</p>
          <p className="mt-1 text-xs text-faint">Workers already in a turn finish it; no new piece starts until you let the run go on.</p>
        </div>
      </div>
      {resumeAt ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="run-resumes-at"><Clock aria-hidden className="size-3.5" />Goes on by itself at {resetClock(resumeAt)}, when the window resets.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {resetsAt && <Button size="sm" variant="accent" disabled={busy} onClick={() => void act("resume", async () => (await orchestration.resume(run.id, true)).run)}><Clock />Resume after the reset, {resetClock(resetsAt)}</Button>}
          <Button size="sm" variant="outline" disabled={busy} aria-pressed={raising} onClick={() => setRaising((on) => !on)}>Raise the budget</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("resume", async () => (await orchestration.resume(run.id, false)).run)}><Play />Resume now</Button>
        </div>
      )}
      {raising && <LimitsEditor run={run} busy={busy} act={act} />}
    </section>
  );
}

/** Before a run starts: what it is expected to use, and what it runs with. */
function PlanSummary({ run, busy, act }: { run: Run; busy: boolean; act: Act }) {
  const estimate = estimateText(run.estimate);
  const budget = heldBudget(run) ?? budgetText(run);
  const fit = run.fit ?? [];
  const windows = run.usage?.windows ?? [];
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
      <div className="flex flex-col gap-2 border-t border-hairline px-3.5 py-2.5">
        <LimitsEditor run={run} busy={busy} act={act} />
        {windows.length > 0 && (
          <p className="text-xs text-faint" data-testid="run-windows">{windows.map((window) => `${windowName(window)} at ${Math.round(window.percent)}%${window.resetsAt ? `, resets ${resetClock(window.resetsAt)}` : ""}`).join(" · ")}. A run's points are the change in the window while it runs; the window is shared with everything else you run.</p>
        )}
        {fit.map((warning) => (
          <p key={warning} role="alert" className="flex items-start gap-1.5 text-xs text-warning"><TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{warning}</p>
        ))}
      </div>
    </section>
  );
}

/** Once a run has started: how far it is, and what it runs with. */
function RunSummary({ run, spend, unpriced }: { run: Run; spend: number | null; unpriced: boolean }) {
  const done = run.pieces.filter((piece) => piece.state === "done").length;
  const budget = budgetText(run);
  const estimate = estimateText(run.estimate);
  const limits = limitsOf(run);
  const dollars = run.budget.dollars;
  const over = overBudget(run, spend);
  return (
    <section aria-label="Run summary" className="mx-6 grid grid-cols-1 gap-3 @[640px]/run:grid-cols-3">
      <div className="rounded-lg bg-well px-3.5 py-3 hairline">
        <div className="text-[11px] text-faint">Pieces</div>
        <div className="mt-1 text-[13px] text-muted-foreground"><span className="text-xl font-semibold text-foreground" data-testid="run-done">{done}</span> of {run.pieces.length} done</div>
        <div className="mt-2 flex gap-1" aria-hidden>
          {run.pieces.map((piece) => <span key={piece.id} className={cn("h-1 flex-1 rounded-full", piece.state === "done" ? "bg-add" : piece.state === "running" ? "bg-accent" : piece.state === "stalled" ? "bg-warning" : piece.state === "verifying" ? "bg-info" : piece.state === "failed" ? "bg-destructive" : piece.state === "blocked" ? "bg-warning" : "bg-veil-strong")} />)}
        </div>
        <div className="mt-2 text-[11px] text-faint">{run.pieces.length - done} left</div>
      </div>
      {/* A runtime that knows how its workers sign in (PRO-280) shows the run's own limits; an older one, the plan's budget. */}
      {run.usage ? <BudgetCard run={run} estimate={estimate} spend={spend} unpriced={unpriced} /> : (
        <div className="rounded-lg bg-well px-3.5 py-3 hairline">
          <div className="text-[11px] text-faint">Spend{budget ? " · budget" : ""}</div>
          {/* Workers' cost as their sessions record it (PRO-273), against the dollars the plan allows. A points budget is shown as set: a run's share of a usage window is not measured. */}
          <div className="mt-1 text-[13px] text-muted-foreground" data-testid="run-spend">
            <span className={cn("text-xl font-semibold", over ? "text-destructive" : "text-foreground")}>{formatCost(spend ?? 0)}{unpriced ? "+" : ""}</span>
            {dollars != null ? ` of $${dollars.toFixed(2)}` : budget ? ` · budget ${budget}` : " spent"}
          </div>
          {dollars != null && dollars > 0 && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-veil-strong" aria-hidden>
              <div className={cn("h-full rounded-full", over ? "bg-destructive" : "bg-accent")} style={{ width: `${Math.min(100, ((spend ?? 0) / dollars) * 100)}%` }} />
            </div>
          )}
          <div className="mt-2 text-[11px] text-faint">{over ? "Over budget" : estimate ? `Estimated ${estimate} API-equivalent` : "The plan carries no estimate"}{unpriced ? " · a model's tokens have no price" : ""}</div>
        </div>
      )}
      <div className="rounded-lg bg-well px-3.5 py-3 hairline">
        <div className="text-[11px] text-faint">Workers</div>
        <div className="mt-1 text-[13px] text-muted-foreground" data-testid="run-workers">
          <span className="text-xl font-semibold text-foreground">{run.inTurn ?? run.pieces.filter((piece) => piece.state === "running").length}</span> running · {limits.workers} at a time
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-faint">
          <span className="flex items-center gap-1"><ShieldOff aria-hidden className="size-3 text-accent" />{modeLabel(run.workerMode)}</span>·
          <span className="flex items-center gap-1">{run.approval ? <><UserRoundCheck aria-hidden className="size-3" />Plan approved</> : "No approval asked"}</span>· push, merge, deploy denied
        </div>
      </div>
    </section>
  );
}

/** The run's budget against its own limits (PRO-280): points of the window it draws on most, dollars on an API key, or both.
 * `spend` is what its workers' tries cost so far as their sessions record it (PRO-273), every try included. */
function BudgetCard({ run, estimate, spend, unpriced }: { run: Run; estimate: string | null; spend: number | null; unpriced: boolean }) {
  const limits = limitsOf(run);
  const dollars = spend ?? run.usage?.dollars ?? 0;
  const over = dollars >= limits.dollars;
  const window = run.usage ? mainWindow(run) : null;
  const subscription = !!run.usage?.subscription;
  const apiKey = !!run.usage?.apiKey;
  const kind = subscription && apiKey ? "subscription and API key" : subscription ? "subscription" : apiKey ? "API key" : null;
  const plan = budgetText(run);
  return (
    <div className="rounded-lg bg-well px-3.5 py-3 hairline" data-testid="run-budget">
      <div className="text-[11px] text-faint">Budget{kind ? ` · ${kind}` : ""}</div>
      {subscription && (
        <div className="mt-1 text-[13px] text-muted-foreground">
          <span className="text-xl font-semibold text-foreground">{Math.round(window?.points ?? 0)}</span> of {limits.points} points
        </div>
      )}
      {apiKey && <div className={cn("text-[13px] text-muted-foreground", !subscription && "mt-1")}><span className={cn("font-semibold", over ? "text-destructive" : "text-foreground", !subscription && "text-xl")}>${dollars.toFixed(2)}{unpriced ? "+" : ""}</span> of ${limits.dollars.toFixed(2)}</div>}
      {!kind && <div className="mt-1 text-[13px]">{plan ? <span className="font-mono">{plan}</span> : <span className="text-muted-foreground">None set by the plan</span>}</div>}
      <div className="mt-2 text-[11px] text-faint">
        {window ? `${windowLine(window)} · pauses past ${limits.ceiling}%` : apiKey && over ? "Over budget" : estimate ? `Estimated ${estimate} API-equivalent` : "The plan carries no estimate"}
        {unpriced ? " · a model's tokens have no price" : ""}
      </div>
    </div>
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
  costOf: (piece: RunPiece) => string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<RunPlanPiece>) => void;
}) {
  // The plan's columns before it starts; the run's once it has.
  const columns = editable
    ? "grid-cols-[minmax(0,1fr)_13.5rem] @[760px]/run:grid-cols-[minmax(0,1.4fr)_13.5rem_minmax(0,1fr)_3.5rem_5.5rem]"
    : "grid-cols-[minmax(0,1.5fr)_6.5rem_1.75rem] @[760px]/run:grid-cols-[minmax(0,1.3fr)_minmax(8.75rem,1fr)_6rem_2.5rem_3.5rem_minmax(0,1fr)_1.75rem]";
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
              <div role="cell" className={cn("font-mono text-xs text-muted-foreground", wide)}>{piece.tries?.length || piece.attempts || "–"}</div>
              <div role="cell" data-testid="piece-cost" className={cn("font-mono text-xs", wide)}>{costOf(piece) ?? <span className="text-faint">–</span>}</div>
              <div role="cell" title={piece.note} className={cn("min-w-0 truncate text-xs", piece.state === "blocked" ? "text-warning" : piece.state === "failed" ? "text-destructive" : "text-muted-foreground", wide)} data-testid="piece-report">{reportLine(piece, after, limitsOf(run))}</div>
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

/** What a row says of its piece: what it waits on while it is checked, else its worker's line, and that a verifier passed it. */
function reportLine(piece: RunPiece, after: string, limits: RunLimits): string {
  if (piece.state === "verifying") return verifyingText(piece);
  const check = pieceCheck(piece);
  const read = piece.state === "done" && check?.outcome === "passed" && check.review ? (check.review.voters === 1 ? "verifier passed" : `${check.review.verifiers.filter((verifier) => verifier.verdict === "pass").length} of ${check.review.voters} verifiers passed`) : "";
  const queued = piece.state === "queued" ? (piece.queuedFor ? holdText({ limits }, piece.queuedFor) : after ? `Waits for ${after}` : "") : "";
  return [piece.note ?? queued, read].filter(Boolean).join(", ");
}

/** A model and effort as a row names them, marked with its tier's colour when it has a tier. */
function ModelName({ piece }: { piece: Pick<RunPiece, "agent" | "model" | "effort"> & { tier?: Tier } }) {
  return <>
    {piece.tier && <span aria-hidden className={cn("mr-1.5 inline-block size-1.5 rounded-full bg-current align-middle", TIER_DOT[piece.tier])} />}
    <span>{piece.model ? modelLabel(piece.agent, piece.model) : `${piece.agent === "codex" ? "Codex" : "Claude"} default`}</span>{" "}
    <span className="text-muted-foreground">{piece.effort ? EFFORT_LABEL[piece.effort] ?? piece.effort : "Default"}</span>
  </>;
}

/** What a try came to, in the words its row shows: a label, the line after it, and for a failed check what the check printed. */
function tryResult(attempt: PieceTry): { label: string; text: string; output: string[]; tone: string } {
  if (!attempt.outcome) return attempt.worker ? { label: "Running", text: "", output: [], tone: "text-accent" } : { label: "Waiting for its worker", text: "", output: [], tone: "text-faint" };
  const detail = attempt.detail ?? "";
  const tone = fellShort(attempt) ? "text-destructive" : attempt.outcome === "done" ? "text-foreground" : "text-warning";
  const label = TRY_OUTCOME_LABEL[attempt.outcome];
  const failed = attempt.verification?.gates.find((gate) => !gate.passed);
  // A check TerminalX ran: which gate, in a line. What it printed is shown with the checks, below the tries.
  if (attempt.outcome === "checkFailed" && failed) return { label, text: gateFailureLine(failed), output: [], tone };
  if (attempt.outcome === "checkFailed") {
    const [first = "", ...rest] = detail.split("\n");
    // The end of what the check printed: that is where a test run says what failed.
    return { label, text: first.replace(/^The done-check did not hold:\s*/, ""), output: rest.filter((line) => line.trim()).slice(-8), tone };
  }
  return { label, text: detail.replace(/^The worker reported (failed|partial):\s*/, "").replace(/^Reported (partial|blocked):\s*/, ""), output: [], tone };
}

/** A failed gate in a line: the command and how it exited, the files out of scope, or the first thing the gate said. */
function gateFailureLine(gate: GateResult): string {
  const command = gate.commands?.find((ran) => !ran.passed);
  if (command) return `${command.run} ${command.exitCode != null ? `exited ${command.exitCode}` : "did not finish"}`;
  const lines = (gate.detail ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const named = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
  if (gate.gate === "scope" && named.length) return `changed ${named.join(", ")}, outside its files`;
  if (gate.gate === "review" && named.length) return named[0];
  return `${GATE_LABEL[gate.gate].toLowerCase()}: ${lines[0] ?? "failed"}`;
}

/** One command of the command gate: what was run, how it ended, and for one that failed the end of what it printed. */
function CommandCard({ command }: { command: CommandRun }) {
  const lines = (command.output ?? "").split("\n").filter((line) => line.trim()).slice(-12);
  return (
    <div className="mt-2 rounded-lg bg-well px-3 py-2.5 hairline" data-testid="done-check" data-check={command.passed ? "passed" : "failed"}>
      <div className="flex items-center gap-2 text-xs">
        <Terminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{command.project ? "Project check" : "Done-check"}</span>
        <span className={cn("ml-auto shrink-0", command.passed ? "text-add" : "text-destructive")}>
          {command.passed ? `passed · ${durationText(command.millis)}` : command.exitCode != null ? `failed · exit ${command.exitCode}` : "failed · did not finish"}
        </span>
      </div>
      <div className="mt-1 break-all font-mono text-xs">{command.run}</div>
      {lines.length > 0 && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[17px] text-muted-foreground scrollbar-thin">
          {lines.map((line, index) => <div key={index}>{line.split(/(FAILED|panicked|error(?=[:\[]))/).map((part, at) => (at % 2 ? <span key={at} className="text-destructive">{part}</span> : part))}</div>)}
        </pre>
      )}
    </div>
  );
}

/** One verifier, or the verifiers of a vote: why a model was asked, what each said, and what it used. */
function ReviewCard({ agent, review, check }: { agent: string; review: RunReview; check: RunVerification }) {
  const tokens = tokensText(reviewTokens(review));
  const passes = review.verifiers.filter((verifier) => verifier.verdict === "pass").length;
  const status = check.outcome === "passed" ? { text: review.voters === 1 ? "passed" : `passed · ${passes} of ${review.voters}`, tone: "text-add" }
    : check.outcome === "failed" ? { text: review.voters === 1 ? "failed" : `failed · ${passes} of ${review.voters} passed`, tone: "text-destructive" }
    : check.outcome === "inconclusive" ? { text: "no verdict", tone: "text-warning" }
    : { text: "reading", tone: "text-info" };
  const said = (verifier: RunVerifier) => (verifier.verdict === "pass" ? "Pass" : verifier.verdict === "fail" ? "Fail" : verifier.problem ? "No verdict" : "Reading");
  return (
    <div className="mt-2 rounded-lg bg-well px-3 py-2.5 hairline" data-testid="piece-review" data-review={check.outcome ?? "open"}>
      <div className="flex items-center gap-2 text-xs">
        <ScanSearch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{review.voters === 1 ? "Verifier" : `Vote · ${review.threshold} of ${review.voters} must pass`}</span>
        <span className={cn("ml-auto shrink-0", status.tone)}>{status.text}{tokens ? <span className="text-faint" title="What the verifier sessions used, apart from the worker"> · {tokens}</span> : null}</span>
      </div>
      <ul className="mt-1 text-[12px] leading-[18px] text-muted-foreground">{review.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <ul className="mt-2 flex flex-col gap-2">
        {review.verifiers.map((verifier, index) => (
          <li key={index} className="text-xs" data-verdict={verifier.verdict ?? (verifier.problem ? "none" : "open")}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate"><ModelName piece={{ agent, model: verifier.model, effort: verifier.effort }} /></span>
              <span className={cn("shrink-0", verifier.verdict === "pass" ? "text-add" : verifier.verdict === "fail" ? "text-destructive" : verifier.problem ? "text-warning" : "text-info")}>{said(verifier)}</span>
              {verifier.session && <button type="button" className="ml-auto shrink-0 text-[11.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline" onClick={() => selectSession(verifier.session!.sessionId)}>Open</button>}
            </div>
            {(verifier.evidence?.length ?? 0) > 0 && <ul className="mt-1 list-disc break-words pl-4 font-mono text-[11.5px] leading-[17px] text-muted-foreground">{verifier.evidence!.map((line) => <li key={line}>{line}</li>)}</ul>}
            {verifier.problem && <p className="mt-1 text-[11.5px] leading-[17px] text-faint">{verifier.problem}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How a result was checked: each gate in the order it ran, the commands as TerminalX ran them, and the verifier when one was asked.
 * The check shown is the current try's, or the last one a try had: a piece waiting for its next worker shows why it went back. */
function Checks({ piece }: { piece: RunPiece }) {
  const tries = piece.tries ?? [];
  let at = tries.length - 1;
  while (at >= 0 && !tries[at].verification) at -= 1;
  if (at < 0) return null;
  const check = tries[at].verification!;
  const failed = check.gates.find((gate) => !gate.passed);
  const commands = check.gates.flatMap((gate) => gate.commands ?? []);
  const outside = failed?.gate === "scope" ? (failed.detail ?? "").split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2)) : [];
  // The gate under way: the first that has not run, while nothing has failed and the check is open.
  const next = !failed && !check.outcome ? GATE_ORDER.find((gate) => !check.gates.some((ran) => ran.gate === gate) && (gate !== "review" || !!check.review)) : undefined;
  return (
    <Section title={at === tries.length - 1 ? "Checks" : `Checks of try ${at + 1}`}>
      <div data-testid="piece-checks" data-check-outcome={check.outcome ?? "open"}>
        <ol aria-label="Gates" className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
          {GATE_ORDER.map((gate) => {
            const ran = check.gates.find((result) => result.gate === gate);
            const state = ran ? (ran.passed ? "passed" : "failed") : gate === next || (gate === "review" && check.review && !check.outcome) ? "running" : failed ? "skipped" : check.outcome ? "notNeeded" : "waiting";
            const Icon = state === "passed" ? CircleCheck : state === "failed" ? CircleX : state === "running" ? LoaderCircle : CircleDashed;
            const unasked = gate === "commands" && !ran && !!check.facts?.commandsNotRun;
            const words = unasked ? "not run" : state === "notNeeded" ? (gate === "commands" ? "no command" : "not needed") : state === "skipped" ? "not run" : state;
            return (
              <li key={gate} data-gate={gate} data-gate-state={state} title={ran?.detail ?? (unasked ? "Not run: nobody approved this plan, and this piece's worker is asked before it runs a command. A verifier read the result instead." : state === "skipped" ? "A check before it failed, so it did not run." : state === "notNeeded" && gate === "review" ? "The checks before it passed and nothing called for a reader: no model was asked." : undefined)}
                className={cn("inline-flex items-center gap-1 whitespace-nowrap", state === "passed" ? "text-add" : state === "failed" ? "text-destructive" : state === "running" ? "text-info" : "text-faint")}>
                <Icon aria-hidden className="size-3 shrink-0" />
                <span className={state === "passed" || state === "failed" ? "text-foreground" : undefined}>{GATE_LABEL[gate]}</span>
                <span className="sr-only">: {words}</span>
              </li>
            );
          })}
        </ol>
        {failed && !failed.commands?.length && failed.gate !== "review" && (
          <p className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-[18px] text-destructive" data-testid="gate-failure">{failed.detail}</p>
        )}
        {outside.length > 0 && (
          <p role="note" className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-[12.5px] leading-[18px]">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>The change is outside this piece's files. A worker may not edit another piece's files.</span>
          </p>
        )}
        {commands.map((command, index) => <CommandCard key={index} command={command} />)}
        {check.review && <ReviewCard agent={piece.agent} review={check.review} check={check} />}
        {check.outcome === "passed" && !check.review && <p className="mt-2 text-[11.5px] leading-[17px] text-faint">Accepted without a model: the checks above were enough.</p>}
        {check.outcome === "inconclusive" && <p className="mt-2 text-[12.5px] leading-[18px] text-warning">{check.failure}</p>}
      </div>
    </Section>
  );
}

/** Every try of a piece, oldest first: what it ran on, what it cost, why it was made, and how it ended. */
function Tries({ piece }: { piece: RunPiece }) {
  const tries = piece.tries ?? [];
  return (
    <ol aria-label="Tries" className="mt-2" data-testid="piece-tries">
      {tries.map((attempt, index) => {
        const result = tryResult(attempt);
        const cost = costText(attempt.costUsd, attempt.costUnpricedModels);
        return (
          <li key={index} className="flex gap-3" data-try={index + 1} data-try-outcome={attempt.outcome ?? (attempt.worker ? "running" : "waiting")}>
            <div className="flex flex-col items-center">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-veil-raised text-[11px] text-muted-foreground">{index + 1}</span>
              {index < tries.length - 1 && <span aria-hidden className="mt-1 flex-1 border-l border-hairline" />}
            </div>
            <div className="min-w-0 flex-1 pb-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="min-w-0 truncate"><ModelName piece={{ agent: piece.agent, model: attempt.model, effort: attempt.effort, tier: attempt.tier }} /></span>
                {attempt.worker && <button type="button" className="ml-auto shrink-0 text-[11.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline" onClick={() => selectSession(attempt.worker!.sessionId)}>Open worker</button>}
                <span className={cn("shrink-0 font-mono text-[11.5px] text-faint", !attempt.worker && "ml-auto")} title={attempt.costUnpricedModels?.length ? `Without ${attempt.costUnpricedModels.join(", ")}: no price is known for it` : "At API list prices"}>{cost ?? "–"}</span>
              </div>
              <div className="mt-0.5 text-[11.5px] leading-4 text-faint">{TRY_STEP_LABEL[attempt.step]}</div>
              <div className={cn("mt-1 line-clamp-3 break-words text-[12.5px] leading-[18px]", result.tone)} title={result.text || undefined}>
                {result.label}{result.text ? `: ${result.text}` : ""}
              </div>
              {result.output.length > 0 && <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-well px-2 py-1.5 font-mono text-[11.5px] leading-[17px] text-muted-foreground hairline scrollbar-thin">{result.output.join("\n")}</pre>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A piece's model and effort, changed where they are read: each change is saved as part of the plan. */
function ModelAndEffort({ piece, disabled, onChange }: { piece: RunPiece; disabled: boolean; onChange: (patch: Partial<RunPlanPiece>) => void }) {
  const models = useModels(piece.agent);
  const current = modelForTab(models, piece.model);
  const listed = models.some((model) => model.id === piece.model);
  const efforts = effortChoices(current, piece.effort);
  // The empty choice is "not named by the plan": the piece's kind decides, and it shows what that came to.
  const byKind = piece.kind ? `by kind: ${piece.kind}` : "by kind";
  const kindModel = piece.model ? modelLabel(piece.agent, piece.model) : `${piece.agent === "codex" ? "Codex" : "Claude"} default`;
  return (
    <span className="flex min-w-0 items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
      <select aria-label={`Model of ${piece.title}`} className={cn(cellSelect, "flex-1")} value={piece.modelByKind ? "" : piece.model} disabled={disabled} title={piece.modelByKind ? `From the routing table, ${byKind}` : undefined}
        onChange={(event) => {
          const next = modelForTab(models, event.target.value);
          // An effort the new model does not have goes back to that model's default; one the kind chose stays the kind's.
          onChange({ model: event.target.value, effort: !piece.effortByKind && piece.effort && next?.efforts.includes(piece.effort) ? piece.effort : undefined });
        }}>
        {/* No model named: the plan is stored again with the routing table's model for the piece's kind. */}
        <option value="">{piece.modelByKind ? `${kindModel} (${byKind})` : `By kind${piece.kind ? ` (${piece.kind})` : ""}`}</option>
        {piece.model && !listed && <option value={piece.model}>{modelLabel(piece.agent, piece.model)}</option>}
        {models.map((model) => <option key={model.id} value={model.id} title={modelOptionText(model, models)}>{model.label}</option>)}
      </select>
      <select aria-label={`Effort of ${piece.title}`} className={cn(cellSelect, "w-[5.25rem] shrink-0")} value={piece.effortByKind ? "" : piece.effort ?? ""} disabled={disabled} title={piece.effortByKind ? `From the routing table, ${byKind}` : undefined} onChange={(event) => onChange({ effort: event.target.value || undefined })}>
        <option value="">{piece.effortByKind && piece.effort ? EFFORT_LABEL[piece.effort] ?? piece.effort : "Default"}</option>
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
  cost: string | null;
  onClose: () => void;
  onSave: (patch: Partial<RunPlanPiece>) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const mode = pieceMode(run, piece);
  const brief = piece.brief;
  const tries = piece.tries ?? [];
  const maxTries = run.maxTries ?? 3;
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
            {!editable && piece.state === "done" && pieceCheck(piece)?.outcome === "passed" && <span className="text-xs text-muted-foreground" data-testid="piece-check-passed">· {pieceCheck(piece)?.review ? "checked and read" : "check passed"}</span>}
            {!editable && (tries.length > 1 || gaveUp(piece)) && <span className="text-xs text-muted-foreground" data-testid="piece-tries-used">· {tries.length} of {maxTries} tries used</span>}
            <span className="ml-auto text-[13px]"><ModelName piece={piece} /></span>
          </div>
          {piece.modelNote && (
            <p role="note" className="-mt-2 mb-4 flex items-start gap-1.5 text-xs text-warning"><CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{piece.modelNote}</p>
          )}
          {!editable && tries.length > 0 && <Section title="Tries"><Tries piece={piece} /></Section>}
          {!editable && <Checks piece={piece} />}
          {!editable && (
            <Section title={piece.state === "done" ? "Result" : "Where it stands"}>
              {piece.note ?? (piece.state === "queued" ? (piece.queuedFor ? `${holdText({ limits: limitsOf(run) }, piece.queuedFor)}.` : piece.dependsOn.length ? `Waits for ${piece.dependsOn.join(", ")}.` : "Not started yet.") : piece.state === "running" ? "Its worker is working." : "No report.")}
              {piece.state === "verifying" && <div className="mt-1 text-info">{verifyingText(piece)}. Nothing that depends on it starts until it has passed.</div>}
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
              <span className="ml-auto font-mono text-xs text-faint" data-testid="piece-detail-cost" title="API-equivalent, from the workers' usage records">{cost ?? "–"}</span>
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
