import { describe, expect, it } from "vitest";
import {
  appRouting, budgetText, checksFrom, checkText, costText, defaultRoute, durationText, estimateText, fellShort, gaveUp, PIECE_KINDS, pieceCheck, pieceCost, pieceMode, pieceNumbers, planOf, raisesMode, refusalOf,
  mergeSubtitle, reviewTokens, sameRoute, TIERS, tokensText, verifyingText, withoutPiece,
} from "./orchestration";
import type { Run, RunPiece } from "@/types/orchestration";

const piece = (id: string, extra: Partial<RunPiece> = {}): RunPiece => ({
  id, title: `Piece ${id}`, owns: [], dependsOn: [], doneChecks: [{ type: "command", run: "cargo t" }], agent: "claude", model: "sonnet", readsUntrusted: false, attempts: 0, state: "queued",
  brief: { goal: `Do ${id}`, why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] }, ...extra,
});

const run = (pieces: RunPiece[], extra: Partial<Run> = {}): Run => ({
  id: "run-1", lead: { sessionId: "lead" }, projectPath: "/repo", goal: "Move settings reads", state: "awaitingApproval", budget: { points: 25 }, pieces, workerMode: "acceptEdits",
  created: "2026-11-11T00:00:00Z", modified: "2026-11-11T00:00:00Z", ready: [], waiting: [], estimate: null, unestimated: pieces.length, ...extra,
});

