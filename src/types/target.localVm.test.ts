import { describe, expect, it } from "vitest";
import { assertLocal, guestTaskPath, isCloudKey, isGuestPath, isLocalKey, LocalPathLeakError } from "./target";

describe("guest task locations cannot enter host paths or cloud identities", () => {
  const target = { environmentId: "environment", generation: "timeline", workspaceId: "workspace", taskId: "task" };
  it("qualifies identical guest paths by environment, timeline, workspace and task", () => {
    const path = guestTaskPath(target, "/Users/lume/project");
    for (const key of Object.keys(target) as (keyof typeof target)[]) {
      expect(guestTaskPath({ ...target, [key]: "different" }, "/Users/lume/project")).not.toBe(path);
    }
    expect(isGuestPath(path)).toBe(true);
    expect(isLocalKey(path)).toBe(false);
    expect(isCloudKey(path)).toBe(false);
    expect(() => assertLocal(path, "filesystem read")).toThrow(LocalPathLeakError);
  });
  it("rejects even malformed guest URIs before any local operation", () => {
    for (const path of ["local-cua:", "local-cua:/Users/lume", "local-cua://../host"]) {
      expect(() => assertLocal(path)).toThrow(/guest path reached a local command/);
    }
    expect(assertLocal("/Users/developer/project")).toBe("/Users/developer/project");
    expect(() => assertLocal("cloud://org/workspace")).toThrow(/cloud path/);
  });
});
