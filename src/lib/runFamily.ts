import type { StatusDescription } from "@terminalx/portable/sessionStatus";
import { modelLabel } from "@/lib/models";
import { donePieces, pieceCost } from "@/lib/orchestration";
import { conversationTitle } from "@/lib/sessions";
import { sessionModels, totals } from "@/components/session/SessionCost";
import type { PieceState, PieceTry, Run, RunPiece } from "@/types/orchestration";
import type { SessionEntry } from "@/types/session";

/**
 * A lead and the sessions it started, as the sidebar draws them (PRO-281). A
 * session nests under the session that started it (`parent`, PRO-270) when
 * that session is listed beside it, whatever worktree either runs in. Workers
 * of workers nest under the same lead, one level, unless the one between leads
 * a run (`runs`, by its lead's id): a lead a coordinator started keeps its own
 * workers under it, and sits among its coordinator's (PRO-364).
 */
export function nestWorkers(
  sessions: readonly SessionEntry[],
  runs: Readonly<Record<string, Run | null | undefined>> = {},
): { top: SessionEntry[]; workersOf: Record<string, SessionEntry[]> } {
  const listed = new Map(sessions.map((session) => [session.id, session]));
  const leadOf = (session: SessionEntry): string | null => {
    const seen = new Set([session.id]);
    let lead: string | null = null;
    for (let at = session.parent?.sessionId; at && listed.has(at); at = listed.get(at)!.parent?.sessionId) {
      // A loop in the records (each started by the other) nests nothing.
      if (seen.has(at)) return null;
      seen.add(at);
      lead = at;
      // The nearest session that leads a run holds what is under it.
      if (runs[at]) break;
    }
    if (!lead) return null;
    // A loop further up still nests nothing.
    for (let at = listed.get(lead)!.parent?.sessionId; at && listed.has(at); at = listed.get(at)!.parent?.sessionId) {
      if (seen.has(at)) return null;
      seen.add(at);
    }
    return lead;
  };
  const top: SessionEntry[] = [];
  const workersOf: Record<string, SessionEntry[]> = {};
  for (const session of sessions) {
    const lead = leadOf(session);
    if (lead) (workersOf[lead] ??= []).push(session);
    else top.push(session);
  }
  return { top, workersOf };
}

/** Whether `id` is in the family under `lead`, at any depth: an open session holds every lead above it unfolded. */
export function familyHolds(workersOf: Readonly<Record<string, readonly SessionEntry[]>>, lead: string, id: string | null): boolean {
  if (!id) return false;
  const seen = new Set<string>([lead]);
  const queue = [lead];
  while (queue.length) {
    for (const worker of workersOf[queue.shift()!] ?? []) {
      if (worker.id === id) return true;
      if (!seen.has(worker.id)) {
        seen.add(worker.id);
        queue.push(worker.id);
      }
    }
  }
  return false;
}

/** The piece a session works on in `run` as its current worker, if it is. */
export function pieceOf(run: Run | null | undefined, sessionId: string): RunPiece | null {
  return run?.pieces.find((piece) => piece.worker?.sessionId === sessionId) ?? null;
}

/** Which try at a piece a session ran: 1 for the first. `current` while it is the piece's worker now. */
export interface WorkerTry {
  piece: RunPiece;
  /** Where the piece is in the plan. */
  index: number;
  number: number;
  /** How many tries the piece has had, this one included: past one, every try's row says which it is. */
  of: number;
  current: boolean;
  /** The try's own record, absent for a piece that keeps none. */
  attempt?: PieceTry;
}

/**
 * The try a session ran at a piece of `run`, the current one or an earlier one
 * (PRO-364): every try's worker is in `piece.tries[]`, the current one also in
 * `piece.worker`.
 */
export function tryOf(run: Run | null | undefined, sessionId: string): WorkerTry | null {
  for (const [index, piece] of (run?.pieces ?? []).entries()) {
    const tries = piece.tries ?? [];
    const at = tries.findIndex((attempt) => attempt.worker?.sessionId === sessionId);
    const current = piece.worker?.sessionId === sessionId;
    const of = Math.max(1, tries.length);
    if (at >= 0) return { piece, index, number: at + 1, of, current, attempt: tries[at] };
    if (current) return { piece, index, number: of, of, current };
  }
  return null;
}

/**
 * A lead's workers in the run's order: its pieces first, as the plan numbers
 * them, each piece's tries in the order they ran, then any other session it started.
 */
