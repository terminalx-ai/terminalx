import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setPrefs } from "@/lib/prefs";
import { RunViewHint, runPillOf } from "./RunPill";
import type { Run, RunPiece } from "@/types/orchestration";

const piece = (id: string, state: RunPiece["state"]): RunPiece => ({
  id, title: `Piece ${id}`, owns: [], dependsOn: [], doneChecks: [], agent: "claude", model: "sonnet", readsUntrusted: false, attempts: 1, state,
  brief: { goal: "", why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] },
});
const run = (state: Run["state"], pieces: RunPiece[], extra: Partial<Run> = {}): Run => ({
  id: "r", lead: { sessionId: "lead" }, projectPath: "/repo", goal: "g", state, budget: {}, pieces, workerMode: "bypassPermissions", created: "", modified: "", ready: [], waiting: [], estimate: null, unestimated: 0, ...extra,
});

describe("the title bar's run pill (18.01, 18.03)", () => {
  it("says Needs you for a blocked piece, a plan to approve or a paused run, else how many workers run", () => {
    expect(runPillOf(run("running", [piece("a", "done"), piece("b", "blocked")]))).toMatchObject({ kind: "needs", text: "Needs you", why: "Piece b is blocked" });
    expect(runPillOf(run("awaitingApproval", [piece("a", "queued")]))).toMatchObject({ kind: "approval", text: "Needs you" });
    expect(runPillOf(run("needsYou", [piece("a", "running")], { pause: { kind: "dollars", message: "Past $15.00." } }))).toMatchObject({ kind: "needs", why: "Past $15.00." });
    expect(runPillOf(run("running", [piece("a", "running"), piece("b", "running"), piece("c", "verifying")], { inTurn: 2 }))).toMatchObject({ kind: "running", text: "2 workers running" });
    expect(runPillOf(run("running", [piece("a", "running")]))?.text).toBe("1 worker running");
  });

  it("says nothing of a run with nothing to say, or one that has ended", () => {
    expect(runPillOf(null)).toBeNull();
    expect(runPillOf(run("running", [piece("a", "done"), piece("b", "queued")], { inTurn: 0 }))).toBeNull();
    expect(runPillOf(run("stopped", [piece("a", "blocked")]))).toBeNull();
    expect(runPillOf(run("done", [piece("a", "done")]))).toBeNull();
  });
});

describe("the Run view's keys in the title bar (18.01, PRO-362)", () => {
  afterEach(() => {
    cleanup();
    setPrefs({ shortcuts: {} });
  });

  it("names the keys that open the Run view, the reader's own when they changed them, and nothing with none", () => {
    // jsdom is not a Mac: the main modifier is Ctrl.
    setPrefs({ shortcuts: {} });
    const { rerender } = render(<RunViewHint />);
    expect(screen.getByTestId("run-view-hint").textContent).toBe("Ctrl+Shift+Orun view");
    setPrefs({ shortcuts: { "app.runView": ["mod+alt+o"] } });
    rerender(<RunViewHint />);
    expect(screen.getByTestId("run-view-hint").textContent).toBe("Ctrl+Alt+Orun view");
    setPrefs({ shortcuts: { "app.runView": [] } });
    rerender(<RunViewHint />);
    expect(screen.queryByTestId("run-view-hint")).toBeNull();
  });
});
