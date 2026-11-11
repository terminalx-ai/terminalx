import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { orchestration } from "@/lib/api";
import type { PieceState, Run, RunCheck, RunEstimate, RunHold, RunLimits, RunPiece, RunPlan, RunRefusal, RunState, RunWindowUse } from "@/types/orchestration";

/** The runs this window has heard of, by the session that leads each: a lead has one run to show, its newest. */
let runs: Record<string, Run | null> = {};
const listeners = new Set<() => void>();
let booted = false;

function publish(next: Record<string, Run | null>) {
  runs = next;
  listeners.forEach((listener) => listener());
}

function upsert(run: Run) {
  const shown = runs[run.lead.sessionId];
  // An older run of the same lead does not replace the newer one on screen.
  if (shown && shown.id !== run.id && shown.created > run.created) return;
  publish({ ...runs, [run.lead.sessionId]: run });
}

async function read(sessionId: string) {
  try {
    const run = await orchestration.runForSession(sessionId);
    publish({ ...runs, [sessionId]: run ?? null });
  } catch {
    // Not read is not "has none": the view keeps what it had.
  }
}

function boot() {
  if (booted) return;
  booted = true;
  void listen<Run>("orchestration_run", (event) => upsert(event.payload)).catch(() => null);
  // What changed while the runtime was away was not announced: read again what is on screen.
  void listen("local_runtime_reattached", () => { for (const sessionId of Object.keys(runs)) void read(sessionId); }).catch(() => null);
}

/** The run `sessionId` leads: `undefined` until read, `null` when it leads none. */
export function useRun(sessionId: string | undefined, enabled = true): Run | null | undefined {
  const all = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => runs,
    () => runs,
  );
  useEffect(() => {
    if (!enabled || !sessionId) return;
    boot();
    void read(sessionId);
  }, [enabled, sessionId]);
  return enabled && sessionId ? all[sessionId] : undefined;
}

/** What an action returned: shown at once, ahead of the event that follows it. */
export function noteRun(run: Run) {
  upsert(run);
}

export function resetRunsForTests() {
  runViews = {};
  runs = {};
  booted = false;
  listeners.clear();
}

/** A refused action as the engine said it. It arrives as JSON inside the error's text
 * (the runtime's reply is a message); anything else is shown as it is. */
export function refusalOf(error: unknown): RunRefusal {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  const from = text.indexOf("{");
  if (from >= 0) {
    try {
      const parsed = JSON.parse(text.slice(from, text.lastIndexOf("}") + 1)) as Partial<RunRefusal>;
      if (typeof parsed.code === "string" && typeof parsed.message === "string") return parsed as RunRefusal;
    } catch {
      /* not a refusal's JSON */
    }
  }
  return { code: "error", message: text };
}

/** The plan a stored run came from, for Edit: what `orchestration_update_plan` takes back. */
export function planOf(run: Run): RunPlan {
  return {
    goal: run.goal,
    budget: run.budget,
    pieces: run.pieces.map((piece) => ({
      id: piece.id,
      title: piece.title,
      goal: piece.brief.goal,
      why: piece.brief.why,
      scope: piece.brief.scope,
      outOfScope: piece.brief.outOfScope,
      known: piece.brief.known,
      readFirst: piece.brief.readFirst,
      limits: piece.brief.limits,
      owns: piece.owns,
      dependsOn: piece.dependsOn,
      doneChecks: piece.doneChecks,
      reviewOnly: piece.reviewOnly,
      reviewOnlyReason: piece.reviewOnlyReason,
      kind: piece.kind,
      agent: piece.agent,
      model: piece.model,
      effort: piece.effort,
      permissionMode: piece.permissionMode,
      readsUntrusted: piece.readsUntrusted,
      estimate: piece.estimate,
    })),
  };
}

/** The plan without one piece, and without the other pieces' dependencies on it. */
export function withoutPiece(plan: RunPlan, id: string): RunPlan {
  return { ...plan, pieces: plan.pieces.filter((piece) => piece.id !== id).map((piece) => ({ ...piece, dependsOn: piece.dependsOn.filter((on) => on !== id) })) };
}

/** The mode a piece's worker runs in: the one it was started in, else the plan's, else the run's. */
export function pieceMode(run: Pick<Run, "workerMode">, piece: Pick<RunPiece, "permissionMode" | "startedMode">): string {
  return piece.startedMode ?? piece.permissionMode ?? run.workerMode;
}

/** How much a mode lets an agent do unasked, least first (`plan::allows` in the engine). */
const ALLOWS = ["plan", "manual", "acceptEdits", "auto", "bypassPermissions"];
/** Whether a piece asks for more than the run's own mode: what the person approving is shown. */
export function raisesMode(run: Pick<Run, "workerMode">, piece: Pick<RunPiece, "permissionMode">): boolean {
  return !!piece.permissionMode && ALLOWS.indexOf(piece.permissionMode) > ALLOWS.indexOf(run.workerMode);
}

