import { describe, expect, it } from "vitest";
import type { MachineFolder } from "@terminalx/portable/workspace";
import { cloneDestination, cloneEndText, cloneFolderName, cloneProgressText, folderLabel, folderSummary, sessionCountText } from "./machineProjects";

const folder = (patch: Partial<MachineFolder> = {}): MachineFolder => ({ name: "relay-bench", path: "/home/paresh/code/relay-bench", git: null, projectId: null, ...patch });

describe("a machine's projects, in words", () => {
  it("counts sessions as 21.10 does", () => {
    expect(sessionCountText(0)).toBe("No sessions");
    expect(sessionCountText(1)).toBe("1 session");
    expect(sessionCountText(2)).toBe("2 sessions");
  });

  it("labels a folder as 21.11 does, a project first", () => {
    expect(folderLabel(folder({ git: { branch: "main", github: true } }))).toBe("Git · main");
    expect(folderLabel(folder({ git: { branch: null, github: false } }))).toBe("Git · detached");
    expect(folderLabel(folder())).toBe("Not a Git repository");
    expect(folderLabel(folder({ git: { branch: "main", github: true }, projectId: "cmVsYXliZW5jaDAw" }))).toBe("Already a project");
  });

  it("sums up the chosen folder for the footer", () => {
    expect(folderSummary(folder({ git: { branch: "main", github: true } }))).toBe("Git repository · main · origin on GitHub");
    expect(folderSummary(folder({ git: { branch: "main", github: false } }))).toBe("Git repository · main");
    expect(folderSummary(folder({ git: { branch: null, github: false } }))).toBe("Git repository");
    expect(folderSummary(folder())).toBe("Folder");
  });

  it("names the folder a clone makes, as the runtime does", () => {
    expect(cloneFolderName("procyon/relay-private")).toBe("relay-private");
    expect(cloneFolderName("https://github.com/procyon/relay-private.git")).toBe("relay-private");
    expect(cloneFolderName("git@github.com:procyon/relay-private.git")).toBe("relay-private");
    expect(cloneFolderName("https://github.com/procyon/relay-private/")).toBe("relay-private");
    expect(cloneFolderName("  ")).toBeNull();
    expect(cloneFolderName("..")).toBeNull();
    expect(cloneDestination("/home/paresh/code/", "procyon/relay-private")).toBe("/home/paresh/code/relay-private");
    expect(cloneDestination("/home/paresh/code", "")).toBeNull();
  });

  it("says how a clone is going and how it ended", () => {
    expect(cloneProgressText({ stage: "Receiving objects", percent: 41.6 })).toBe("Receiving objects · 42%");
    expect(cloneProgressText({ stage: null, percent: null })).toBe("Starting the clone…");
    expect(cloneEndText({ state: "failed", error: { code: "access-denied", message: "No access." } })).toBe("No access.");
    expect(cloneEndText({ state: "failed", error: null })).toBe("The clone failed.");
    expect(cloneEndText({ state: "canceled", error: null })).toBe("The clone was canceled. Nothing was left on the machine.");
    expect(cloneEndText({ state: "cloning", error: null })).toBeNull();
  });
});