export function orderWorkers(workers: readonly SessionEntry[], run: Run | null | undefined): SessionEntry[] {
  if (!run) return [...workers];
  const place = new Map(workers.map((worker) => {
    const found = tryOf(run, worker.id);
    return [worker.id, found ? [found.index, found.number] : [Infinity, 0]] as const;
  }));
  return [...workers].sort((a, b) => {
    const [pa, ta] = place.get(a.id)!;
    const [pb, tb] = place.get(b.id)!;
    return pa === pb ? ta - tb : pa - pb;
  });
}

/**
 * What a session's row under its lead is called (PRO-364): its piece's title
 * when it ran one, else the session's own title. Never its tab's, which for a
 * worker is the first line of the brief it was sent.
 */
export function workerTitle(session: SessionEntry, found: Pick<WorkerTry, "piece"> | null): string {
  return found?.piece.title ?? (session.title?.trim() || conversationTitle(session));
}

/** A piece the sidebar lists before its worker exists: queued, and no worker started for it yet (18.03, 18.07). */
export function awaitsWorker(piece: RunPiece): boolean {
  return piece.state === "queued" && !piece.worker;
}

/** One row under a lead: a worker's session, or a queued piece whose worker has not started. */
export type FamilyRow = { kind: "worker"; session: SessionEntry } | { kind: "queued"; piece: RunPiece };

/**
 * The rows under a lead, in the run's order: each piece where the plan numbers
 * it, as its worker's row (each earlier try's too) or, before that worker
 * starts, as the queued piece; then any other session the lead started. A piece's worker row takes the
 * place its queued row had.
 */
export function familyRows(workers: readonly SessionEntry[], run: Run | null | undefined): FamilyRow[] {
  const ordered = orderWorkers(workers, run);
  if (!run) return ordered.map((session) => ({ kind: "worker", session }));
  // Every try's worker sits in its piece's place, not only the current one's (PRO-364).
  const rows: { at: number; row: FamilyRow }[] = [
    ...ordered.map((session) => ({ at: tryOf(run, session.id)?.index ?? Infinity, row: { kind: "worker", session } as FamilyRow })),
    ...run.pieces.flatMap((piece, index) => (awaitsWorker(piece) ? [{ at: index, row: { kind: "queued", piece } as FamilyRow }] : [])),
  ];
  // Stable: workers keep `orderWorkers`' order among themselves, and a piece has one row.
  return rows.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1)).map(({ row }) => row);
}

export function runProgress(run: Pick<Run, "pieces">): { done: number; total: number } {
  return { done: donePieces(run).length, total: run.pieces.length };
}

/** What a session has cost, API-equivalent: `null` when nothing it used has a price, or it has used nothing. */
export function sessionSpend(session: SessionEntry | undefined): number | null {
  if (!session) return null;
  const rows = sessionModels(session);
  return rows.length ? totals(rows).costUsd : null;
}

/**
 * What a piece's workers have cost so far, API-equivalent. The run records each
 * try's cost (PRO-275), so a retried piece counts every worker it had; its
 * current worker is read from its session as that changes (PRO-281), since the
 * run catches up with a worker's usage only when it next looks. `null` while
 * none of it has a price.
 */
export function pieceSpend(piece: RunPiece, sessions: ReadonlyMap<string, SessionEntry>): { cost: number | null; unpriced: string[] } {
  const recorded = pieceCost(piece);
  const live = piece.worker ? sessionSpend(sessions.get(piece.worker.sessionId)) : null;
  if (live == null) return recorded;
  const tries = piece.tries ?? [];
  const last = tries[tries.length - 1];
  const earlier = last && last.worker?.sessionId === piece.worker!.sessionId ? tries.slice(0, -1) : tries;
  const before = earlier.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
  return { cost: before + live, unpriced: recorded.unpriced };
}

/** What the run's workers have cost so far: the sum of the pieces with a price, `null` while none has one. */
export function runSpend(run: Run, sessions: ReadonlyMap<string, SessionEntry>): number | null {
  let sum: number | null = null;
  for (const piece of run.pieces) {
    const { cost } = pieceSpend(piece, sessions);
    if (cost != null) sum = (sum ?? 0) + cost;
  }
  return sum;
}

/** Past the dollars the plan allows. A points budget is not measured per run, so it is never "over". */
export function overBudget(run: Pick<Run, "budget">, spend: number | null): boolean {
  return typeof run.budget.dollars === "number" && spend != null && spend > run.budget.dollars;
}

