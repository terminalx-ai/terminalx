import { describe, expect, it, vi } from "vitest";
import type { MachineProject, RuntimeSession } from "@terminalx/portable/workspace";
import type { RemoteRepository } from "@terminalx/portable/workspaceGit";

vi.mock("@/components/terminal/TerminalView", () => ({ createTerminal: vi.fn() }));

const { machinePortsOffered, machineSendBlocked, resetMachinePortsGrants, sessionFilesBase, sessionRepository, worktreeInProject } = await import("./machineSession");

const project = { projectId: "p1", name: "terminalx", path: "/Users/me/code/terminalx", kind: "git", defaultBranch: "main", archived: false } as MachineProject;
const session = (cwd: string) => ({ id: "s1", projectId: "p1", cwd }) as RuntimeSession;
const repository = (repo: string): RemoteRepository => ({ repo, branch: null, head: null, remote: null, defaultBranch: null });
const repositories = [repository("."), repository(".raccoon/worktrees/read"), repository("/Users/me/worktrees/elsewhere")];

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
  it("is the session's worktree inside the project", () => {
    expect(sessionRepository(repositories, project, session("/Users/me/code/terminalx/.raccoon/worktrees/read"))).toBe(".raccoon/worktrees/read");
  });

  it("is a worktree outside the project by the absolute path git.repositories names", () => {
    expect(sessionRepository(repositories, project, session("/Users/me/worktrees/elsewhere"))).toBe("/Users/me/worktrees/elsewhere");
  });

  it("uses the closest containing worktree for a session in a subfolder", () => {
    const nested = ".raccoon/worktrees/read/nested";
    const withNested = [...repositories, repository(nested)];
    expect(sessionRepository(withNested, project, session(`${project.path}/${nested}/src`))).toBe(nested);
    expect(sessionRepository(withNested, project, session(`${project.path}/${nested}-other/src`))).toBe(".raccoon/worktrees/read");
    expect(sessionRepository(repositories, project, session("/Users/me/worktrees/elsewhere/src"))).toBe("/Users/me/worktrees/elsewhere");
    expect(sessionRepository(repositories, project, session("/Users/me/worktrees/elsewhere-other/src"))).toBeNull();
  });

  it("uses a default for a project with no session loaded", () => {
    expect(sessionRepository(repositories, project, null)).toBe(".");
    expect(sessionRepository([repository("lib")], project, null)).toBe("lib");
    expect(sessionRepository([], project, null)).toBeNull();
  });
});

describe("where a machine session's Files are rooted (PRO-405)", () => {
  it.each([
    ["project root", project.path, "", ""],
    ["project subfolder", `${project.path}/src`, "src", ""],
    ["internal worktree root", `${project.path}/.raccoon/worktrees/read`, ".raccoon/worktrees/read", ".raccoon/worktrees/read"],
    ["internal worktree subfolder", `${project.path}/.raccoon/worktrees/read/src/lib`, ".raccoon/worktrees/read/src/lib", ".raccoon/worktrees/read"],
    ["external worktree root", "/Users/me/worktrees/elsewhere", null, "/Users/me/worktrees/elsewhere"],
    ["external worktree subfolder", "/Users/me/worktrees/elsewhere/src/lib/", null, "/Users/me/worktrees/elsewhere"],
    ["unlisted external folder", "/Users/me/worktrees/elsewhere-other/src", null, null],
    ["external cwd with parent traversal", "/Users/me/worktrees/elsewhere/../other", null, null],
  ])("resolves the %s before and after repository discovery", (_name, cwd, loading, populated) => {
    expect(sessionFilesBase(null, project, session(cwd))).toBe(loading);
    expect(sessionFilesBase(repositories, project, session(cwd))).toBe(populated);
  });

  it("waits for a session and uses its internal cwd even when Git discovery returns no repositories", () => {
    expect(sessionFilesBase([], project, session("/Users/me/worktrees/elsewhere"))).toBeNull();
    expect(sessionFilesBase([], project, session("/Users/me/code/terminalx/.raccoon/worktrees/read"))).toBe(".raccoon/worktrees/read");
    expect(sessionFilesBase(null, project, null)).toBeNull();
  });

  it("uses the runtime's canonical path for both Files and Changes when the cwd uses an alias", () => {
    const fileRoot = "/Users/me/worktrees/elsewhere";
    const aliased = { ...session("/Users/me/worktree-alias/elsewhere/src"), fileRoot, fileRepository: fileRoot };
    expect(sessionFilesBase(null, project, aliased)).toBe(fileRoot);
    expect(sessionFilesBase(repositories, project, aliased)).toBe(aliased.fileRoot);
    expect(sessionRepository(repositories, project, aliased)).toBe("/Users/me/worktrees/elsewhere");
  });

  it.each(["/Users/me/worktrees/late", ".raccoon/worktrees/late"])("uses %s even when the repository list omits it", (fileRoot) => {
    const beyondLimit = { ...session("unused"), fileRoot, fileRepository: fileRoot };
    expect(sessionFilesBase(repositories, project, beyondLimit)).toBe(fileRoot);
    expect(sessionRepository(repositories, project, beyondLimit)).toBe(fileRoot);
  });

  it("uses Files at a folder project without a Git repository", () => {
    const folder = { ...session(project.path), fileRoot: "", fileRepository: null };
    expect(sessionFilesBase(null, project, folder)).toBe("");
    expect(sessionRepository(repositories, project, folder)).toBeNull();
  });

  it("does not open the project for a removed checkout", () => {
    const removed = { ...session("/Users/me/worktrees/elsewhere"), fileRoot: null };
    expect(sessionFilesBase(repositories, project, removed)).toBeNull();
    expect(sessionRepository(repositories, project, removed)).toBeNull();
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
