import { describe, expect, it, vi } from "vitest";
import type { CloudDashboardSession } from "@/lib/cloudDashboard";
import stored from "../../src-tauri/src/fixtures/issue_pipeline.json";
import { cloudPipelineView } from "@/lib/cloudPipelines";
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
    created: "2026-10-18T11:00:00Z",
    pinned: false,
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

// Pipeline session IDs are qualified by workspace before the hand-over.
it.each([false, true])("excludes a cloud reviewer (stopped: %s), retaining authors and same IDs in other workspaces", (stopped) => {
  const pipeline = cloudPipelineView({ ...stored, stopped } as never, { orgId: "org", workspaceId: "ws", identity: "github.com/Acme/Widgets", readAt: 1 });
  const cloud = (sessionId: string, workspaceId = "ws") => session({ sessionId, workspaceId, key: `cloud:org:${workspaceId}:${sessionId}` });
  const handed = cloudWorkSessions([cloud("author"), cloud("reviewer-1"), cloud("ordinary"), cloud("reviewer-1", "other")], () => "me", new Set([pipeline.reviewer!.sessionId]));
  expect(handed.map((each) => [each.workspaceId, each.sessionId])).toEqual([["ws", "author"], ["ws", "ordinary"], ["other", "reviewer-1"]]);
});

it("withdraws a reviewer when pipeline identity arrives after the session list", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  let reviewers = new Set<string>();
  let changed = () => {};
  const setCloud = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/lib/api", () => ({ workStatus: { setCloud } }));
  vi.doMock("@/lib/cloudPipelines", () => ({ cloudReviewerSessions: () => reviewers, subscribeCloudPipelines: (listener: () => void) => { changed = listener; } }));
  vi.doMock("@/lib/cloudDashboard", () => ({ getCloudDashboard: () => [session()], subscribeCloudDashboard: vi.fn(), cloudSessionMark: () => "in_progress" }));
  try {
    const { bootCloudWorkClaims } = await import("@/lib/cloudWorkClaims");
    bootCloudWorkClaims();
    await vi.advanceTimersByTimeAsync(2000);
    expect(setCloud.mock.calls[0][0]).toHaveLength(1);
    reviewers = new Set(["cloud:org:ws:c1"]);
    changed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(setCloud).toHaveBeenLastCalledWith([]);
  } finally {
    vi.useRealTimers();
    vi.doUnmock("@/lib/api");
    vi.doUnmock("@/lib/cloudPipelines");
    vi.doUnmock("@/lib/cloudDashboard");
    vi.resetModules();
  }
});
