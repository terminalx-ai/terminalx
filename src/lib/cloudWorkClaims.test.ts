import { describe, expect, it } from "vitest";
import type { CloudDashboardSession } from "@/lib/cloudDashboard";
import { cloudWorkSessions } from "@/lib/cloudWorkClaims";

function session(patch: Partial<CloudDashboardSession> = {}): CloudDashboardSession {
  return {
    kind: "cloud",
    id: "cloud:org:ws:c1",
    key: "cloud:org:ws:c1",
    orgId: "org",
    orgName: "Acme",
    workspaceId: "ws",
    workspaceName: "widgets",
    sessionId: "c1",
    projectKey: "cloud:org:github.com/acme/widgets",
    projectName: "widgets",
    projectPath: "cloud:org:github.com/acme/widgets",
    cwd: "/workspace",
    repository: "github.com/Acme/Widgets",
    branch: "441-work-status",
    worktreeName: null,
    title: "Work status",
    modified: "2026-10-18T11:00:00Z",
    archived: false,
    connected: true,
    stopped: false,
    fresh: true,
    reportedAt: null,
    tabs: [{ tabId: "t", title: null, requestIds: [], waitingOn: null, from: "live", status: "in_progress", harness: "claude", unread: false } as never],
    ...patch,
  };
}

describe("the cloud sessions handed to the work status publisher", () => {
  it("hands over where each session works and what state it is in, nothing of its conversation", () => {
    const [handed] = cloudWorkSessions([session()], (orgId, workspaceId) => `${orgId}/${workspaceId}-creator`);
    expect(handed).toEqual({
      orgId: "org",
      workspaceId: "ws",
      sessionId: "c1",
      createdBy: "org/ws-creator",
      repository: "Acme/Widgets",
      title: "Work status",
      branch: "441-work-status",
      worktreeName: null,
      status: "in_progress",
      archived: false,
      modified: "2026-10-18T11:00:00Z",
    });
  });

  it("leaves out a session with no branch to name an issue, and reads a stopped workspace as idle", () => {
    const handed = cloudWorkSessions([session({ branch: null }), session({ sessionId: "c2", stopped: true, repository: "gitlab.example.com/a/b" })], () => null);
    expect(handed.map((each) => [each.sessionId, each.status, each.repository])).toEqual([["c2", "idle", null]]);
  });
});
