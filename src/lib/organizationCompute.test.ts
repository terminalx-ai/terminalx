import { describe, expect, it } from "vitest";
import {
  LIMIT_MAX,
  checkLimits,
  createBudgetSentence,
  effectiveRunningLimit,
  effectiveWorkspaceLimit,
  normalizePolicyView,
  normalizeUsageReport,
  parseAllowList,
  usageText,
  type LimitsText,
} from "./organizationCompute";

it("defaults fields an older or newer server leaves out", () => {
  const view = normalizePolicyView({
    policy: { version: 2, maxWorkspaces: 3, allowedMachineClasses: null, allowedLocations: { box: ["eu", 7] } },
    counts: { workspaces: 1 },
    canEdit: true,
    contextRevision: "rev",
  });
  expect(view.policy).toMatchObject({ allowedMachineClasses: {}, allowedLocations: { box: ["eu"] }, maxRunningWorkspaces: null, provisioningPaused: false });
  expect(view.counts).toEqual({ workspaces: 1, running: 0 });
  expect(view.workspaceCeiling).toBe(3);
  const usage = normalizeUsageReport({ period: { start: 1 }, providers: [{ provider: "box" }], contextRevision: "rev" });
  expect(usage).toMatchObject({ providers: [], alerts: [], retained: [] });
});

it("turns a payload without core fields into an unavailable error", () => {
  expect(() => normalizePolicyView({ counts: {} })).toThrow();
  expect(() => normalizeUsageReport({ alerts: [] })).toThrow();
  try {
    normalizePolicyView(null);
  } catch (error) {
    expect(error).toMatchObject({ code: "organization_compute_unavailable" });
  }
});

it("parses comma-separated allow lists, blank meaning any", () => {
  expect(parseAllowList(" fsn1, nbg1 ,fsn1,, ")).toEqual(["fsn1", "nbg1"]);
  expect(parseAllowList("  ")).toBeNull();
});