/** A row's model as one word, `Sonnet`, and the colour 18.07 draws it in. */
export function modelTier(agent: string, model: string | null | undefined): { text: string; className: string } {
  if (!model) return { text: "Default", className: "text-faint" };
  const label = modelLabel(agent, model);
  const word = /\b(haiku|sonnet|opus|fable)\b/i.exec(label)?.[1] ?? /\b(haiku|sonnet|opus|fable)\b/i.exec(model)?.[1];
  if (!word) return { text: label.split(/\s+/)[0] || label, className: "text-muted-foreground" };
  const tier = word[0].toUpperCase() + word.slice(1).toLowerCase();
  const className = { Haiku: "text-info", Sonnet: "text-add", Opus: "text-accent", Fable: "text-merged" }[tier] ?? "text-muted-foreground";
  return { text: tier, className };
}

/** The model a worker runs on: the plan's choice, else what its agent is running. */
export function workerModel(piece: RunPiece | null, session: SessionEntry): { agent: string; model: string | null } {
  const tab = session.tabs.find((entry) => entry.id === session.activeTab) ?? session.tabs[0];
  if (piece?.model) return { agent: piece.agent, model: piece.model };
  return { agent: piece?.agent ?? tab?.harness ?? "claude", model: tab?.model || null };
}

/** Something in a lead's family that waits on the person, with what to tell them. */
export interface Need {
  /** `approval`: an answer or an approval (one "Needs approval" mark). `attention`: anything else ("Needs you"). */
  kind: "approval" | "attention";
  /** The session to open for it: the worker's, or the lead's for the run itself. */
  sessionId: string;
  text: string;
  /** A blocked piece, by id: the Run view says it in its subtitle and its panel, not in a list. */
  piece?: string;
}

const waitsOnPerson = (status: StatusDescription) => status.label === "Needs approval" || status.label === "Needs you";

/**
 * What a lead's family waits on the person for, most pressing first: the
 * lead's own status, the run's plan waiting for approval, a run over its
 * budget, then each worker that asks for an answer and each piece that is
 * blocked. A blocked piece whose worker also asks is listed once.
 */
export function familyNeeds({ lead, leadStatus, run, workers, statusOf, spend }: {
  lead: SessionEntry;
  leadStatus: StatusDescription;
  run: Run | null | undefined;
  workers: readonly SessionEntry[];
  statusOf: (sessionId: string) => StatusDescription;
  spend: number | null;
}): Need[] {
  const needs: Need[] = [];
  const kind = (status: StatusDescription): Need["kind"] => (status.label === "Needs approval" ? "approval" : "attention");
  if (waitsOnPerson(leadStatus)) needs.push({ kind: kind(leadStatus), sessionId: lead.id, text: `Lead: ${leadStatus.detail}` });
  if (run?.state === "awaitingApproval") needs.push({ kind: "approval", sessionId: lead.id, text: "The plan waits for your approval" });
  if (run && !["done", "stopped"].includes(run.state) && overBudget(run, spend)) {
    needs.push({ kind: "attention", sessionId: lead.id, text: `Over budget: $${spend!.toFixed(2)} of $${Number(run.budget.dollars).toFixed(2)}` });
  }
  const asked = new Set<string>();
  for (const worker of workers) {
    const status = statusOf(worker.id);
    if (!waitsOnPerson(status)) continue;
    asked.add(worker.id);
    needs.push({ kind: kind(status), sessionId: worker.id, text: `${workerTitle(worker, tryOf(run, worker.id))}: ${status.detail}` });
  }
  for (const piece of run?.pieces ?? []) {
    if (piece.state !== "blocked" || (piece.worker && asked.has(piece.worker.sessionId))) continue;
    // Answered in the lead's Run view (PRO-361): take it over, widen it, send its worker a note, or skip it.
    needs.push({ kind: "attention", sessionId: lead.id, text: `${piece.title}: ${piece.note ?? "blocked"}`, piece: piece.id });
  }
  return needs;
}

/** One mark for a list of needs: "Needs approval" when every one is an answer or an approval, else "Needs you". */
export function needsMark(needs: readonly Need[]): Need["kind"] | null {
  if (!needs.length) return null;
  return needs.every((need) => need.kind === "approval") ? "approval" : "attention";
}

/** How many of a lead's workers are working now: a piece running, or a session the runtime says is working. */
export function runningWorkers(workers: readonly SessionEntry[], run: Run | null | undefined, statusOf: (sessionId: string) => StatusDescription): number {
  return workers.filter((worker) => {
    const piece = pieceOf(run, worker.id);
    return piece ? piece.state === "running" : statusOf(worker.id).label === "Working";
  }).length;
}

/** Pieces that are not done, in plan order: what hovering a folded lead lists. */
export function openPieces(run: Run): { piece: RunPiece; state: PieceState }[] {
  return run.pieces.filter((piece) => piece.state !== "done").map((piece) => ({ piece, state: piece.state }));
}