describe("orchestration runs (PRO-274)", () => {
  it("reads a refusal out of the error the runtime's reply arrives in", () => {
    const refused = refusalOf('runtime call failed: {"code":"shared_file","message":"Pieces c and a both own src/cli.rs.","details":{"piece":"c","other":"a","path":"src/cli.rs"}}');
    expect(refused).toEqual({ code: "shared_file", message: "Pieces c and a both own src/cli.rs.", details: { piece: "c", other: "a", path: "src/cli.rs" } });
    expect(refusalOf(new Error('{"code":"too_many_pieces","message":"The plan has 9 pieces and the limit is 8.","details":{"limit":8,"pieces":9}}')).details?.limit).toBe(8);
    // Anything that is not a refusal is shown as it came.
    expect(refusalOf("the runtime is not running")).toEqual({ code: "error", message: "the runtime is not running" });
    expect(refusalOf("failed: {not json}")).toEqual({ code: "error", message: "failed: {not json}" });
    expect(refusalOf('{"unrelated":true}')).toEqual({ code: "error", message: '{"unrelated":true}' });
  });

  it("turns a stored run back into the plan Edit saves, piece for piece", () => {
    const stored = run([
      piece("a", { kind: "search", estimate: { low: 0.05, high: 0.05 } }),
      piece("b", {
        owns: ["src/store/"], dependsOn: ["a"], effort: "high", permissionMode: "manual", readsUntrusted: true,
        brief: { goal: "A typed store", why: "The rest needs it", scope: "The store", outOfScope: "Call sites", known: ["41 call sites"], readFirst: ["docs/SETTINGS.md"], limits: ["Keep unknown keys"] },
        // What the engine added once it ran: none of it is the plan's.
        attempts: 1, worker: { sessionId: "w", tabId: "t" }, branch: "raccoon/b", startedMode: "manual", state: "running", note: "Working",
      }),
    ]);
    const plan = planOf(stored);
    expect(plan.goal).toBe("Move settings reads");
    expect(plan.budget).toEqual({ points: 25 });
    expect(plan.pieces[1]).toEqual({
      id: "b", title: "Piece b", goal: "A typed store", why: "The rest needs it", scope: "The store", outOfScope: "Call sites", known: ["41 call sites"], readFirst: ["docs/SETTINGS.md"],
      limits: ["Keep unknown keys"], owns: ["src/store/"], dependsOn: ["a"], doneChecks: [{ type: "command", run: "cargo t" }], reviewOnly: undefined, reviewOnlyReason: undefined, kind: undefined, agent: "claude", model: "sonnet", effort: "high", permissionMode: "manual",
      readsUntrusted: true, estimate: undefined,
    });
    expect(plan.pieces[0].estimate).toEqual({ low: 0.05, high: 0.05 });
  });

  it("removes a piece together with every dependency on it", () => {
    const plan = planOf(run([piece("a"), piece("b", { dependsOn: ["a"] }), piece("c", { dependsOn: ["a", "b"] })]));
    const without = withoutPiece(plan, "a");
    expect(without.pieces.map((left) => [left.id, left.dependsOn])).toEqual([["b", []], ["c", ["b"]]]);
    // The plan it was made from is untouched.
    expect(plan.pieces).toHaveLength(3);
  });

  it("names the mode a piece runs in and says when it asks for more than the run's", () => {
    const stored = run([]);
    expect(pieceMode(stored, {})).toBe("acceptEdits");
    expect(pieceMode(stored, { permissionMode: "manual" })).toBe("manual");
    // Once started, the mode it was started in is the one it runs in.
    expect(pieceMode(stored, { permissionMode: "manual", startedMode: "bypassPermissions" })).toBe("bypassPermissions");
    expect(raisesMode(stored, {})).toBe(false);
    expect(raisesMode(stored, { permissionMode: "acceptEdits" })).toBe(false);
    expect(raisesMode(stored, { permissionMode: "manual" })).toBe(false);
    expect(raisesMode(stored, { permissionMode: "plan" })).toBe(false);
    expect(raisesMode(stored, { permissionMode: "auto" })).toBe(true);
    expect(raisesMode(stored, { permissionMode: "bypassPermissions" })).toBe(true);
  });

  it("writes estimates and budgets the way the plan gave them", () => {
    expect(estimateText({ low: 0.05, high: 0.05 })).toBe("$0.05");
    expect(estimateText({ low: 1.6, high: 2.4 })).toBe("$1.60–2.40");
    expect(estimateText(null)).toBeNull();
    expect(estimateText(undefined)).toBeNull();
    expect(budgetText({ budget: { points: 25 } })).toBe("25 points");
    expect(budgetText({ budget: { points: 1 } })).toBe("1 point");
    expect(budgetText({ budget: { dollars: 15 } })).toBe("$15.00");
    expect(budgetText({ budget: { points: 25, dollars: 15 } })).toBe("25 points · $15.00");
    expect(budgetText({ budget: {} })).toBeNull();
  });

  it("reads a piece's checks back from what Edit holds, keeping the votes it had", () => {
    const before = [{ type: "command" as const, run: "old" }, { type: "vote" as const, text: "No key lost.", voters: 3, threshold: 2 }, { type: "review" as const, text: "old point" }];
    expect(checksFrom(" cargo t \n\npnpm tsc --noEmit\n", "Unknown keys survive.\n  ", before)).toEqual([
      { type: "command", run: "cargo t" }, { type: "command", run: "pnpm tsc --noEmit" }, { type: "review", text: "Unknown keys survive." }, { type: "vote", text: "No key lost.", voters: 3, threshold: 2 },
    ]);
    expect(checksFrom("", "", [])).toEqual([]);
    expect([checkText({ type: "command", run: "cargo t" }), checkText({ type: "review", text: "Reads well." }), checkText({ type: "vote", text: "Sound." })]).toEqual(["cargo t", "Reads well.", "Sound."]);
  });

  it("numbers pieces by their place in the plan", () => {
    expect(pieceNumbers(run([piece("map"), piece("store"), piece("docs")]))).toEqual({ map: 1, store: 2, docs: 3 });
  });
});

