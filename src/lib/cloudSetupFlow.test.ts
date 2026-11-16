import { describe, expect, it, vi } from "vitest";
import { finishFlow, flowOf, leaveCloudSetup, moveFlow, setCloudSetupLeave, unfinishedFlow } from "./cloudSetupFlow";
import { newSetup, type OrganizationSetupRecord } from "./organizationSetup";

const record = (flow?: OrganizationSetupRecord["flow"]): OrganizationSetupRecord => ({ ...newSetup("Team", "request-1", 1), organizationId: "org-1", flow });

describe("the setup flow's progress", () => {
  it("counts the step left as passed only when going forward, and keeps going back free", () => {
    const at = moveFlow(record({ step: "github", passed: ["organization"], finishedAt: null }), "compute");
    expect(flowOf(at)).toEqual({ step: "compute", passed: ["organization", "github"], finishedAt: null });
    const back = moveFlow(at, "github");
    expect(flowOf(back)).toEqual({ step: "github", passed: ["organization", "github"], finishedAt: null });
  });

  it("is unfinished until finished, and only for a created organization", () => {
    const started = record({ step: "environment", passed: [], finishedAt: null });
    expect(unfinishedFlow(started)).toBe(true);
    expect(unfinishedFlow({ ...started, organizationId: null })).toBe(false);
    expect(unfinishedFlow(record())).toBe(false);
    const finished = finishFlow(started, 5);
    expect(unfinishedFlow(finished)).toBe(false);
    expect(flowOf(finished)).toMatchObject({ finishedAt: 5, passed: ["environment"] });
  });

  it("ignores stored progress of another shape", () => {
    expect(flowOf(record({ step: "somewhere", passed: [], finishedAt: null }))).toBeNull();
    expect(flowOf(record({ step: "github", passed: ["github", "nope"], finishedAt: null }))?.passed).toEqual(["github"]);
  });

  it("closes from elsewhere in the app only through the open flow's guard", () => {
    const action = vi.fn();
    leaveCloudSetup(action);
    expect(action).toHaveBeenCalledOnce();
    let held: (() => void) | null = null;
    const stop = setCloudSetupLeave((leave) => {
      held = leave;
    });
    const later = vi.fn();
    leaveCloudSetup(later);
    expect(later).not.toHaveBeenCalled();
    held!();
    expect(later).toHaveBeenCalledOnce();
    stop();
  });
});
