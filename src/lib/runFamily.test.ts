import { describe, expect, it } from "vitest";
import { SESSION_STATUSES } from "@terminalx/portable/sessionStatus";
import { familyHolds, familyNeeds, modelTier, needsMark, nestWorkers, orderWorkers, overBudget, pieceSpend, runningWorkers, runProgress, runSpend, tryOf, workerTitle } from "./runFamily";
import type { Run, RunPiece } from "@/types/orchestration";
import type { SessionEntry } from "@/types/session";

const status = (id: string) => SESSION_STATUSES.find((entry) => entry.id === id)!;
const session = (id: string, parent?: string, cost?: number): SessionEntry =>
  ({ id, title: id, parent: parent ? { sessionId: parent } : undefined, tabs: cost == null ? [] : [{ id: `${id}-t`, harness: "claude", model: "sonnet", usage: { models: [{ model: "claude-sonnet-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost }] } }] }) as unknown as SessionEntry;
const piece = (id: string, state: RunPiece["state"], worker?: string, extra: Partial<RunPiece> = {}): RunPiece =>
  ({ id, title: `Piece ${id}`, state, worker: worker ? { sessionId: worker } : undefined, dependsOn: [], agent: "claude", model: "", ...extra }) as RunPiece;
const run = (pieces: RunPiece[], extra: Partial<Run> = {}): Run => ({ id: "r", lead: { sessionId: "lead" }, state: "running", budget: {}, pieces, ...extra }) as Run;

describe("nestWorkers", () => {
  it("nests a session under the listed session that started it, and leaves the rest as they are", () => {
    const { top, workersOf } = nestWorkers([session("lead"), session("a", "lead"), session("solo"), session("b", "lead")]);
    expect(top.map((entry) => entry.id)).toEqual(["lead", "solo"]);
    expect(workersOf.lead.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("keeps a session whose starter is not listed (archived, deleted, filtered out) at the top", () => {
    const { top, workersOf } = nestWorkers([session("a", "gone"), session("b")]);
    expect(top.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(workersOf).toEqual({});
  });

  it("puts a worker's own workers under the same lead: one level", () => {
    const { top, workersOf } = nestWorkers([session("lead"), session("a", "lead"), session("a1", "a")]);
    expect(top.map((entry) => entry.id)).toEqual(["lead"]);
    expect(workersOf.lead.map((entry) => entry.id)).toEqual(["a", "a1"]);
  });

  it("nests nothing of a loop in the records", () => {
    const { top } = nestWorkers([session("a", "b"), session("b", "a")]);
    expect(top.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("leads a coordinator started (PRO-364)", () => {
  it("keeps a nested lead's workers under it, and the lead among its coordinator's", () => {
    const list = [
      session("coord"),
      session("l1", "coord"), session("l1a", "l1"), session("l1b", "l1"),
      session("l2", "coord"), session("l2a", "l2"), session("l2b", "l2"), session("l2c", "l2"),
      session("l3", "coord"), session("l3a", "l3"), session("l3b", "l3"),
    ];
    const runs = { l1: run([]), l2: run([]), l3: run([]) };
    const { top, workersOf } = nestWorkers(list, runs);
    expect(top.map((entry) => entry.id)).toEqual(["coord"]);
    expect(workersOf.coord.map((entry) => entry.id)).toEqual(["l1", "l2", "l3"]);
    expect(workersOf.l1.map((entry) => entry.id)).toEqual(["l1a", "l1b"]);
    expect(workersOf.l2.map((entry) => entry.id)).toEqual(["l2a", "l2b", "l2c"]);
    expect(workersOf.l3.map((entry) => entry.id)).toEqual(["l3a", "l3b"]);
    // An open worker of a nested lead holds the coordinator open too.
    expect(familyHolds(workersOf, "coord", "l2b")).toBe(true);
    expect(familyHolds(workersOf, "l1", "l2b")).toBe(false);
  });

  it("still nests nothing of a loop above a nested lead", () => {
    const { top } = nestWorkers([session("a", "b"), session("b", "a"), session("w", "a")], { a: run([]) });
    expect(top.map((entry) => entry.id)).toEqual(["a", "b", "w"]);
  });
});

describe("every try of a piece (PRO-364)", () => {
  const tries = [
    { step: "first", model: "haiku", worker: { sessionId: "t1" }, outcome: "failed" },
    { step: "tier", model: "sonnet", worker: { sessionId: "t2" }, outcome: "failed" },
    { step: "effort", model: "opus", worker: { sessionId: "t3" } },
  ] as RunPiece["tries"];
  const retried = () => run([piece("1", "done", "w1"), piece("2", "running", "t3", { tries }), piece("3", "queued")]);

  it("finds each try's piece and number, and only the last is current", () => {
    const r = retried();
    expect(["t1", "t2", "t3"].map((id) => { const found = tryOf(r, id)!; return [found.piece.id, found.number, found.of, found.current]; }))
      .toEqual([["2", 1, 3, false], ["2", 2, 3, false], ["2", 3, 3, true]]);
    // A piece tried once is one try of one: its row has no "try N" mark.
    expect(tryOf(r, "w1")).toMatchObject({ number: 1, of: 1, current: true });
    expect(tryOf(r, "x")).toBeNull();
  });

  it("orders a piece's tries as they ran, in the piece's place", () => {
    const list = [session("x"), session("t3"), session("w1"), session("t1"), session("t2")];
    expect(orderWorkers(list, retried()).map((entry) => entry.id)).toEqual(["w1", "t1", "t2", "t3", "x"]);
  });

  it("names every try by its piece, and a row with no piece by its session's title, not its tab's", () => {
    const r = retried();
    expect(["t1", "t2", "t3"].map((id) => workerTitle(session(id), tryOf(r, id)))).toEqual(["Piece 2", "Piece 2", "Piece 2"]);
    const briefed = { ...session("w", "lead"), title: "Sidebar rows", tabs: [{ id: "w-t", title: "You are a worker in a run led by another session." }] } as unknown as SessionEntry;
    expect(workerTitle(briefed, null)).toBe("Sidebar rows");
  });

  it("names an earlier try that asks by its piece", () => {
    const needs = familyNeeds({ lead: session("lead"), leadStatus: status("no_changes"), run: retried(), workers: [session("t1")], statusOf: () => status("needs_permission"), spend: null });
    expect(needs[0].text.startsWith("Piece 2: ")).toBe(true);
  });
});

describe("a run's numbers", () => {
  it("orders workers as the plan numbers its pieces, sessions with no piece last", () => {
    const r = run([piece("1", "done", "w1"), piece("2", "running", "w2")]);
    expect(orderWorkers([session("x"), session("w2"), session("w1")], r).map((entry) => entry.id)).toEqual(["w1", "w2", "x"]);
  });

  it("counts pieces done, workers running, and what the workers cost", () => {
    const r = run([piece("1", "done", "w1"), piece("2", "running", "w2"), piece("3", "queued")]);
    expect(runProgress(r)).toEqual({ done: 1, total: 3 });
    expect(runningWorkers([session("w1"), session("w2"), session("x")], r, (id) => status(id === "x" ? "working" : "no_changes"))).toBe(2);
    const byId = new Map([session("w1", "lead", 0.5), session("w2", "lead", 1.25)].map((entry) => [entry.id, entry]));
    expect(runSpend(r, byId)).toBe(1.75);
    expect(runSpend(run([piece("1", "queued")]), byId)).toBeNull();
  });

  it("counts every try a piece took, its current worker as its session reads now (PRO-275 with PRO-281)", () => {
    const tries = [
      { step: "first", model: "sonnet", worker: { sessionId: "w1" }, outcome: "failed", costUsd: 0.6 },
      { step: "effort", model: "sonnet", worker: { sessionId: "w2" }, costUsd: 0.2 },
    ] as RunPiece["tries"];
    const retried = piece("1", "running", "w2", { tries, costUsd: 0.8, costUnpricedModels: ["mystery"] });
    // The run last read 0.20 for the worker; its session has 0.90 by now.
    const byId = new Map([session("w2", "lead", 0.9)].map((entry) => [entry.id, entry]));
    expect(pieceSpend(retried, byId)).toEqual({ cost: 1.5, unpriced: ["mystery"] });
    expect(runSpend(run([retried]), byId)).toBe(1.5);
    // A worker the app does not list (deleted, another device): what the run recorded stands.
    expect(pieceSpend(retried, new Map())).toEqual({ cost: 0.8, unpriced: ["mystery"] });
    // A piece the run recorded no tries for is its worker's session alone.
    expect(pieceSpend(piece("2", "running", "w2"), byId)).toEqual({ cost: 0.9, unpriced: [] });
  });

  it("is over budget only past the dollars it allows", () => {
    expect(overBudget({ budget: { dollars: 2 } }, 2.01)).toBe(true);
    expect(overBudget({ budget: { dollars: 2 } }, 2)).toBe(false);
    expect(overBudget({ budget: { points: 1 } }, 99)).toBe(false);
    expect(overBudget({ budget: { dollars: 2 } }, null)).toBe(false);
  });
});

describe("familyNeeds", () => {
  const lead = session("lead");
  it("lists the lead's own wait, the plan, the budget, a worker's question and a blocked piece, once each", () => {
    const r = run([piece("1", "blocked", "w1", { note: "Reported blocked: no access" }), piece("2", "blocked", "w2"), piece("3", "running", "w3")], { budget: { dollars: 1 } });
    const needs = familyNeeds({
      lead, leadStatus: status("needs_answer"), run: r, workers: [session("w1"), session("w2"), session("w3")], spend: 3,
      statusOf: (id) => status(id === "w2" ? "needs_permission" : "working"),
    });
    expect(needs.map((need) => [need.kind, need.sessionId, need.text])).toEqual([
      ["approval", "lead", "Lead: Needs answer"],
      ["attention", "lead", "Over budget: $3.00 of $1.00"],
      ["approval", "w2", "Piece 2: Needs permission"],
      // A blocked piece is answered in the lead's Run view (PRO-361).
      ["attention", "lead", "Piece 1: Reported blocked: no access"],
    ]);
    expect(needsMark(needs)).toBe("attention");
    expect(needsMark(needs.filter((need) => need.kind === "approval"))).toBe("approval");
    expect(needsMark([])).toBeNull();
  });

  it("says a plan waits for approval, and says nothing of a run that has ended", () => {
    expect(familyNeeds({ lead, leadStatus: status("no_changes"), run: run([], { state: "awaitingApproval" }), workers: [], spend: null, statusOf: () => status("no_changes") }).map((need) => need.text)).toEqual(["The plan waits for your approval"]);
    expect(familyNeeds({ lead, leadStatus: status("no_changes"), run: run([], { state: "done", budget: { dollars: 1 } }), workers: [], spend: 5, statusOf: () => status("no_changes") })).toEqual([]);
  });
});

describe("modelTier", () => {
  it("names a model by its tier, coloured as 18.07 draws it, and the agent's default as Default", () => {
    expect(modelTier("claude", "claude-haiku-5-5")).toEqual({ text: "Haiku", className: "text-info" });
    expect(modelTier("claude", "sonnet")).toEqual({ text: "Sonnet", className: "text-add" });
    expect(modelTier("claude", "claude-opus-5-5")).toEqual({ text: "Opus", className: "text-accent" });
    expect(modelTier("claude", "")).toEqual({ text: "Default", className: "text-faint" });
    expect(modelTier("codex", "gpt-5.5-codex").className).toBe("text-muted-foreground");
  });
});