describe("the routing table and a piece's tries (PRO-275)", () => {
  it("has the built-in row of every kind, and the app's changed rows over them", () => {
    // The same table as `routing::default_route`.
    expect(PIECE_KINDS.map(({ kind }) => [kind, defaultRoute(kind)])).toEqual([
      ["search", { tier: "small" }],
      ["logs", { tier: "small" }],
      ["scoped-code", { tier: "mid", effort: "medium" }],
      ["review", { tier: "mid", effort: "medium" }],
      ["code", { tier: "large", effort: "medium" }],
      ["refactor", { tier: "top", effort: "medium" }],
      ["research", { tier: "top", effort: "medium" }],
      ["verify", { tier: "mid", effort: "medium" }],
    ]);
    const table = appRouting({ code: { claude: { tier: "mid", effort: "high" } } });
    expect([table.code.claude, table.code.codex, table.search.claude]).toEqual([{ tier: "mid", effort: "high" }, { tier: "large", effort: "medium" }, { tier: "small" }]);
    expect(Object.keys(appRouting(undefined))).toHaveLength(8);
    // The same four tiers for both agents, smallest first.
    expect(TIERS.map(({ tier, family }) => [tier, family.claude, family.codex])).toEqual([["small", "Haiku", "Luna"], ["mid", "Sonnet", "Terra"], ["large", "Opus", "Sol"], ["top", "Fable", "Astra"]]);
    expect([sameRoute({ tier: "mid" }, { tier: "mid" }), sameRoute({ tier: "mid", effort: "low" }, { tier: "mid" }), sameRoute({ tier: "mid" }, { tier: "top" })]).toEqual([true, false, false]);
  });

  it("sums a piece's tries, and says when a cost leaves a model out", () => {
    expect(costText(0.6149)).toBe("$0.61");
    expect(costText(0.13, ["gpt-new"])).toBe("$0.13+");
    expect([costText(null), costText(undefined)]).toEqual([null, null]);
    expect(costText(0)).toBe("$0.00");
    const tried = piece("cli", { tries: [{ step: "first", model: "sonnet", costUsd: 0.61, outcome: "failed" }, { step: "effort", model: "sonnet", costUsd: 0.92, costUnpricedModels: ["gpt-new"], outcome: "partial" }, { step: "tier", model: "opus" }] });
    const summed = pieceCost(tried);
    expect([summed.cost?.toFixed(2), summed.unpriced]).toEqual(["1.53", ["gpt-new"]]);
    // The run's own sum is taken where it sent one; nothing read is no cost, not zero.
    expect(pieceCost({ ...tried, costUsd: 9, costUnpricedModels: [] })).toEqual({ cost: 9, unpriced: [] });
    expect(pieceCost(piece("map"))).toEqual({ cost: null, unpriced: [] });
    expect(pieceCost(piece("map", { tries: [{ step: "first", model: "haiku" }] })).cost).toBeNull();
  });

  it("leaves out of an edited plan what a piece's kind chose, so the routing table chooses again", () => {
    const note = "No top model of Codex is installed (astra): this piece runs on the lead's model, gpt-5.6-sol.";
    const stored = run([
      // Both from the kind, on a fallback: the tier has no installed model.
      piece("study", { kind: "research", agent: "codex", model: "gpt-5.6-sol", effort: "medium", tier: "large", modelNote: note, modelByKind: true, effortByKind: true }),
      // The plan named the model; the effort is the kind's.
      piece("fix", { kind: "scoped-code", model: "opus", effort: "medium", effortByKind: true }),
      // The plan named both.
      piece("map", { kind: "search", model: "sonnet", effort: "high" }),
    ]);
    const sent = planOf(stored).pieces.map(({ id, model, effort }) => [id, model, effort]);
    // Named again as the lead's model, `study` would be pinned to it and lose its note.
    expect(sent).toEqual([["study", "", undefined], ["fix", "opus", undefined], ["map", "sonnet", "high"]]);
  });

  it("tells a piece the ladder gave up on from one that only waits on its lead", () => {
    const tries = (outcome: "failed" | "partial" | "checkFailed" | "blocked" | "done") => [{ step: "first" as const, model: "sonnet", outcome }];
    for (const outcome of ["failed", "partial", "checkFailed"] as const) {
      expect(fellShort({ outcome })).toBe(true);
      expect(gaveUp(piece("a", { state: "blocked", tries: tries(outcome) }))).toBe(true);
    }
    // A worker that asked for a person's answer is blocked, and was not given up on.
    expect(gaveUp(piece("a", { state: "blocked", tries: tries("blocked") }))).toBe(false);
    expect(gaveUp(piece("a", { state: "queued", tries: tries("failed") }))).toBe(false);
    expect(gaveUp(piece("a", { state: "blocked" }))).toBe(false);
    expect([fellShort({ outcome: "done" }), fellShort({})]).toEqual([false, false]);
  });
});