/** A check in a line: the command, or the words to confirm. */
export function checkText(check: RunCheck): string {
  return check.type === "command" ? check.run : check.text;
}

/** A piece's checks from what Edit holds: commands and review points a line each, and the votes it had, untouched. */
export function checksFrom(commands: string, reviews: string, before: RunCheck[]): RunCheck[] {
  const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  return [
    ...lines(commands).map((run): RunCheck => ({ type: "command", run })),
    ...lines(reviews).map((text): RunCheck => ({ type: "review", text })),
    ...before.filter((check) => check.type === "vote"),
  ];
}

/** `$0.05`, `$1.60–2.40`: one figure when the range is a point. */
export function estimateText(estimate: RunEstimate | null | undefined): string | null {
  if (!estimate) return null;
  const money = (value: number) => value.toFixed(2);
  return estimate.low === estimate.high ? `$${money(estimate.low)}` : `$${money(estimate.low)}–${money(estimate.high)}`;
}

/** `25 points`, `$15.00`, or both; `null` when the plan set none. */
export function budgetText(run: Pick<Run, "budget">): string | null {
  const parts = [
    run.budget.points != null ? `${run.budget.points} ${run.budget.points === 1 ? "point" : "points"}` : null,
    run.budget.dollars != null ? `$${run.budget.dollars.toFixed(2)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export const RUN_STATE_LABEL: Record<RunState, string> = {
  planned: "Ready to start",
  awaitingApproval: "Plan waiting for you",
  running: "Run",
  needsYou: "Run paused, needs you",
  verifying: "Checking results",
  merging: "Merging",
  done: "Run done",
  stopped: "Run stopped",
  failed: "Run failed",
};

export const PIECE_STATE_LABEL: Record<PieceState, string> = {
  queued: "Queued",
  running: "Running",
  stalled: "Stalled",
  done: "Done",
  blocked: "Blocked",
  failed: "Failed",
  stopped: "Stopped",
};

/** The 1-based place of each piece in the plan: what "After" names, as the plan's rows are numbered. */
export function pieceNumbers(run: Pick<Run, "pieces">): Record<string, number> {
  return Object.fromEntries(run.pieces.map((piece, index) => [piece.id, index + 1]));
}

const settingsRequests = new Set<() => void>();
/** Open Settings → Orchestrator, from wherever a run's limits are shown. */
export function requestOrchestratorSettings() {
  settingsRequests.forEach((listener) => listener());
}
export function onOrchestratorSettingsRequest(listener: () => void): () => void {
  settingsRequests.add(listener);
  return () => {
    settingsRequests.delete(listener);
  };
}

/** Which sessions show their Run view in place of the chat. Kept while the window lives: a session comes back as it was left. */
let runViews: Record<string, boolean> = {};
const runViewListeners = new Set<() => void>();
export function showRunView(sessionId: string, shown: boolean) {
  if (!!runViews[sessionId] === shown) return;
  runViews = { ...runViews, [sessionId]: shown };
  runViewListeners.forEach((listener) => listener());
}
export function useRunViewShown(sessionId: string): boolean {
  const all = useSyncExternalStore(
    (listener) => {
      runViewListeners.add(listener);
      return () => runViewListeners.delete(listener);
    },
    () => runViews,
    () => runViews,
  );
  return !!all[sessionId];
}

/** `16:10`, or `Tue 16:10` when not today: when a usage window resets. */
export function resetClock(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** `Claude 5h`: a window by its agent, as the status bar labels it. */
export function windowName(window: Pick<RunWindowUse, "agent" | "label">): string {
  const agent = window.agent === "claude" ? "Claude" : window.agent === "codex" ? "Codex" : window.agent;
  return `${agent} ${window.label}`;
}

/** `5h window at 41% · resets 16:10`. */
export function windowLine(window: RunWindowUse, now = Date.now()): string {
  const reset = window.resetsAt ? ` · resets ${resetClock(window.resetsAt, now)}` : "";
  return `${window.label} window at ${Math.round(window.percent)}%${reset}`;
}

/** The window the run has used most of: what its points budget is read against. */
export function mainWindow(run: Pick<Run, "usage">): RunWindowUse | null {
  const windows = run.usage?.windows ?? [];
  if (!windows.length) return null;
  return [...windows].sort((a, b) => b.points - a.points || b.percent - a.percent)[0];
}

/** Why a queued piece the lead asked for has not started. */
export function holdText(run: { limits: RunLimits }, hold: RunHold): string {
  switch (hold) {
    case "runLimit":
      return `Queued: ${run.limits.workers} ${run.limits.workers === 1 ? "worker" : "workers"} at a time in this run`;
    case "appLimit":
      return "Queued: the app runs as many workers as it allows";
    case "budget":
      return "Waits for you: the run reached its budget";
  }
}
