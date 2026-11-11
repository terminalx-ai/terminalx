import type { StatusDescription } from "@terminalx/portable/sessionStatus";
import { modelLabel } from "@/lib/models";
import { conversationTitle } from "@/lib/sessions";
import { sessionModels, totals } from "@/components/session/SessionCost";
import type { PieceState, Run, RunPiece } from "@/types/orchestration";
import type { SessionEntry } from "@/types/session";

/**
 * A lead and the sessions it started, as the sidebar draws them (PRO-281). A
 * session nests under the session that started it (`parent`, PRO-270) when
 * that session is listed beside it, whatever worktree either runs in. Workers
 * of workers nest under the same lead: the sidebar draws one level.
 */
export function nestWorkers(sessions: readonly SessionEntry[]): { top: SessionEntry[]; workersOf: Record<string, SessionEntry[]> } {
  const listed = new Map(sessions.map((session) => [session.id, session]));
  const leadOf = (session: SessionEntry): string | null => {
    const seen = new Set([session.id]);
    let lead: string | null = null;
    for (let at = session.parent?.sessionId; at && listed.has(at); at = listed.get(at)!.parent?.sessionId) {
      // A loop in the records (each started by the other) nests nothing.
      if (seen.has(at)) return null;
      seen.add(at);
      lead = at;
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

/** The piece a session works on in `run`, if it is one of its workers. */
export function pieceOf(run: Run | null | undefined, sessionId: string): RunPiece | null {
  return run?.pieces.find((piece) => piece.worker?.sessionId === sessionId) ?? null;
}

/** A lead's workers in the run's order: its pieces first, as the plan numbers them, then any other session it started. */
export function orderWorkers(workers: readonly SessionEntry[], run: Run | null | undefined): SessionEntry[] {
  if (!run) return [...workers];
  const place = new Map(run.pieces.flatMap((piece, index) => (piece.worker ? [[piece.worker.sessionId, index] as const] : [])));
  return [...workers].sort((a, b) => (place.get(a.id) ?? Infinity) - (place.get(b.id) ?? Infinity));
}

export function runProgress(run: Pick<Run, "pieces">): { done: number; total: number } {
  return { done: run.pieces.filter((piece) => piece.state === "done").length, total: run.pieces.length };
}

/** What a session has cost, API-equivalent: `null` when nothing it used has a price, or it has used nothing. */
export function sessionSpend(session: SessionEntry | undefined): number | null {
  if (!session) return null;
  const rows = sessionModels(session);
  return rows.length ? totals(rows).costUsd : null;
}

/** What the run's workers have cost so far: the sum of those with a price, `null` while none has one. */
export function runSpend(run: Run, sessions: ReadonlyMap<string, SessionEntry>): number | null {
  let sum: number | null = null;
  for (const piece of run.pieces) {
    const cost = piece.worker ? sessionSpend(sessions.get(piece.worker.sessionId)) : null;
    if (cost != null) sum = (sum ?? 0) + cost;
  }
  return sum;
}

/** Past the dollars the plan allows. A points budget is not measured per run, so it is never "over". */
export function overBudget(run: Pick<Run, "budget">, spend: number | null): boolean {
  return run.budget.dollars != null && spend != null && spend > run.budget.dollars;
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
    needs.push({ kind: "attention", sessionId: lead.id, text: `Over budget: $${spend!.toFixed(2)} of $${run.budget.dollars!.toFixed(2)}` });
  }
  const asked = new Set<string>();
  for (const worker of workers) {
    const status = statusOf(worker.id);
    if (!waitsOnPerson(status)) continue;
    const piece = pieceOf(run, worker.id);
    asked.add(worker.id);
    needs.push({ kind: kind(status), sessionId: worker.id, text: `${piece?.title ?? conversationTitle(worker)}: ${status.detail}` });
  }
  for (const piece of run?.pieces ?? []) {
    if (piece.state !== "blocked" || (piece.worker && asked.has(piece.worker.sessionId))) continue;
    needs.push({ kind: "attention", sessionId: piece.worker?.sessionId ?? lead.id, text: `${piece.title}: ${piece.note ?? "blocked"}` });
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
