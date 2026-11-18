import { describe, expect, it } from "vitest";
import { assertLocal, isCloudKey, isLocalKey, isMachineKey, isRemotePath, LocalPathLeakError, machineKeyKind, machineProjectKey, machineProjectRoot, machineSectionKey, machineSessionKey, parseMachineKey } from "./target";

// docs/MACHINES.md decision 8: every machine key starts with `machine:` and no
// guard reads one as local.
describe("machine keys never pass as local", () => {
  const keys = ["machine:m1", "machine:m1:p1", "machine:m1:p1:3f1c2a40-0f3e-4c55-9d3e-1d2b5f6a7b8c", "machine://m1:p1", "machine://m1:p1/src/main.ts"];

  it("refuses machine keys and roots in isRemotePath, isLocalKey and assertLocal", () => {
    for (const key of keys) {
      expect(isRemotePath(key)).toBe(true);
      expect(isLocalKey(key)).toBe(false);
      expect(isMachineKey(key)).toBe(true);
      expect(isCloudKey(key)).toBe(false);
      expect(() => assertLocal(key, "fs.read")).toThrow(LocalPathLeakError);
      expect(() => assertLocal(key, "fs.read")).toThrow(/machine path reached a local command \(fs\.read: /);
    }
  });

  it("keeps local paths, session ids, cloud and org keys apart from machine keys", () => {
    for (const local of ["/Users/developer/code/project", "3f1c2a40-0f3e-4c55-9d3e-1d2b5f6a7b8c"]) {
      expect(isMachineKey(local)).toBe(false);
      expect(isLocalKey(local)).toBe(true);
      expect(assertLocal(local)).toBe(local);
    }
    for (const other of ["cloud:org:workspace", "org:org", null, undefined]) expect(isMachineKey(other)).toBe(false);
  });

  it("builds the section key the workspace view is selected by, and parses keys by their parts", () => {
    expect(machineSectionKey("m1")).toBe("machine:m1");
    expect(parseMachineKey("machine:m1")).toEqual({ machineId: "m1", projectId: null, sessionId: null });
    expect(parseMachineKey("machine:m1:p1")).toEqual({ machineId: "m1", projectId: "p1", sessionId: null });
    expect(parseMachineKey("machine:m1:p1:s1")).toEqual({ machineId: "m1", projectId: "p1", sessionId: "s1" });
    // A display root is not a key, nor is anything with more parts or no id.
    for (const notKey of ["machine://m1:p1", "machine:", "machine:m1:p1:s1:extra", "cloud:org:w", "/Users/x"]) expect(parseMachineKey(notKey)).toBeNull();
  });

  it("builds project and session keys whose part count says which row they are (PRO-346)", () => {
    expect(machineProjectKey("m1", "p1")).toBe("machine:m1:p1");
    expect(machineSessionKey("m1", "p1", "s1")).toBe("machine:m1:p1:s1");
    expect(machineKeyKind(machineSectionKey("m1"))).toBe("machine");
    expect(machineKeyKind(machineProjectKey("m1", "p1"))).toBe("project");
    expect(machineKeyKind(machineSessionKey("m1", "p1", "s1"))).toBe("session");
    // The same project id on two machines gives two keys.
    expect(machineProjectKey("m1", "p1")).not.toBe(machineProjectKey("m2", "p1"));
    for (const other of ["cloud:org:w:s", "/Users/x", "3f1c2a40-0f3e-4c55-9d3e-1d2b5f6a7b8c", "machine://m1:p1", "machine:m1::s1", "machine:m1:p1:", null]) expect(machineKeyKind(other)).toBeNull();
    // A project's display root is refused by every local command, and is not a key.
    expect(() => assertLocal(machineProjectRoot("m1", "p1"))).toThrow(LocalPathLeakError);
    expect(parseMachineKey(machineProjectRoot("m1", "p1"))).toBeNull();
  });
});
