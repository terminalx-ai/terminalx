import { describe, expect, it } from "vitest";
import { WORKSPACE_CAPABILITIES } from "@terminalx/portable/workspace";
import {
  MACHINE_FEATURES,
  compareVersions,
  featureList,
  machineFeature,
  machineFeatureMessage,
  machineFeaturesMessage,
  machineHasFeature,
  machineIsNewer,
  machineVersionGap,
  missingMachineFeatures,
} from "./machineFeatures";

// What a current machine grants: every namespace but the ones it withholds by design, and machine/1–7.
const WITHHELD = ["keys/1", "mirror/1", "collab/1"];
const CURRENT = [...WORKSPACE_CAPABILITIES.filter((name) => !WITHHELD.includes(name)), "machine/1", "machine/2", "machine/3", "machine/4", "machine/5", "machine/6", "machine/7", "machine/8"];
const without = (...names: string[]) => CURRENT.filter((name) => !names.includes(name));
const connected = { state: "direct", route: { kind: "lan", endpoint: "ws://192.168.1.20:6768/machine/1" }, since: 1, rttMs: 4 } as const;

describe("machine features", () => {
  it("lists only namespaces a machine serves, each once", () => {
    const capabilities = MACHINE_FEATURES.map((feature) => feature.capability);
    expect(new Set(capabilities).size).toBe(capabilities.length);
    for (const withheld of WITHHELD) expect(capabilities).not.toContain(withheld);
    for (const capability of capabilities) expect(CURRENT).toContain(capability);
    expect(machineFeature("ports/1")).toEqual({ id: "ports", label: "Port forwarding", capability: "ports/1", action: "forward ports" });
  });

  it("hides nothing on a current machine, and the withheld namespaces are never missing", () => {
    expect(missingMachineFeatures(CURRENT)).toEqual([]);
    expect(machineVersionGap(connected, CURRENT, "0.2.33", "0.2.33")).toBeNull();
  });

  it("hides a feature whose namespace was not granted", () => {
    const granted = without("ports/1", "agent-commands/1");
    expect(missingMachineFeatures(granted).map((feature) => feature.id)).toEqual(["ports", "agentCommands"]);
    expect(machineHasFeature(granted, "ports/1")).toBe(false);
    expect(machineHasFeature(granted, "session/1")).toBe(true);
    expect(machineHasFeature(granted, "not-a-feature/1")).toBe(true);
  });

  it("names the machine and its version in the one-line message", () => {
    const ports = machineFeature("ports/1")!;
    expect(machineFeatureMessage("ci-box", "0.2.27", ports)).toBe("ci-box runs TerminalX 0.2.27. Update it to forward ports from here.");
    expect(machineFeatureMessage("ci-box", null, ports)).toBe("ci-box runs an older TerminalX. Update it to forward ports from here.");
  });

  it("says Needs update for a connected machine that hides a feature, the older side updating", () => {
    const older = machineVersionGap(connected, without("ports/1"), "0.2.27", "0.2.33");
    expect(older).toEqual({ version: "0.2.27", side: "machine", hidden: [machineFeature("ports/1")] });
    // A newer machine that dropped a namespace: this Mac updates.
    expect(machineVersionGap(connected, without("ports/1"), "0.2.35", "0.2.33")?.side).toBe("thisMac");
    // Not connected: nothing is known to be missing.
    expect(machineVersionGap({ state: "offline", lastSeenAt: null, retryInMs: 10_000 }, null, "0.2.27", "0.2.33")).toBeNull();
  });

  it("takes the connection's needsUpdate and its side", () => {
    expect(machineVersionGap({ state: "needsUpdate", version: "0.2.40", side: "thisMac" }, null, "0.2.33", "0.2.33")).toEqual({ version: "0.2.40", side: "thisMac", hidden: [] });
    expect(machineVersionGap({ state: "needsUpdate", version: null, side: "machine" }, null, "0.2.20", "0.2.33")).toEqual({ version: "0.2.20", side: "machine", hidden: [] });
  });

  it("compares versions and lists features as a sentence", () => {
    expect(compareVersions("0.2.29", "0.2.33")).toBe(-1);
    expect(compareVersions("0.2.33", "0.2.33")).toBe(0);
    expect(compareVersions("v0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2.34-beta.1", "0.2.34")).toBe(-1);
    expect(machineIsNewer("0.2.35", "0.2.33")).toBe(true);
    expect(machineIsNewer("0.2.33", "0.2.33")).toBe(false);
    expect(machineIsNewer(null, "0.2.33")).toBe(false);
    expect(featureList([machineFeature("ports/1")!, machineFeature("pipeline/1")!])).toBe("Port forwarding and issue pipelines");
    expect(featureList([machineFeature("ports/1")!, machineFeature("session/2")!, machineFeature("pipeline/1")!])).toBe("Port forwarding, agent tabs and issue pipelines");
  });

  it("says once, naming the machine, everything it hides", () => {
    const hidden = missingMachineFeatures(without("ports/1", "session/3", "pipeline/1", "machine/3"));
    expect(machineFeaturesMessage("dev-server", "0.2.29", hidden)).toBe("dev-server runs TerminalX 0.2.29. Update it to forward ports, interrupt agents and run issue pipelines from here.");
    expect(machineFeaturesMessage("ci-box", null, [machineFeature("ports/1")!])).toBe("ci-box runs an older TerminalX. Update it to forward ports from here.");
    // Updating from here is the button beside the line, not something to update for.
    expect(machineFeaturesMessage("dev-server", "0.2.29", [machineFeature("machine/3")!])).toBeNull();
    expect(machineFeaturesMessage("dev-server", "0.2.29", [])).toBeNull();
  });

  it("hides Install and Sign in on a machine without machine/4 (PRO-350)", () => {
    const feature = machineFeature("machine/4")!;
    expect(feature).toEqual({ id: "agentSetup", label: "Signing in its agents from here", capability: "machine/4", action: "sign in its agents" });
    expect(machineHasFeature(without("machine/4"), "machine/4")).toBe(false);
    expect(machineHasFeature(CURRENT, "machine/4")).toBe(true);
    expect(machineFeatureMessage("dev-server", "0.2.33", feature)).toBe("dev-server runs TerminalX 0.2.33. Update it to sign in its agents from here.");
    expect(missingMachineFeatures(without("machine/4")).map((entry) => entry.id)).toEqual(["agentSetup"]);
  });

  it("hides Add a project and Remove project on a machine without machine/6 (PRO-351)", () => {
    const feature = machineFeature("machine/6")!;
    expect(feature).toEqual({ id: "projects", label: "Adding projects from here", capability: "machine/6", action: "add and remove its projects" });
    expect(machineHasFeature(without("machine/6"), "machine/6")).toBe(false);
    expect(machineHasFeature(CURRENT, "machine/6")).toBe(true);
    expect(machineFeatureMessage("dev-server", "0.2.33", feature)).toBe("dev-server runs TerminalX 0.2.33. Update it to add and remove its projects from here.");
    expect(missingMachineFeatures(without("machine/6")).map((entry) => entry.id)).toEqual(["projects"]);
    expect(machineFeaturesMessage("dev-server", "0.2.33", missingMachineFeatures(without("machine/4", "machine/6")))).toBe(
      "dev-server runs TerminalX 0.2.33. Update it to sign in its agents and add and remove its projects from here.",
    );
  });

  it("hides a session's Run menu and Setup and Run tabs on a machine without machine/7 (PRO-403)", () => {
    const feature = machineFeature("machine/7")!;
    expect(feature).toEqual({ id: "sessionRuns", label: "Setup and Run scripts", capability: "machine/7", action: "run its sessions' Setup and Run scripts" });
    expect(machineHasFeature(without("machine/7"), "machine/7")).toBe(false);
    expect(machineHasFeature(CURRENT, "machine/7")).toBe(true);
    expect(machineFeatureMessage("dev-server", "0.2.33", feature)).toBe("dev-server runs TerminalX 0.2.33. Update it to run its sessions' Setup and Run scripts from here.");
    expect(missingMachineFeatures(without("machine/7")).map((entry) => entry.id)).toEqual(["sessionRuns"]);
  });
});
