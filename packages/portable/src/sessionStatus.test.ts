import { describe, expect, it } from "vitest";
import cases from "./sessionStatusCases.json";
import sharedCases from "./sharedBranchCases.json";
import { combinedSessionStatus, SESSION_STATUSES, sessionStatus, sharedBranchSessions, statusText, statusTooltip, type SessionStatusInput } from "./sessionStatus";

/** The screens' set (17.07, 02.15): no other label may reach a row. */
const SCREEN_LABELS = ["Working", "Needs approval", "Needs you", "Checks failing", "Ready to merge", "Draft PR", "In review", "Merged", "Uncommitted", "No changes", "Not started"];

describe("session status shared by desktop, CLI and phone", () => {
  it.each(cases)("$name", ({ input, expected }) => {
    const before = structuredClone(input);
    expect(sessionStatus(input as SessionStatusInput).id).toBe(expected);
    expect(Object.keys(sessionStatus(input as SessionStatusInput)).sort()).toEqual(["color", "detail", "icon", "id", "label", "pr", "tooltip"]);
    expect(input).toEqual(before);
  });

  it("covers every label, icon, colour and tooltip", () => {
    expect(new Set(cases.map((test) => test.expected))).toEqual(new Set(SESSION_STATUSES.map((status) => status.id)));
    for (const status of SESSION_STATUSES) for (const field of [status.label, status.detail, status.icon, status.color, status.tooltip]) expect(field).toBeTruthy();
  });

  it("labels rows only from the screens' set, and uses all of it", () => {
    expect(new Set(SESSION_STATUSES.map((status) => status.label))).toEqual(new Set(SCREEN_LABELS));
  });

  it.each([
    ["needs_permission", "Needs approval", "Needs permission", /permission/],
    ["needs_answer", "Needs approval", "Needs answer", /question/],
    ["review_plan", "Needs approval", "Review plan", /plan/],
    ["setting_up", "Working", "Setting up", /starting/i],
    ["setup_failed", "Needs you", "Setup failed", /could not start/],
    ["stopping", "Working", "Stopping", /stop/],
    ["background", "Working", "Waiting on background task", /background/],
    ["local_only", "Uncommitted", "Local only", /no pull request/],
    ["checks_running", "In review", "Checks running", /pending or running/],
    ["merge_conflict", "Needs you", "Merge conflict", /conflicts/],
    ["in_merge_queue", "Ready to merge", "In merge queue", /merge queue/],
  ])("%s shows %s on the row and names %s in the tooltip", (id, label, detail, reason) => {
    const status = SESSION_STATUSES.find((status) => status.id === id)!;
    expect(status.label).toBe(label);
    expect(status.detail).toBe(detail);
    expect(status.tooltip).toMatch(reason);
  });

  it("keeps collapsed rows independent of session and tab order", () => {
    const inputs = cases.map((test) => test.input as SessionStatusInput);
    expect(combinedSessionStatus(inputs).id).toBe("needs_permission");
    expect(combinedSessionStatus(inputs.reverse()).id).toBe("needs_permission");
  });

  it("agent attention wins over every PR and workspace state", () => {
    for (const test of cases.filter((test) => "branchStatus" in test.input || "work" in test.input)) {
      for (const activity of ["needs_permission", "needs_answer", "review_plan"] as const) {
        const status = sessionStatus({ ...test.input, tabs: [{ status: "waiting", activity }] } as SessionStatusInput);
        expect(status.id).toBe(activity);
        expect(status.label).toBe("Needs approval");
      }
    }
  });

  it("appends the open PR's number to the full label only", () => {
    const pr = { number: 781, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "FAILURE", inMergeQueue: false };
    const failing = sessionStatus({ tabs: [], branch: "f", branchStatus: { branch: "f", checked: true, headMatches: true, pr } });
    expect(statusText(failing)).toBe("Checks failing · PR #781");
    expect(statusTooltip(failing)).toMatch(/PR #781\.$/);
    expect(statusText(sessionStatus({ tabs: [], branch: "f", branchStatus: { branch: "f", checked: true, headMatches: true, pr: { ...pr, checks: "SUCCESS" } } }))).toBe("Ready to merge · PR #781");
    expect(statusText(sessionStatus({ tabs: [], branch: "f", branchStatus: { branch: "f", checked: true, headMatches: true, pr: { ...pr, draft: true, checks: "PENDING" } } }))).toBe("Draft PR · PR #781");
    // Merged reads as it does on the screens: no number. Agent states never carry one.
    expect(statusText(sessionStatus({ tabs: [], branch: "f", branchStatus: { branch: "f", checked: true, headMatches: true, pr: { ...pr, state: "MERGED" } } }))).toBe("Merged");
    expect(statusText(sessionStatus({ tabs: [{ status: "in_progress" }], branch: "f", branchStatus: { branch: "f", checked: true, headMatches: true, pr } }))).toBe("Working");
  });

  it("a collapsed row keeps the PR number of the session it picked", () => {
    const pr = { number: 7, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "FAILURE", inMergeQueue: false };
    const status = combinedSessionStatus([{ tabs: [], sharedBranch: true, branch: "f" }, { tabs: [], branch: "f", branchStatus: { branch: "f", checked: true, headMatches: true, pr } }]);
    expect(statusText(status)).toBe("Checks failing · PR #7");
  });
});

describe("shared branch: the most recently active session carries the PR", () => {
  it.each(sharedCases)("$name", ({ members, shared }) => {
    expect([...sharedBranchSessions(members)].sort()).toEqual(shared);
  });

  it("only the carrier shows the PR state; the other shows its agent state", () => {
    const pr = { number: 9, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "FAILURE", inMergeQueue: false };
    const branchStatus = { branch: "f", checked: true, headMatches: true, pr };
    const shared = sharedBranchSessions([{ id: "a", project: "/r", branch: "f", activeAt: "2026-11-11T10:00:00Z" }, { id: "b", project: "/r", branch: "f", activeAt: "2026-11-11T09:00:00Z" }]);
    // The runtime drops the branch's PR and workspace facts from every session that does not carry it.
    const input = (id: string, tabs: SessionStatusInput["tabs"]): SessionStatusInput => shared.has(id) ? { tabs, branch: "f", sharedBranch: true } : { tabs, branch: "f", branchStatus, work: "uncommitted" };
    expect(statusText(sessionStatus(input("a", [{ status: "idle" }])))).toBe("Checks failing · PR #9");
    expect(sessionStatus(input("b", [{ status: "idle" }])).id).toBe("shares_branch");
    expect(sessionStatus(input("b", [{ status: "in_progress" }])).label).toBe("Working");
    expect(sessionStatus(input("b", [{ status: "waiting", activity: "needs_answer" }])).label).toBe("Needs approval");
  });
});
