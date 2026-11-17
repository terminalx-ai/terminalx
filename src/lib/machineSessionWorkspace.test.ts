import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";

const mocks = vi.hoisted(() => ({
  allMachineSessions: vi.fn((): unknown[] => []),
  openWelcome: vi.fn(),
  removeWorkspace: vi.fn(),
  workspaceDisposition: vi.fn(),
  selected: null as string | null,
}));
vi.mock("@/lib/machineCatalog", () => ({ allMachineSessions: mocks.allMachineSessions }));
vi.mock("@/lib/sessions", () => ({ getSessionStore: () => ({ selectedSessionId: mocks.selected, sessions: [] }), openWelcome: mocks.openWelcome, removeWorkspace: mocks.removeWorkspace }));
// This computer's own removal: a machine session's worktree must never reach it.
vi.mock("@/lib/api", () => ({ api: { workspaceDisposition: mocks.workspaceDisposition } }));

import { machineRemovableWorkspace, machineWorkspaceHost } from "./machineSessionWorkspace";

const sessionKey = "machine:m1:P1:s1";
const client = {
  workspaceDisposition: vi.fn(async () => ({ exists: true })),
  removeSessionWorkspace: vi.fn(async () => ({ deleted: ["s1", "s9"], keptBranch: "raccoon/kept", rescuedBranch: null })),
  listSessions: vi.fn(async () => [{ id: "s1" }, { id: "s9" }]),
  hasCapability: vi.fn((capability: string) => capability === "workspace/1"),
};
const host = () => machineWorkspaceHost({ machineId: "m1", name: "Mac mini", sessionId: "s1", sessionKey, client: client as unknown as WorkspaceRpcClient });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selected = sessionKey;
});

// PRO-406: a machine session's worktree is read and removed by that machine, named by the session.
describe("machineWorkspaceHost", () => {
  it("is keyed by the machine and session, so another machine's session of the same id is another worktree", () => {
    const other = machineWorkspaceHost({ machineId: "m2", name: "Server", sessionId: "s1", sessionKey: "machine:m2:P1:s1", client: client as unknown as WorkspaceRpcClient });
    expect(host().key).not.toBe(other.key);
  });

  it("refuses to keep conversations instead of deleting them unasked, naming the machine", async () => {
    expect(host().keepConversationsUnavailable).toContain("Mac mini");
    await expect(host().remove({ keepSessions: true, deleteBranch: false, confirmedDigest: null, expectedSessions: ["s1"] })).rejects.toThrow("cannot keep its conversations");
    expect(client.removeSessionWorkspace).not.toHaveBeenCalled();
  });

  it("asks the machine about the session's worktree, and for the verdict only when the dialog does", async () => {
    await host().disposition();
    await host().disposition({ fetch: true });
    expect(client.workspaceDisposition.mock.calls).toEqual([["s1", undefined], ["s1", { fetch: true }]]);
    expect(mocks.workspaceDisposition).not.toHaveBeenCalled();
  });

  it("removes on the machine only and leaves the deleted session", async () => {
    const outcome = await host().remove({ keepSessions: false, deleteBranch: true, confirmedDigest: "digest", expectedSessions: ["s1", "s9"] });
    expect(client.removeSessionWorkspace).toHaveBeenCalledWith("s1", { deleteBranch: true, confirmedDigest: "digest", expectedSessions: ["s1", "s9"] });
    // Nothing on this computer: no local removal, no local read.
    expect(mocks.removeWorkspace).not.toHaveBeenCalled();
    expect(mocks.workspaceDisposition).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ deleted: ["s1", "s9"], keptBranch: "raccoon/kept" });
    expect(mocks.openWelcome).toHaveBeenCalledWith();
  });

  it("keeps the selection when another session is in front by the time the machine answers", async () => {
    mocks.selected = "machine:m1:P1:other";
    await host().remove({ keepSessions: false, deleteBranch: false, confirmedDigest: null, expectedSessions: ["s1"] });
    expect(mocks.openWelcome).not.toHaveBeenCalled();
  });

  it("leaves the session in front when the machine refuses (uncommitted work, unpushed commits)", async () => {
    client.removeSessionWorkspace.mockRejectedValueOnce(new Error("This workspace needs a second confirmation before it is removed"));
    await expect(host().remove({ keepSessions: false, deleteBranch: false, confirmedDigest: null, expectedSessions: ["s1"] })).rejects.toThrow("second confirmation");
    expect(mocks.openWelcome).not.toHaveBeenCalled();
  });

  it("takes a lost answer for a removal when the machine no longer lists the session", async () => {
    client.removeSessionWorkspace.mockRejectedValueOnce(new Error("timed out"));
    client.listSessions.mockResolvedValueOnce([{ id: "s9" }]);
    const lost = await host().remove({ keepSessions: false, deleteBranch: true, confirmedDigest: null, expectedSessions: ["s1", "s9"] });
    expect(lost).toEqual({ deleted: ["s1"] });
    expect(mocks.openWelcome).toHaveBeenCalledWith();

    // The list could not be read either: nothing is assumed.
    client.removeSessionWorkspace.mockRejectedValueOnce(new Error("timed out"));
    client.listSessions.mockRejectedValueOnce(new Error("offline"));
    await expect(host().remove({ keepSessions: false, deleteBranch: true, confirmedDigest: null, expectedSessions: ["s1"] })).rejects.toThrow("timed out");
  });

  it("knows a turn is running in any session of the worktree on that machine", () => {
    mocks.allMachineSessions.mockReturnValue([
      { machineId: "m1", sessionId: "s1", tabs: [{ status: "idle" }] },
      { machineId: "m1", sessionId: "s9", tabs: [{ status: "waiting" }] },
      { machineId: "m2", sessionId: "s1", tabs: [{ status: "in_progress" }] },
    ]);
    expect(host().turnRunning(["s1"])).toBe(false);
    expect(host().turnRunning(["s1", "s9"])).toBe(true);
    mocks.allMachineSessions.mockReturnValue([]);
    expect(host().turnRunning(["s1", "s9"])).toBe(false);
  });
});

describe("machineRemovableWorkspace", () => {
  const input = {
    client: client as unknown as WorkspaceRpcClient,
    manage: true,
    machineId: "m1",
    name: "Mac mini",
    sessionId: "s1",
    sessionKey,
    projectKey: "machine:m1:P1",
    worktreeName: "read-one",
    worktreeRemoved: false,
    cwd: "/Users/me/worktrees/read-one",
  };

  it("offers a manager the session's worktree on the machine, by the machine's path, shown only", () => {
    const offered = machineRemovableWorkspace(input)!;
    expect(offered).toMatchObject({ projectPath: "machine:m1:P1", path: "/Users/me/worktrees/read-one", name: "read-one" });
    expect(offered.host.key).toBe("machine:m1|s1");
  });

  it("offers nothing to a participant, without workspace/1, in the project's own folder, or once the worktree is gone", () => {
    expect(machineRemovableWorkspace({ ...input, manage: false })).toBeUndefined();
    expect(machineRemovableWorkspace({ ...input, client: null })).toBeUndefined();
    expect(machineRemovableWorkspace({ ...input, worktreeName: null })).toBeUndefined();
    expect(machineRemovableWorkspace({ ...input, worktreeRemoved: true })).toBeUndefined();
    client.hasCapability.mockReturnValueOnce(false);
    expect(machineRemovableWorkspace(input)).toBeUndefined();
  });
});
