import type { RuntimeSession } from "@terminalx/portable/workspace";
import type { CloudWorkspaceListItem } from "@/lib/api";
import type { CloudAgentTab } from "@/lib/cloudAgents";
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

// ---- #1172: several agents in one session ----------------------------------

/** The workspace the three-agent session runs in; `fields` set its state or this person's role. */
export function threeAgentWorkspace(fields: Record<string, unknown> = {}): CloudWorkspaceListItem {
  return { workspace: { id: "one", orgId: "workspace-org", name: "One", state: "ready", provider: "box", authority: "manage", launch: null, ...fields }, latestOperation: null } as unknown as CloudWorkspaceListItem;
}

/**
 * One session holding three agent tabs, as `session.list` reports it: a
 * Codex tab that is working, a Claude tab added later with an unread reply,
 * and a second Codex tab that is idle and has no title of its own yet. The
 * runtime has the newest tab in front.
 */
export function threeAgentSession(): RuntimeSession {
  const tab = (id: string, harness: string, title: string | null, status: RuntimeSession["tabs"][number]["status"]) => ({
    id, harness, title, model: "", permissionMode: "auto", status, created: "2026-11-17T10:00:00.000Z", modified: "2026-11-17T10:15:00.000Z",
  });
  return {
    id: "agents", projectPath: "/workspace", cwd: "/workspace", title: "Fix the flaky build", branch: "fix/flaky-build",
    created: "2026-11-17T10:00:00.000Z", modified: "2026-11-17T10:15:00.000Z", archived: false, pinned: false,
    tabs: [tab("tab-codex", "codex", "Fix the flaky build", "in_progress"), tab("tab-claude", "claude", "Review the fix", "completed"), tab("tab-codex-2", "codex", null, "idle")],
    activeTab: "tab-codex-2",
  };
}

/** What this desktop knows of a tab of that session: `pending` permission requests make it wait on the person. */
export function threeAgentTab(tabId: string, harness: string, status: CloudAgentTab["info"]["status"], pending = 0): CloudAgentTab {
  return {
    tabId, source: "live", placeholder: false, live: true, unread: false, completed: false,
    info: {
      sessionId: "agents", tabId, harness, title: null, status,
      pendingPermissions: Array.from({ length: pending }, (_, index) => ({ requestId: `request-${index}`, toolName: "Bash", input: {}, options: [] })),
    },
  } as unknown as CloudAgentTab;
}
