import { describe, expect, it } from "vitest";
import { SESSION_STATUSES } from "@terminalx/portable/sessionStatus";
import { familyNeeds, modelTier, needsMark, nestWorkers, orderWorkers, overBudget, runningWorkers, runProgress, runSpend } from "./runFamily";
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
      ["attention", "w1", "Piece 1: Reported blocked: no access"],
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