describe("no limit unless one is set (PRO-371)", () => {
  // What each server sends for an organization that set nothing.
  const newServer = {
    policy: { version: 1, maxWorkspaces: null, maxRunningWorkspaces: null, maxRunningWorkspacesPerMember: null, maxCreatesPerMemberPerHour: null, maxCreatesPerMemberPerDay: null, maxIdleSuspendMinutes: null },
    counts: { workspaces: 60, running: 3 },
    canEdit: true,
    workspaceCeiling: null,
    runningWorkspaceCeiling: null,
    createBudgetDefaults: { perHour: null, perDay: null },
    quota: { used: 3, running: { used: 3 }, total: { used: 60 } },
    contextRevision: "rev",
  };
  const olderServer = {
    policy: { version: 1, maxWorkspaces: 50, maxRunningWorkspaces: null, maxRunningWorkspacesPerMember: null, maxCreatesPerMemberPerHour: null, maxCreatesPerMemberPerDay: null, maxIdleSuspendMinutes: null },
    counts: { workspaces: 3, running: 1 },
    canEdit: true,
    workspaceCeiling: 50,
    runningWorkspaceCeiling: 2,
    createBudgetDefaults: { perHour: 10, perDay: 20 },
    contextRevision: "rev",
  };
  const blank: LimitsText = { maxWorkspaces: "", maxRunningWorkspaces: "", perMember: "", createsPerHour: "", createsPerDay: "" };
  const noCeilings = { workspaceCeiling: null, runningWorkspaceCeiling: null };
  const messages = (text: Partial<LimitsText>, view: { workspaceCeiling: number | null; runningWorkspaceCeiling: number | null } = noCeilings) =>
    checkLimits({ ...blank, ...text }, view).problems.map((problem) => problem.message);

  it("keeps a new server's nulls as no limit, never a default of 1", () => {
    const view = normalizePolicyView(newServer);
    expect(view.policy).toMatchObject({ maxWorkspaces: null, maxRunningWorkspaces: null, maxRunningWorkspacesPerMember: null, maxCreatesPerMemberPerHour: null, maxCreatesPerMemberPerDay: null });
    expect(view.workspaceCeiling).toBeNull();
    // Its null ceiling is how it says a save may carry `noLimitAware`.
    expect(view.noLimitAware).toBe(true);
    expect(view.runningWorkspaceCeiling).toBeNull();
    expect(view.createBudgetDefaults).toEqual({ perHour: null, perDay: null });
    expect(effectiveWorkspaceLimit(view)).toBeNull();
    expect(effectiveRunningLimit(view)).toBeNull();
  });

  it("reads an older server's numbers as before", () => {
    const view = normalizePolicyView(olderServer);
    expect(view.policy.maxWorkspaces).toBe(50);
    expect([view.workspaceCeiling, view.runningWorkspaceCeiling]).toEqual([50, 2]);
    // No null ceiling from the server, no marker: a ceiling left out, or of another shape, is not one either.
    expect(view.noLimitAware).toBe(false);
    const { workspaceCeiling: _ceiling, ...withoutCeiling } = newServer;
    expect(normalizePolicyView(withoutCeiling).noLimitAware).toBe(false);
    expect(normalizePolicyView({ ...newServer, workspaceCeiling: "none" }).noLimitAware).toBe(false);
    expect(view.createBudgetDefaults).toEqual({ perHour: 10, perDay: 20 });
    expect(effectiveWorkspaceLimit(view)).toBe(50);
    expect(effectiveRunningLimit(view)).toBe(2);
    // One that reports no create budgets at all.
    expect(normalizePolicyView({ ...olderServer, createBudgetDefaults: undefined }).createBudgetDefaults).toBeNull();
    // An operator who set only one of the two budgets.
    expect(normalizePolicyView({ ...newServer, createBudgetDefaults: { perHour: 10, perDay: null } }).createBudgetDefaults).toEqual({ perHour: 10, perDay: null });
  });

  it("works out the limits in force, null where there is none", () => {
    const view = (maxWorkspaces: number | null, maxRunningWorkspaces: number | null, runningWorkspaceCeiling: number | null = null) => ({
      policy: { maxWorkspaces, maxRunningWorkspaces } as never,
      workspaceCeiling: null,
      runningWorkspaceCeiling,
    });
    expect(effectiveRunningLimit(view(null, null))).toBeNull();
    // A workspace limit alone is not a running limit.
    expect(effectiveRunningLimit(view(500, null))).toBeNull();
    expect(effectiveWorkspaceLimit(view(500, null))).toBe(500);
    expect(effectiveRunningLimit(view(500, 100))).toBe(100);
    expect(effectiveRunningLimit(view(null, 100))).toBe(100);
    // The operator's cap applies where the organization set nothing, and holds its number down.
    expect(effectiveRunningLimit(view(null, null, 10))).toBe(10);
    expect(effectiveRunningLimit(view(null, 4, 10))).toBe(4);
    expect(effectiveRunningLimit(view(null, 40, 10))).toBe(10);
    expect(effectiveRunningLimit(view(5, null, 10))).toBe(5);
  });

  it("says a count with its limit, or that there is none", () => {
    expect(usageText(3, 50)).toBe("3 of 50");
    expect(usageText(60, null)).toBe("60, no limit");
    expect(createBudgetSentence(3, 20)).toBe("Each person can create 3 workspaces an hour and 20 a day.");
    expect(createBudgetSentence(1, null)).toBe("Each person can create 1 workspace an hour.");
    expect(createBudgetSentence(null, 20)).toBe("Each person can create 20 workspaces a day.");
    expect(createBudgetSentence(null, null)).toBeNull();
  });

  it("saves every empty field as no limit", () => {
    expect(checkLimits(blank, noCeilings)).toEqual({
      values: { maxWorkspaces: null, maxRunningWorkspaces: null, perMember: null, createsPerHour: null, createsPerDay: null },
      problems: [],
    });
    expect(checkLimits({ ...blank, maxWorkspaces: "   " }, noCeilings).problems).toEqual([]);
  });

  it("takes any whole number of 1 or more: 500 workspaces and 100 running", () => {
    const check = checkLimits({ maxWorkspaces: "500", maxRunningWorkspaces: " 100 ", perMember: "75", createsPerHour: "501", createsPerDay: "5000" }, noCeilings);
    expect(check.problems).toEqual([]);
    expect(check.values).toEqual({ maxWorkspaces: 500, maxRunningWorkspaces: 100, perMember: 75, createsPerHour: 501, createsPerDay: 5000 });
    expect(checkLimits({ ...blank, maxWorkspaces: "1" }, noCeilings).values.maxWorkspaces).toBe(1);
    expect(checkLimits({ ...blank, maxWorkspaces: String(LIMIT_MAX) }, noCeilings)).toMatchObject({ values: { maxWorkspaces: LIMIT_MAX }, problems: [] });
  });

  it("refuses only what is not a whole number of 1 or more, and what cannot be stored", () => {
    for (const typed of ["0", "-1", "2.5", "1e3", "0x10", "ten", "5 0", "+5"]) {
      expect(messages({ maxWorkspaces: typed }), typed).toEqual(["Workspaces must be a whole number of 1 or more, or blank for no limit."]);
    }
    expect(messages({ maxRunningWorkspaces: "0" })).toEqual(["Running at once must be a whole number of 1 or more, or blank for no limit."]);
    expect(messages({ perMember: "x" })).toEqual(["Running per person must be a whole number of 1 or more, or blank for no limit."]);
    expect(messages({ createsPerHour: "0", createsPerDay: "1.5" })).toEqual([
      "New per person, per hour must be a whole number of 1 or more, or blank for no limit.",
      "New per person, per day must be a whole number of 1 or more, or blank for no limit.",
    ]);
    expect(messages({ maxWorkspaces: "2147483648" })).toEqual(["Workspaces is too large to store. The most is 2147483647."]);
    expect(messages({ createsPerDay: "99999999999999999999" })).toEqual(["New per person, per day is too large to store. The most is 2147483647."]);
    // A refused field names itself, for the form to mark.
    expect(checkLimits({ ...blank, perMember: "0" }, noCeilings).problems[0].fields).toEqual(["perMember"]);
  });

  it("compares two limits only where both are set", () => {
    expect(messages({ maxRunningWorkspaces: "100" })).toEqual([]);
    expect(messages({ maxWorkspaces: "50", maxRunningWorkspaces: "100" })).toEqual(["Running at once must be no larger than the workspace limit."]);
    expect(messages({ maxWorkspaces: "100", maxRunningWorkspaces: "100" })).toEqual([]);

    expect(messages({ perMember: "9" })).toEqual([]);
    expect(messages({ maxWorkspaces: "4", perMember: "9" })).toEqual(["Running per person must be no larger than the workspace limit."]);
    // The server does not compare the cap per person with the running limit, so nor does the form.
    expect(messages({ maxRunningWorkspaces: "2", perMember: "9" })).toEqual([]);

    expect(messages({ createsPerHour: "30" })).toEqual([]);
    expect(messages({ createsPerDay: "20" })).toEqual([]);
    expect(messages({ createsPerHour: "30", createsPerDay: "20" })).toEqual(["New per person, per hour must be no larger than per day."]);
    expect(checkLimits({ ...blank, createsPerHour: "30", createsPerDay: "20" }, noCeilings).problems[0].fields).toEqual(["createsPerHour", "createsPerDay"]);
    expect(messages({ createsPerHour: "20", createsPerDay: "20" })).toEqual([]);
    // A field that is not a number is not compared: one sentence about it is enough.
    expect(messages({ maxWorkspaces: "0", maxRunningWorkspaces: "100" })).toEqual(["Workspaces must be a whole number of 1 or more, or blank for no limit."]);
  });

  it("holds the running limit to the operator's cap, where the operator set one", () => {
    const capped = { workspaceCeiling: null, runningWorkspaceCeiling: 10 };
    expect(messages({ maxRunningWorkspaces: "10" }, capped)).toEqual([]);
    expect(messages({ maxRunningWorkspaces: "11" }, capped)).toEqual(["Running at once must be no larger than 10, the most this TerminalX service allows."]);
    // Blank is always taken: the cap applies by itself.
    expect(messages({}, capped)).toEqual([]);
    // The workspace limit is not held to it.
    expect(messages({ maxWorkspaces: "500" }, capped)).toEqual([]);
  });

  it("keeps an older server's rules: it needs a workspace limit, and none above its ceiling", () => {
    const older = { workspaceCeiling: 50, runningWorkspaceCeiling: 2 };
    const refusal = "Workspaces must be a whole number from 1 to 50, the most this TerminalX service allows.";
    expect(messages({ maxWorkspaces: "50" }, older)).toEqual([]);
    expect(messages({ maxWorkspaces: "" }, older)).toEqual([refusal]);
    expect(messages({ maxWorkspaces: "51" }, older)).toEqual([refusal]);
    expect(messages({ maxWorkspaces: "20", maxRunningWorkspaces: "3" }, older)).toEqual(["Running at once must be no larger than 2, the most this TerminalX service allows."]);
    // It takes no empty limit, so it is not offered one.
    expect(messages({ maxWorkspaces: "0" }, older)).toEqual([refusal]);
    expect(messages({ maxWorkspaces: "many" }, older)).toEqual([refusal]);
  });
});
