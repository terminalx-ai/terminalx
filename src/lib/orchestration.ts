import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { orchestration } from "@/lib/api";
import type {
  PieceKind, PieceState, PieceTry, Route, RoutedAgent, RoutingRows, RoutingTable, Run, RunCheck, RunEstimate, RunGate, RunHold, RunLimits, RunPiece, RunPlan, RunRefusal, RunReview, RunState, RunVerification,
  RunWindowUse, Tier, TryOutcome, TryStep,
} from "@/types/orchestration";

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
      // What its kind chose is not the plan's to name: left out, the routing table chooses again,
      // and a piece whose tier has no installed model keeps saying so.
      model: piece.modelByKind ? "" : piece.model,
      effort: piece.effortByKind ? undefined : piece.effort,
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

/** The kinds of piece, in the routing table's order, and what each is used for (`routing::KINDS`). */
export const PIECE_KINDS: { kind: PieceKind; usedFor: string }[] = [
  { kind: "search", usedFor: "Finding files, listing call sites" },
  { kind: "logs", usedFor: "Reading test output and logs" },
  { kind: "scoped-code", usedFor: "A bug fix or a change with a clear spec" },
  { kind: "review", usedFor: "Reviewing a diff" },
  { kind: "code", usedFor: "Everyday engineering" },
  { kind: "refactor", usedFor: "Architecture, large refactors" },
  { kind: "research", usedFor: "Deep research and analysis" },
  { kind: "verify", usedFor: "Checking a worker's result" },
];

export const ROUTED_AGENTS: { agent: RoutedAgent; name: string }[] = [
  { agent: "claude", name: "Claude Code" },
  { agent: "codex", name: "Codex" },
];

/** Tiers, smallest first, with the family each agent has there (`Tier::family`). */
export const TIERS: { tier: Tier; label: string; family: Record<RoutedAgent, string> }[] = [
  { tier: "small", label: "Small", family: { claude: "Haiku", codex: "Luna" } },
  { tier: "mid", label: "Mid", family: { claude: "Sonnet", codex: "Terra" } },
  { tier: "large", label: "Large", family: { claude: "Opus", codex: "Sol" } },
  { tier: "top", label: "Top", family: { claude: "Fable", codex: "Astra" } },
];

/** The efforts a row of the table may name, lowest first (`routing::EFFORTS`). */
export const ROUTE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The built-in table (`routing::default_route`): what a row is when nobody changed it. */
export function defaultRoute(kind: PieceKind): Route {
  switch (kind) {
    case "search":
    case "logs":
      return { tier: "small" };
    case "code":
      return { tier: "large", effort: "medium" };
    case "refactor":
    case "research":
      return { tier: "top", effort: "medium" };
    default:
      return { tier: "mid", effort: "medium" };
  }
}

export function sameRoute(a: Route | undefined, b: Route | undefined): boolean {
  return a?.tier === b?.tier && (a?.effort ?? null) === (b?.effort ?? null);
}

/** The app's table: its changed rows over the built-in ones. */
export function appRouting(rows: RoutingRows | undefined): RoutingTable {
  return Object.fromEntries(
    PIECE_KINDS.map(({ kind }) => [kind, Object.fromEntries(ROUTED_AGENTS.map(({ agent }) => [agent, rows?.[kind]?.[agent] ?? defaultRoute(kind)]))]),
  ) as RoutingTable;
}

/** The colour a tier is marked with, wherever a model of it is named. */
export const TIER_DOT: Record<Tier, string> = { small: "text-info", mid: "text-add", large: "text-accent", top: "text-merged" };

/** What made a try differ from the one before it, as the tries of a piece say it. */
export const TRY_STEP_LABEL: Record<TryStep, string> = {
  first: "First try",
  retry: "Retried with the failure text",
  effort: "Retried with the failure text, effort raised one level",
  tier: "Moved up one model at one effort level lower",
};

