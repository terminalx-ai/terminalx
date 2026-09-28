import { expect, it } from "vitest";
import { normalizePolicyView, normalizeUsageReport, parseAllowList } from "./organizationCompute";

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
