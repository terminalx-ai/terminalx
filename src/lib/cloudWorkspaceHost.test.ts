import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";

const mocks = vi.hoisted(() => ({
  forgetCloudSessions: vi.fn(),
  liveCloudSessionList: vi.fn(),
  selectSession: vi.fn(),
  selected: null as string | null,
}));
vi.mock("@/lib/cloudSessions", () => ({ forgetCloudSessions: mocks.forgetCloudSessions, liveCloudSessionList: mocks.liveCloudSessionList }));
vi.mock("@/lib/sessions", () => ({ getSessionStore: () => ({ selectedSessionId: mocks.selected, sessions: [] }), selectSession: mocks.selectSession, removeWorkspace: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: {} }));

import { cloudWorkspaceHost } from "./cloudWorkspaceHost";

const sessionKey = "cloud:org-1:ws-1:s1";
const client = {
  workspaceDisposition: vi.fn(async () => ({ exists: true })),
  removeSessionWorkspace: vi.fn(async () => ({ deleted: ["s1", "s9"], keptBranch: "raccoon/kept", rescuedBranch: null })),
};
const host = () => cloudWorkspaceHost({ orgId: "org-1", workspaceId: "ws-1", workspaceKey: "cloud:org-1:ws-1", sessionId: "s1", sessionKey, client: client as unknown as WorkspaceRpcClient });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selected = sessionKey;
});

// #411: a cloud session's worktree is read and removed by its runtime, named by the session.
describe("cloudWorkspaceHost", () => {
  it("asks the runtime about the session's worktree, and for the verdict only when the dialog does", async () => {
    await host().disposition();
    await host().disposition({ fetch: true });
    expect(client.workspaceDisposition.mock.calls).toEqual([["s1", undefined], ["s1", { fetch: true }]]);
  });

  it("removes on the runtime, drops the sessions that went with it and leaves the deleted session", async () => {
    const outcome = await host().remove({ keepSessions: false, deleteBranch: true, confirmedDigest: "digest", expectedSessions: ["s1", "s9"] });
    // A cloud worktree is deleted, never settled: `keepSessions` is not the runtime's to read.
    expect(client.removeSessionWorkspace).toHaveBeenCalledWith("s1", { deleteBranch: true, confirmedDigest: "digest", expectedSessions: ["s1", "s9"] });
    expect(mocks.forgetCloudSessions).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "ws-1" }, ["s1", "s9"]);
    expect(mocks.selectSession).toHaveBeenCalledWith(null);
    expect(outcome.keptBranch).toBe("raccoon/kept");
  });

  it("keeps the selection when another session is in front by the time the runtime answers", async () => {
    mocks.selected = "cloud:org-1:ws-1:other";
    await host().remove({ keepSessions: false, deleteBranch: false, confirmedDigest: null, expectedSessions: ["s1"] });
    expect(mocks.selectSession).not.toHaveBeenCalled();
  });

  it("removes nothing here when the runtime refuses", async () => {
    client.removeSessionWorkspace.mockRejectedValueOnce(new Error("This workspace needs a second confirmation before it is removed"));
    await expect(host().remove({ keepSessions: false, deleteBranch: false, confirmedDigest: null, expectedSessions: ["s1"] })).rejects.toThrow("second confirmation");
    expect(mocks.forgetCloudSessions).not.toHaveBeenCalled();
    expect(mocks.selectSession).not.toHaveBeenCalled();
  });

  it("knows a turn is running in any session of the worktree from the workspace's live list", () => {
    mocks.liveCloudSessionList.mockReturnValue([
      { id: "s1", tabs: [{ status: "idle" }] },
      { id: "s9", tabs: [{ status: "waiting" }] },
      { id: "elsewhere", tabs: [{ status: "in_progress" }] },
    ]);
    expect(host().turnRunning(["s1"])).toBe(false);
    expect(host().turnRunning(["s1", "s9"])).toBe(true);
    mocks.liveCloudSessionList.mockReturnValue(null);
    expect(host().turnRunning(["s1", "s9"])).toBe(false);
  });
});
