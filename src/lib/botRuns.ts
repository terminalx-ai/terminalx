import { relativeTime } from "@/lib/time";
import type { BotItem, BotItemActivity, BotItemCheckBack, BotItemRunView, BotRunPiece, BotRunTry } from "@/types/botItems";
import type { SessionEntry } from "@/types/session";

/**
 * What a bot's work items show of the orchestration runs they link (PRO-476): the plan's line, where a run is, its
 * hand-offs to workers in time order, and when the bot checks back. Pure: the views are in `components/bots/BotRuns`.
 */

export const usd = (value: number) => `$${value.toFixed(2)}`;
/** "$6", "$1.50": whole dollars when there are no cents, as the plan reads. */
const dollars = (value: number) => (Number.isInteger(value) ? `$${value}` : usd(value));

/** "3 pieces · est. $6 · 40 min": what the plan card's header and a Home card say of a run. */
export function runPlanLine(run: BotItemRunView): string {
  const pieces = run.pieces?.length ?? 0;
  const parts = [pieces === 1 ? "1 piece" : `${pieces} pieces`];
  if (run.estimate) parts.push(`est. ${run.estimate.low === run.estimate.high ? dollars(run.estimate.high) : `${dollars(run.estimate.low)}–${dollars(run.estimate.high)}`}`);
  if (run.minutes) parts.push(`${run.minutes} min`);
  return parts.join(" · ");
}

/** A piece's worker as the plan names it: "Codex · worker". */
export function workerLabel(agent: string, harnesses: { id: string; name: string }[] | undefined): string {
  return `${(harnesses ?? []).find((harness) => harness.id === agent)?.name ?? agent} · worker`;
}

/** What the row and chip helpers read of a run: an item's view of it, or the orchestrator's own. */
export interface RunLike {
  state?: string;
  pieces?: { state: string }[];
  gone?: boolean;
  holdMerge?: boolean;
  mergeApproved?: string | null;
}

/** The workers of `run` at work now. */
export function runningWorkers(run: RunLike): number {
  return (run.pieces ?? []).filter((piece) => piece.state === "running" || piece.state === "stalled" || piece.state === "verifying").length;
}

/** How a run's row says where it is: "plan waits for you", "2 workers running", "done". */
export function runStateLine(run: RunLike): string {
  if (run.gone) return "no longer kept";
  const working = runningWorkers(run);
  switch (run.state) {
    case "awaitingApproval":
      return "plan waits for you";
    case "planned":
      return "ready to start";
    case "running":
      return working === 0 ? "running · no worker at work" : working === 1 ? "1 worker running" : `${working} workers running`;
    case "needsYou":
      return "paused on its budget";
    case "verifying":
      return "checking results";
    case "merging":
      return run.holdMerge && !run.mergeApproved ? "ready · asks you before merging" : "merging";
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return run.state ?? "";
  }
}

/** The items of `items` whose question waits on a run (its approval or its merge), shown in chat `chatId`. */
export function runQuestionsIn(items: BotItem[], chatId: string, homeChat: boolean, chats: readonly SessionEntry[]): BotItem[] {
  const chatIds = new Set(chats.map((chat) => chat.id));
  return items.filter((item) => {
    const purpose = item.question?.purpose;
    if (purpose !== "startRun" && purpose !== "mergeRun") return false;
    const linked = (item.links ?? []).filter((link) => link.kind === "session").map((link) => link.target);
    // In the chat that links it; in the home chat when no chat of the bot does (it was asked from a session it started).
    return linked.includes(chatId) || (homeChat && !linked.some((id) => chatIds.has(id)));
  });
}

/** One hand-off to a worker, as the item's activity shows it: when, what, who and where, what it reported, its cost. */
export interface WorkerHandoff {
  at: string;
  run: string;
  piece: BotRunPiece;
  attempt: BotRunTry;
  /** Counted from 1: a second try is a new worker. */
  tryNumber: number;
}

/** Every piece the item's runs handed to a worker, oldest first. */
export function workerHandoffs(runs: BotItemRunView[]): WorkerHandoff[] {
  return runs
    .flatMap((run) => (run.pieces ?? []).flatMap((piece) => piece.tries.map((attempt, index) => ({ at: attempt.started ?? "", run: run.id, piece, attempt, tryNumber: index + 1 }))))
    .filter((handoff) => handoff.at && handoff.attempt.sessionId)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** The item's own activity and its hand-offs to workers, in time order. */
export function withHandoffs(activity: BotItemActivity[], runs: BotItemRunView[]): ({ kind: "entry"; entry: BotItemActivity } | { kind: "handoff"; handoff: WorkerHandoff })[] {
  const rows: ({ kind: "entry"; entry: BotItemActivity; at: string } | { kind: "handoff"; handoff: WorkerHandoff; at: string })[] = [
    ...activity.map((entry) => ({ kind: "entry" as const, entry, at: entry.at })),
    ...workerHandoffs(runs).map((handoff) => ({ kind: "handoff" as const, handoff, at: handoff.at })),
  ];
  // Stable: entries that share a time keep their own order.
  return rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.at.localeCompare(b.row.at) || a.index - b.index).map(({ row }) => (row.kind === "entry" ? { kind: "entry", entry: row.entry } : { kind: "handoff", handoff: row.handoff }));
}

export function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "13:40, or on a report": when the bot looks at the item again. */
export function checkBackText(checkBack: BotItemCheckBack | undefined): string | null {
  if (!checkBack) return null;
  if (checkBack.at) {
    const at = new Date(checkBack.at);
    const when = Number.isNaN(at.getTime()) ? checkBack.at : sameDay(at) ? clock(checkBack.at) : at.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
    return checkBack.onReport ? `${when}, or on a report` : when;
  }
  return checkBack.onReport ? "When a worker reports" : null;
}

export function sameDay(at: Date, now = new Date()): boolean {
  return at.toDateString() === now.toDateString();
}

/** A Home row's line for an item that links runs: "Run plan · 3 pieces", "2 workers running". */
export function itemRunChip(item: Pick<BotItem, "runViews" | "question">): string | null {
  const runs = (item.runViews ?? []).filter((run) => !run.gone);
  if (runs.length === 0) return null;
  const asked = runs.find((run) => run.id === item.question?.run);
  if (asked && item.question?.purpose === "startRun") return `Run plan · ${asked.pieces?.length === 1 ? "1 piece" : `${asked.pieces?.length ?? 0} pieces`}`;
  const working = runs.reduce((sum, run) => sum + runningWorkers(run), 0);
  if (working > 0) return working === 1 ? "1 worker running" : `${working} workers running`;
  return runStateLine(runs[runs.length - 1]);
}

/** When a started-by row's session last changed, or that it never started. */
export function startedStateLine(session: SessionEntry): string {
  if (session.tabs.some((tab) => tab.status === "in_progress")) return "working";
  if (session.tabs.some((tab) => tab.status === "waiting")) return "waits for you";
  const ran = session.tabs.some((tab) => !!tab.hasMessages || (tab.usage?.models ?? []).length > 0);
  return ran ? relativeTime(session.modified || session.created) : "not started";
}

/** The sessions a run's workers ran in, every try's. */
export function workerSessions(run: { pieces: { worker?: { sessionId: string } | null; tries?: { worker?: { sessionId: string } | null }[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const piece of run.pieces) {
    if (piece.worker?.sessionId) ids.add(piece.worker.sessionId);
    for (const attempt of piece.tries ?? []) if (attempt.worker?.sessionId) ids.add(attempt.worker.sessionId);
  }
  return ids;
}
