import { describe, expect, it } from "vitest";
import { machineGone } from "./cloudMachineGone";

const failedResume = { state: "failed", action: "resume", errorCode: "cloud_provider_not_found" };

describe("a cloud workspace whose machine is gone (#1581)", () => {
  it("is a resume the provider answered with not found", () => {
    expect(machineGone(failedResume)).toBe(true);
    expect(machineGone({ ...failedResume, detailCode: "box_lost_without_checkpoint" })).toBe(true);
  });

  it("is not a stop or an archive, which a resume may still restore", () => {
    for (const action of ["suspend", "archive", "delete", null]) expect(machineGone({ ...failedResume, action, detailCode: "box_missing" })).toBe(false);
  });

  it("is not a missing environment image, another code, or an operation that has not failed", () => {
    expect(machineGone({ ...failedResume, detailCode: "environment_image_missing" })).toBe(false);
    expect(machineGone({ ...failedResume, errorCode: "cloud_provider_unavailable" })).toBe(false);
    expect(machineGone({ ...failedResume, state: "running" })).toBe(false);
    expect(machineGone(null)).toBe(false);
  });
});

describe("the server's own word that the machine is gone (#1589)", () => {
  it("is a failed stop, resume or archive with the machine_missing detail, whatever its error code", () => {
    for (const action of ["suspend", "resume", "archive"]) {
      expect(machineGone({ state: "failed", action, errorCode: "cloud_provider_not_found", detailCode: "machine_missing" })).toBe(true);
      // TerminalX Cloud: a box lost with its node and no checkpoint to rebuild from.
      expect(machineGone({ state: "failed", action, errorCode: "cloud_provider_state_conflict", detailCode: "machine_missing" })).toBe(true);
    }
    expect(machineGone({ state: "running", action: "resume", detailCode: "machine_missing" })).toBe(false);
  });

  it("is a workspace needing attention with machineMissingAt, even with no failed operation", () => {
    const marked = { state: "attention-required", machineMissingAt: 1_795_305_607_000 };
    expect(machineGone(null, marked)).toBe(true);
    expect(machineGone({ state: "succeeded", action: "suspend" }, marked)).toBe(true);
  });

  it("is not a workspace that left attention, or one without the fact", () => {
    expect(machineGone(null, { state: "suspended", machineMissingAt: 1_795_305_607_000 })).toBe(false);
    expect(machineGone(null, { state: "attention-required", machineMissingAt: null })).toBe(false);
    expect(machineGone(null, { state: "attention-required" })).toBe(false);
  });
});
