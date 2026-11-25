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
