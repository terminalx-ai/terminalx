import { describe, expect, it, vi } from "vitest";
import type { MachineProject, RuntimeSession } from "@terminalx/portable/workspace";

vi.mock("@/components/terminal/TerminalView", () => ({ createTerminal: vi.fn() }));

const { machinePortsOffered, machineSendBlocked, resetMachinePortsGrants, sessionFilesBase, sessionRepository, worktreeInProject } = await import("./machineSession");

const project = { projectId: "p1", name: "terminalx", path: "/Users/me/code/terminalx", kind: "git", defaultBranch: "main", archived: false } as MachineProject;
const session = (cwd: string) => ({ id: "s1", projectId: "p1", cwd }) as RuntimeSession;

describe("where a machine session's worktree is in its project (PRO-347)", () => {
  it.each([
    ["the project's own folder", "/Users/me/code/terminalx", "."],
    ["a trailing slash on either", "/Users/me/code/terminalx/", "."],
    ["a worktree inside it", "/Users/me/code/terminalx/.raccoon/worktrees/read", ".raccoon/worktrees/read"],
    ["a sibling folder sharing the prefix", "/Users/me/code/terminalx-server", null],
    ["a worktree outside the project", "/Users/me/worktrees/read", null],
    ["a path that climbs out", "/Users/me/code/terminalx/../other", null],
  ])("%s", (_name, cwd, expected) => {
    expect(worktreeInProject(project.path, cwd)).toBe(expected);
  });

  it("is unknown without both paths", () => {
    expect(worktreeInProject(null, "/a")).toBeNull();
    expect(worktreeInProject("/a", undefined)).toBeNull();
  });
});

describe("the repository Changes shows for a machine session", () => {
  const repositories = [{ repo: "." }, { repo: ".raccoon/worktrees/read" }, { repo: "/Users/me/worktrees/elsewhere" }] as never[];

  it("is the session's worktree inside the project", () => {
    expect(sessionRepository(repositories, project, session("/Users/me/code/terminalx/.raccoon/worktrees/read"))).toBe(".raccoon/worktrees/read");
  });

  it("is a worktree outside the project by the absolute path git.repositories names", () => {
    expect(sessionRepository(repositories, project, session("/Users/me/worktrees/elsewhere"))).toBe("/Users/me/worktrees/elsewhere");
  });

  it("falls back to the project's own repository, then the first one", () => {
    expect(sessionRepository(repositories, project, session("/Users/me/worktrees/gone"))).toBe(".");
    expect(sessionRepository([{ repo: "lib" }] as never[], project, null)).toBe("lib");
    expect(sessionRepository([], project, null)).toBeNull();
  });
});

describe("where a machine session's Files are rooted (PRO-405)", () => {
  const repositories = [{ repo: "." }, { repo: ".raccoon/worktrees/read" }, { repo: "/Users/me/worktrees/elsewhere" }] as never[];

  it("is the repository Changes shows, so the two agree", () => {
    for (const cwd of ["/Users/me/code/terminalx", "/Users/me/code/terminalx/.raccoon/worktrees/read", "/Users/me/worktrees/elsewhere", "/Users/me/worktrees/gone"]) {
      const shown = sessionRepository(repositories, project, session(cwd));
      expect(sessionFilesBase(repositories, project, session(cwd))).toBe(shown === "." ? "" : shown);
    }
    expect(sessionFilesBase(repositories, project, session("/Users/me/worktrees/elsewhere"))).toBe("/Users/me/worktrees/elsewhere");
  });

  it("roots a worktree inside the project at once, and waits for the list for one outside it", () => {
    expect(sessionFilesBase(null, project, session("/Users/me/code/terminalx/.raccoon/worktrees/read"))).toBe(".raccoon/worktrees/read");
    expect(sessionFilesBase(null, project, session("/Users/me/code/terminalx"))).toBe("");
    expect(sessionFilesBase(null, project, session("/Users/me/worktrees/elsewhere"))).toBeNull();
  });

  it("is the project's folder when nothing names the worktree", () => {
    expect(sessionFilesBase([], project, session("/Users/me/worktrees/elsewhere"))).toBe("");
    expect(sessionFilesBase([], project, session("/Users/me/code/terminalx/.raccoon/worktrees/read"))).toBe(".raccoon/worktrees/read");
    expect(sessionFilesBase(null, project, null)).toBe("");
  });
});

describe("sending while the machine is away", () => {
  it("is blocked until it is connected, naming the machine (21.09)", () => {
    expect(machineSendBlocked("Mac mini", { state: "reconnecting", attempt: 1, reason: "network", retryInMs: 1000 })).toBe("Can't send until Mac mini is back");
    expect(machineSendBlocked("Mac mini", { state: "idle" })).toBe("Can't send until Mac mini is back");
    expect(
      machineSendBlocked("Mac mini", { state: "connected", runtimeGeneration: 1, runtimeVersion: "0.2.33", capabilities: [], authority: "manage" }),
    ).toBeNull();
  });
});

describe("the Ports tab and forward chip of a machine session (PRO-355)", () => {
  const connected = (capabilities: string[]) => ({ state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.3.0", capabilities, authority: "manage" }) as const;
  const reconnecting = { state: "reconnecting", attempt: 1, reason: "closed", retryInMs: 1000 } as const;

  it("is offered while the machine grants ports/1, and stays through a reconnect: its forwards wait for it", () => {
    resetMachinePortsGrants();
    expect(machinePortsOffered("m1", { state: "idle" })).toBe(false);
    expect(machinePortsOffered("m1", connected(["pty/1", "ports/1"]))).toBe(true);
    expect(machinePortsOffered("m1", reconnecting)).toBe(true);
    expect(machinePortsOffered("m1", { state: "idle" })).toBe(true);
    // Another machine's grant is its own.
    expect(machinePortsOffered("m2", reconnecting)).toBe(false);
  });

  it("is not offered for a machine without ports/1 (an older TerminalX), connected or away", () => {
    resetMachinePortsGrants();
    expect(machinePortsOffered("old", connected(["pty/1", "fs/1"]))).toBe(false);
    expect(machinePortsOffered("old", reconnecting)).toBe(false);
    // Updated, it grants ports/1 on its next connection; an update that drops it again hides them again.
    expect(machinePortsOffered("old", connected(["pty/1", "ports/1"]))).toBe(true);
    expect(machinePortsOffered("old", connected(["pty/1"]))).toBe(false);
  });
});