/** How a try ended, in a word or two; a try with no outcome is under way or not yet started. */
export const TRY_OUTCOME_LABEL: Record<TryOutcome, string> = {
  done: "Done",
  failed: "Failed",
  partial: "Partial",
  checkFailed: "Check failed",
  blocked: "Blocked",
  stopped: "Stopped",
};

/** Whether a try fell short in a way the next one may fix (`Outcome::fell_short`). */
export function fellShort(attempt: Pick<PieceTry, "outcome">): boolean {
  return attempt.outcome === "failed" || attempt.outcome === "partial" || attempt.outcome === "checkFailed";
}

/** `$0.61`; `$0.61+` when a model's tokens are not in it; `null` before any cost was read. */
export function costText(cost: number | null | undefined, unpriced?: string[]): string | null {
  if (cost == null) return null;
  return `$${cost.toFixed(2)}${unpriced?.length ? "+" : ""}`;
}

/** What a piece's tries cost so far: the run's own sum when it sent one, else the tries added up. */
export function pieceCost(piece: Pick<RunPiece, "tries" | "costUsd" | "costUnpricedModels">): { cost: number | null; unpriced: string[] } {
  const tries = piece.tries ?? [];
  const known = tries.filter((attempt) => attempt.costUsd != null);
  const cost = piece.costUsd !== undefined ? piece.costUsd : known.length ? known.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0) : null;
  const unpriced = piece.costUnpricedModels ?? [...new Set(tries.flatMap((attempt) => attempt.costUnpricedModels ?? []))];
  return { cost, unpriced };
}

/** The ladder ran out: the piece is blocked and its last try fell short (`Piece::gave_up`). */
export function gaveUp(piece: Pick<RunPiece, "state" | "tries">): boolean {
  const last = piece.tries?.[piece.tries.length - 1];
  return piece.state === "blocked" && !!last && fellShort(last);
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
  verifying: "Verifying",
  done: "Done",
  blocked: "Blocked",
  failed: "Failed",
  stopped: "Stopped",
};

/** A gate as a row names it (`verify::Gate`), in the order they run. */
export const GATE_LABEL: Record<RunGate, string> = {
  report: "Report",
  scope: "Scope",
  branch: "Branch state",
  commands: "Command checks",
  review: "Review",
};
export const GATE_ORDER: RunGate[] = ["report", "scope", "branch", "commands", "review"];

/** The check of a piece's current try, when it has one. */
export function pieceCheck(piece: Pick<RunPiece, "tries">): RunVerification | undefined {
  return piece.tries?.[piece.tries.length - 1]?.verification;
}

/** What a piece being checked waits on: the gates TerminalX runs itself, or a verifier's answer. */
export function verifyingText(piece: Pick<RunPiece, "tries">): string {
  const review = pieceCheck(piece)?.review;
  if (!review) return "Running its checks";
  if (review.voters === 1) return "Waiting on the verifier";
  const answered = review.verifiers.filter((verifier) => verifier.verdict || verifier.problem).length;
  return `Waiting on verifiers, ${answered} of ${review.voters} answered`;
}

/** `38s`, `2m 05s`: how long a command ran. */
export function durationText(millis: number): string {
  const seconds = Math.max(1, Math.round(millis / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** `5.2k tokens`, `870 tokens`; `null` before any was read. */
export function tokensText(tokens: number | null | undefined): string | null {
  if (tokens == null) return null;
  return `${tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k` : tokens} tokens`;
}

/** What a review's verifiers used together; `null` before any was read. */
export function reviewTokens(review: RunReview | undefined): number | null {
  const read = (review?.verifiers ?? []).filter((verifier) => verifier.tokens);
  return read.length ? read.reduce((sum, verifier) => sum + verifier.tokens!.input + verifier.tokens!.output + verifier.tokens!.cacheRead + verifier.tokens!.cacheWrite, 0) : null;
}

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
