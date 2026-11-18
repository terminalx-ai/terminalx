import { describe, expect, it } from "vitest";
import { compareAgentVersions } from "./agentVersion";

describe("agent release precedence", () => {
  it.each([
    ["2.3.41-beta.1", "2.3.41"],
    ["2.3.41-alpha", "2.3.41-alpha.1"],
    ["2.3.41-alpha.1", "2.3.41-alpha.beta"],
    ["2.3.41-alpha.beta", "2.3.41-beta"],
    ["2.3.41-beta.2", "2.3.41-beta.11"],
    ["2.3.41-beta.11", "2.3.41-rc.1"],
    ["2.3.41-rc.1", "2.3.41"],
    ["2.3.41-1", "2.3.41-alpha"],
    ["2.3.41-beta-1", "2.3.41-beta-2"],
    ["2.3.41", "2.3.42-alpha"],
    ["2.3.99", "2.4.0"],
    ["2.99.99", "3.0.0"],
    ["2.3.41+999", "2.3.42+1"],
    ["2.3.41-beta.9007199254740992", "2.3.41-beta.9007199254740993"],
  ])("orders %s before %s in both directions", (older, newer) => {
    expect(compareAgentVersions(older, newer)).toBe(-1);
    expect(compareAgentVersions(newer, older)).toBe(1);
  });

  it.each([
    ["2.3.41", "2.3.41"],
    ["2.3.41-beta.1", "2.3.41-beta.1"],
    ["v2.3.41", "2.3.41"],
    ["2.3.41+build.1", "2.3.41+build.2"],
    ["2.3.41+001", "2.3.41"],
    ["2.3.41-beta.1+build.1", "2.3.41-beta.1+build.2"],
  ])("treats %s and %s as equal", (a, b) => {
    expect(compareAgentVersions(a, b)).toBe(0);
    expect(compareAgentVersions(b, a)).toBe(0);
  });

  it.each([
    "", "unknown", "2.3", "2.3.41.0", "02.3.41", "2.03.41", "2.3.041",
    "2.3.41oops", "2.3.41-", "2.3.41-beta..1", "2.3.41-beta.01",
    "2.3.41+", "2.3.41+build..1", "2.3.41+build_1", "2.3.41\n",
  ])("does not claim precedence for malformed %j, even against itself", (version) => {
    expect(compareAgentVersions(version, "2.3.41")).toBeNull();
    expect(compareAgentVersions("2.3.41", version)).toBeNull();
    expect(compareAgentVersions(version, version)).toBeNull();
  });
});
