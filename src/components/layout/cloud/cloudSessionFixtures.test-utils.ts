import type { CloudSessionRow } from "@/lib/cloudSessions";
import type { OrganizationMember } from "@/lib/organizationMembers";

export const sidebarOwner: OrganizationMember = {
  userId: "owner-one", displayName: "Avery Owner", email: "avery@example.test", role: "member",
  photoUrl: "https://example.test/avery.png",
};

export function loadedSidebarSessions(workspaceId = "one"): CloudSessionRow[] {
  return ["Review fix", "Follow-up"].map((title, index) => ({
    key: `cloud:workspace-org:${workspaceId}:session-${index}`, orgId: "workspace-org", workspaceId,
    sessionId: `session-${index}`, title, branch: null, worktreeName: null,
    created: "2026-11-16T10:00:00Z", modified: "2026-11-16T11:00:00Z",
    pinned: false, archived: false, tabs: [], source: "live",
    ...(index === 0 ? { rowStatus: { tabs: [], branch: "fix", branchStatus: { branch: "fix", checked: true, pr: { number: 42, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: null, inMergeQueue: false } } } } : {}),
  }));
}

// A roster can be authorized while the workspace creator is no longer a member.
export const unavailableSidebarOwner = { ...sidebarOwner, userId: "someone-else" };