describe("checking a result (PRO-278)", () => {
  const verifier = (extra = {}) => ({ model: "sonnet", ...extra });
  const review = (verifiers: object[], voters = verifiers.length) => ({ reasons: [], voters, threshold: Math.ceil(voters / 2), promptChars: 0, verifiers }) as never;

  it("says what a piece being checked waits on: the gates, one verifier, or how many of a vote have answered", () => {
    const tried = (verification: object | undefined) => piece("a", { state: "verifying", tries: [{ step: "first", model: "sonnet", outcome: "done", verification: verification as never }] });
    expect(verifyingText(piece("a", { state: "verifying" }))).toBe("Running its checks");
    expect(verifyingText(tried({ gates: [{ gate: "report", passed: true }] }))).toBe("Running its checks");
    expect(verifyingText(tried({ gates: [], review: review([verifier()]) }))).toBe("Waiting on the verifier");
    expect(verifyingText(tried({ gates: [], review: review([verifier({ verdict: "pass" }), verifier({ problem: "No block." }), verifier()]) }))).toBe("Waiting on verifiers, 2 of 3 answered");
    // The check is the current try's: an earlier try's is that try's.
    const retried = piece("a", { tries: [{ step: "first", model: "sonnet", outcome: "checkFailed", verification: { gates: [], outcome: "failed" } }, { step: "effort", model: "sonnet" }] });
    expect(pieceCheck(retried)).toBeUndefined();
    expect(pieceCheck(piece("a"))).toBeUndefined();
  });

  it("writes a command's time and a verifier's tokens the way a row has room for", () => {
    expect([400, 37_600, 59_400, 61_000, 125_000].map(durationText)).toEqual(["1s", "38s", "59s", "1m 01s", "2m 05s"]);
    expect([null, undefined, 0, 870, 1000, 5200, 10_500, 123_456].map(tokensText)).toEqual([null, null, "0 tokens", "870 tokens", "1k tokens", "5.2k tokens", "10.5k tokens", "123k tokens"]);
    const tokens = (input: number) => ({ input, output: 100, cacheRead: 10, cacheWrite: 1 });
    expect(reviewTokens(review([verifier({ tokens: tokens(1000) }), verifier(), verifier({ tokens: tokens(2000) })]))).toBe(3222);
    // Nothing read yet is not zero.
    expect(reviewTokens(review([verifier()]))).toBeNull();
    expect(reviewTokens(undefined)).toBeNull();
  });
});

describe("a merge not yet begun (PRO-361)", () => {
  it("says every result waits to be merged, though a lead's take-over recorded its cost under merge", () => {
    const done = (id: string) => piece(id, { state: "done", tries: [{ step: "first", model: "sonnet", outcome: "done", verification: { gates: [], outcome: "passed", facts: { files: ["a"], changedLines: 1, commit: `${id}000` } } }] });
    const taken = run([done("a"), done("b")], { state: "merging", merge: { into: "", resolvedUsd: 0.4 } });
    expect(mergeSubtitle(taken)).toBe("Every result is accepted. 2 branches wait to be merged into the lead's branch.");
    expect(mergeSubtitle({ ...taken, merge: { into: "main" } })).toBe("Merging in dependency order. 0 of 2 branches are in.");
  });
});
