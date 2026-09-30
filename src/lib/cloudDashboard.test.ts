import { describe, expect, it } from "vitest";
import type { RuntimeSession } from "@terminalx/portable/workspace";
import type { CloudWorkspaceListItem } from "@/lib/api";
import type { CloudAgentTab } from "@/lib/cloudAgents";
import type { AgentTabInfo } from "@/lib/cloudAgentApi";
import type { OrgCatalog } from "@/lib/cloudCatalog";
import type { HarnessInfo } from "@/types/session";
import { bucketSessions } from "@/lib/dashboard";
import { buildCloudPaletteSessions, searchPaletteIndex, withCloudSessions } from "@/lib/commandPalette";
import { attentionTab, createCloudAttentionTracker, projectCloudSessions, type CloudDashboardSession, type CloudProjectionInput } from "./cloudDashboard";

// PRO-23 CS-19: cloud sessions projected into the dashboard's sessions, the
// notices they raise (once each), and the palette documents they become.

const ORG = "org-a";
const acmeApi = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };

function item(id: string, fields: Record<string, unknown> = {}, orgId = ORG): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId, name: id, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, repositories: [acmeApi], ...fields },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

function session(id: string, title: string, status: RuntimeSession["tabs"][number]["status"] = "idle", fields: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id,
    projectPath: "/workspace",
    cwd: "/workspace",
    title,
    created: "2026-09-30T10:00:00.000Z",
    modified: "2026-09-30T11:00:00.000Z",
    archived: false,
    pinned: false,
    tabs: [{ id: `${id}-tab`, harness: "claude", title: null, model: "opus", permissionMode: "bypassPermissions", status, created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" }],
    ...fields,
  } as RuntimeSession;
}

function agentTab(sessionId: string, status: AgentTabInfo["status"], requests: string[] = [], live = true): CloudAgentTab {
  return {
    tabId: `${sessionId}-tab`,
    info: {
      sessionId,
      tabId: `${sessionId}-tab`,
      title: null,
      harness: "claude",
      model: "opus",
      effort: null,
      permissionMode: "default",
      status,
      process: "running",
      pendingPermissions: requests.map((requestId) => ({ requestId, toolName: "Bash", input: {}, options: [] })),
      followUps: [],
      lastSeq: 0,
      created: "2026-09-30T10:00:00.000Z",
      modified: "2026-09-30T11:00:00.000Z",
    } as AgentTabInfo,
    source: live ? "live" : "cache",
    placeholder: false,
    cursor: null,
    checkpoint: null,
    unread: status === "completed",
    completed: status === "completed",
    live,
    pendingConfig: null,
  };
}

interface World {
  workspaces: CloudWorkspaceListItem[];
  cached?: Record<string, RuntimeSession[]>;
  live?: Record<string, RuntimeSession[]>;
  tabs?: Record<string, CloudAgentTab[]>;
  connected?: string[];
  source?: "cache" | "live";
  orgs?: { id: string; name: string }[];
}

function input(world: World): CloudProjectionInput {
  const orgs = world.orgs ?? [{ id: ORG, name: "Acme" }];
  const catalogs: Record<string, OrgCatalog> = {};
  for (const org of orgs) {
    catalogs[org.id] = {
      orgId: org.id,
      workspaces: world.workspaces.filter((entry) => entry.workspace.orgId === org.id),
      repositories: null,
      repositoriesAt: null,
      quota: null,
      fetchedAt: 1,
      source: world.source ?? "live",
      error: null,
      sessions: Object.fromEntries(Object.entries(world.cached ?? {}).map(([id, sessions]) => [id, { sessions, capabilities: ["session/2"], at: 1 }])),
    };
  }
  return {
    orgs,
    catalog: { orgs: catalogs, createMemory: {} },
    liveSessions: (_orgId, workspaceId) => world.live?.[workspaceId] ?? null,
    agentTabs: (_orgId, workspaceId) => world.tabs?.[workspaceId] ?? [],
    connected: (_orgId, workspaceId) => (world.connected ?? []).includes(workspaceId),
  };
}

const project = (world: World) => projectCloudSessions(input(world));
const columnOf = (sessions: CloudDashboardSession[], key: string) => {
  const buckets = bucketSessions(sessions);
  return (Object.keys(buckets) as (keyof typeof buckets)[]).find((column) => buckets[column].some((entry) => entry.id === key)) ?? null;
};

describe("cloud sessions in the dashboard's columns", () => {
  it("uses the live tab state while connected: waiting is Needs you, in progress is Working", () => {
    const sessions = project({
      workspaces: [item("ws-1", { runtimeActivity: { online: true, reportedAt: 1, activeTurns: 0, pendingApprovals: 0 } })],
      live: { "ws-1": [session("s1", "Fix login"), session("s2", "Add tests")] },
      tabs: { "ws-1": [agentTab("s1", "waiting", ["r1"]), agentTab("s2", "in_progress")] },
      connected: ["ws-1"],
    });
    // Live beats the list: the list says nothing is pending, the runtime says s1 waits.
    expect(columnOf(sessions, `cloud:${ORG}:ws-1:s1`)).toBe("needs");
    expect(columnOf(sessions, `cloud:${ORG}:ws-1:s2`)).toBe("working");
    const waiting = sessions.find((entry) => entry.sessionId === "s1")!;
    expect(waiting).toMatchObject({ kind: "cloud", orgName: "Acme", projectName: "acme/api", projectPath: `cloud:${ORG}:github.com/acme/api`, connected: true });
    expect(waiting.tabs[0]).toMatchObject({ status: "waiting", from: "live", requestIds: ["r1"], waitingOn: "Bash" });
    expect(attentionTab(waiting)?.tabId).toBe("s1-tab");
  });

  it("uses the list's pendingApprovals when not connected, placed on the tab the cache says was working", () => {
    const sessions = project({
      workspaces: [item("ws-1", { runtimeActivity: { online: true, reportedAt: 5, activeTurns: 0, pendingApprovals: 1 } })],
      cached: { "ws-1": [session("s1", "Fix login", "in_progress"), session("s2", "Old", "idle", { modified: "2026-09-30T12:00:00.000Z" })] },
    });
    expect(columnOf(sessions, `cloud:${ORG}:ws-1:s1`)).toBe("needs");
    expect(sessions.find((entry) => entry.sessionId === "s1")!.tabs[0]).toMatchObject({ status: "waiting", from: "list" });
    expect(columnOf(sessions, `cloud:${ORG}:ws-1:s2`)).toBe("done");
  });

  it("with nothing cached as working, the list's wait goes on the newest session's first tab", () => {
    const sessions = project({
      workspaces: [item("ws-1", { runtimeActivity: { online: true, reportedAt: 5, activeTurns: 0, pendingApprovals: 2 } })],
      cached: { "ws-1": [session("s1", "Older"), session("s2", "Newest", "idle", { modified: "2026-09-30T12:00:00.000Z" })] },
    });
    expect(columnOf(sessions, `cloud:${ORG}:ws-1:s2`)).toBe("needs");
    expect(columnOf(sessions, `cloud:${ORG}:ws-1:s1`)).toBe("done");
  });

  it("a stale cached wait yields to a list that says nothing is pending", () => {
    const sessions = project({
      workspaces: [item("ws-1", { runtimeActivity: { online: true, reportedAt: 5, activeTurns: 0, pendingApprovals: 0 } })],
      cached: { "ws-1": [session("s1", "Answered on the phone", "waiting")] },
    });
    expect(columnOf(sessions, `cloud:${ORG}:ws-1:s1`)).toBe("done");
  });

  it("the list's activeTurns shows Working; a finished, unread tab is Done", () => {
    const sessions = project({
      workspaces: [item("ws-1", { runtimeActivity: { online: true, reportedAt: 5, activeTurns: 1, pendingApprovals: 0 } }), item("ws-2", { runtimeActivity: { online: true, reportedAt: 5, activeTurns: 0, pendingApprovals: 0 } })],
      cached: { "ws-1": [session("s1", "Busy", "in_progress")], "ws-2": [session("s2", "Finished", "completed")] },
    });
    expect(columnOf(sessions, `cloud:${ORG}:ws-1:s1`)).toBe("working");
    expect(columnOf(sessions, `cloud:${ORG}:ws-2:s2`)).toBe("done");
    expect(sessions.find((entry) => entry.sessionId === "s2")!.tabs[0].status).toBe("completed");
  });

  it("never shows a stopped workspace as Working: not from the cache, a live tab, or the list", () => {
    for (const world of [
      { workspaces: [item("ws-1", { state: "suspended" })], cached: { "ws-1": [session("s1", "Long task", "in_progress")] } },
      { workspaces: [item("ws-1", { state: "suspended" })], cached: { "ws-1": [session("s1", "Long task", "in_progress")] }, tabs: { "ws-1": [agentTab("s1", "in_progress")] } },
      { workspaces: [item("ws-1", { state: "suspended", runtimeActivity: { online: true, reportedAt: 5, activeTurns: 3, pendingApprovals: 0 } })], cached: { "ws-1": [session("s1", "Long task", "in_progress")] } },
      { workspaces: [item("ws-1", { state: "suspended" })], live: { "ws-1": [session("s1", "Long task", "in_progress")] }, tabs: { "ws-1": [agentTab("s1", "in_progress")] }, connected: ["ws-1"] },
    ] satisfies World[]) {
      const sessions = project(world);
      expect(columnOf(sessions, `cloud:${ORG}:ws-1:s1`)).not.toBe("working");
      expect(sessions[0].stopped).toBe(true);
    }
  });

  it("does not trust a cached working tab of a workspace it is not connected to (older server)", () => {
    const sessions = project({ workspaces: [item("ws-1")], cached: { "ws-1": [session("s1", "Maybe", "in_progress")] } });
    expect(columnOf(sessions, `cloud:${ORG}:ws-1:s1`)).toBe("done");
  });

  it("covers every live organization, leaves archived workspaces and sessions out, and never names a local path", () => {
    const sessions = project({
      orgs: [{ id: ORG, name: "Acme" }, { id: "org-b", name: "Beta" }],
      workspaces: [item("ws-1"), item("ws-b", {}, "org-b"), item("gone", { state: "archived" })],
      cached: { "ws-1": [session("s1", "Acme work"), session("old", "Archived", "idle", { archived: true })], "ws-b": [session("sb", "Beta work")], gone: [session("sg", "Gone")] },
    });
    expect(sessions.map((entry) => entry.key).sort()).toEqual([`cloud:${ORG}:ws-1:s1`, "cloud:org-b:ws-b:sb"]);
    expect(sessions.find((entry) => entry.orgId === "org-b")!.orgName).toBe("Beta");
    for (const entry of sessions) expect(entry.cwd.startsWith("/")).toBe(false);
  });
});

describe("one notice per wait", () => {
  const waitingWorld = (fields: Partial<World> = {}): World => ({
    workspaces: [item("ws-1", { runtimeActivity: { online: true, reportedAt: 100, activeTurns: 0, pendingApprovals: 1 } })],
    cached: { "ws-1": [session("s1", "Fix login", "in_progress")] },
    ...fields,
  });

  it("raises a list-reported wait once, however many polls repeat it", () => {
    const observe = createCloudAttentionTracker(() => 1_000);
    const raised = [1, 2, 3, 4].flatMap(() => observe(project(waitingWorld())));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: "waiting", session: { key: `cloud:${ORG}:ws-1:s1` }, tab: { tabId: "s1-tab" } });
  });

  it("does not raise again when a connection then shows the same wait live, or a second connection does", () => {
    const observe = createCloudAttentionTracker(() => 1_000);
    const live = { live: { "ws-1": [session("s1", "Fix login", "waiting")] }, tabs: { "ws-1": [agentTab("s1", "waiting", ["r1"])] }, connected: ["ws-1"] };
    const raised = [
      ...observe(project(waitingWorld())),
      ...observe(project(waitingWorld(live))),
      // The connection closes: the list takes over again, then another connection opens.
      ...observe(project(waitingWorld({ tabs: { "ws-1": [agentTab("s1", "waiting", ["r1"], false)] } }))),
      ...observe(project(waitingWorld(live))),
    ];
    expect(raised).toHaveLength(1);
  });

  it("does not raise a request again after a brief gap, and raises a new one", () => {
    let now = 1_000;
    const observe = createCloudAttentionTracker(() => now);
    const connected = (status: AgentTabInfo["status"], requests: string[]) =>
      waitingWorld({ live: { "ws-1": [session("s1", "Fix login", status)] }, tabs: { "ws-1": [agentTab("s1", status, requests)] }, connected: ["ws-1"] });
    expect(observe(project(connected("waiting", ["r1"])))).toHaveLength(1);
    now += 1_000;
    expect(observe(project(connected("in_progress", [])))).toHaveLength(0);
    now += 1_000;
    // A reconnect shows r1 again: nothing new.
    expect(observe(project(connected("waiting", ["r1"])))).toHaveLength(0);
    now += 1_000;
    expect(observe(project(connected("in_progress", [])))).toHaveLength(0);
    now += 1_000;
    // The agent asks something else: a new wait, like a local tab going back to waiting.
    expect(observe(project(connected("waiting", ["r2"])))).toHaveLength(1);
  });

  it("does not raise what only the saved cache knew at launch, even when the first list agrees", () => {
    const observe = createCloudAttentionTracker(() => 1_000);
    expect(observe(project(waitingWorld({ source: "cache" })))).toHaveLength(0);
    expect(observe(project(waitingWorld({ source: "live" })))).toHaveLength(0);
  });

  it("does not raise a list wait that lags behind a connection which saw it answered", () => {
    let now = 1_000;
    const observe = createCloudAttentionTracker(() => now);
    const answered = waitingWorld({ live: { "ws-1": [session("s1", "Fix login", "in_progress")] }, tabs: { "ws-1": [agentTab("s1", "in_progress")] }, connected: ["ws-1"] });
    expect(observe(project(answered))).toHaveLength(0);
    now = 60_000;
    // Disconnected; the list still reports the wait from before (reportedAt 100 < the last connection).
    expect(observe(project(waitingWorld({ tabs: { "ws-1": [agentTab("s1", "in_progress", [], false)] } })))).toHaveLength(0);
  });

  it("raises a finished turn once, from the live runtime only", () => {
    const observe = createCloudAttentionTracker(() => 1_000);
    const world = (status: AgentTabInfo["status"]) => ({ workspaces: [item("ws-1")], live: { "ws-1": [session("s1", "Task", status)] }, tabs: { "ws-1": [agentTab("s1", status)] }, connected: ["ws-1"] });
    expect(observe(project(world("in_progress")))).toHaveLength(0);
    const done = observe(project(world("completed")));
    expect(done).toEqual([expect.objectContaining({ kind: "done" })]);
    expect(observe(project(world("completed")))).toHaveLength(0);
  });
});

describe("the palette finds cloud sessions", () => {
  const sessions = projectCloudSessions(
    input({
      orgs: [{ id: ORG, name: "Acme" }, { id: "org-b", name: "Beta" }],
      workspaces: [item("ws-1", { launch: { launchId: "l", phase: "running", state: "started", workBranch: "terminalx/fix-login-3f2a", agent: "claude", sessionId: "s1", tabId: "s1-tab", timings: {} } }), item("ws-b", { repositories: [{ ...acmeApi, identity: "github.com/beta/site", fullName: "beta/site", cloneUrl: "https://github.com/beta/site.git" }] }, "org-b")],
      cached: { "ws-1": [session("s1", "Fix login redirect")], "ws-b": [session("sb", "Landing page copy", "idle", { branch: "feature/landing" })] },
    }),
  );
  const index = withCloudSessions({ sessions: [], workspaces: [], projects: [] }, buildCloudPaletteSessions(sessions, [{ id: "claude", name: "Claude", available: true } as HarnessInfo]));
  const found = (query: string) => searchPaletteIndex(index, query).sessions.map((match) => match.item.cloudKey);

  it("by title, repository or project, and branch, across organizations", () => {
    expect(found("login redirect")).toEqual([`cloud:${ORG}:ws-1:s1`]);
    expect(found("acme/api")).toEqual([`cloud:${ORG}:ws-1:s1`]);
    expect(found("github.com/beta/site")).toEqual(["cloud:org-b:ws-b:sb"]);
    expect(found("feature/landing")).toEqual(["cloud:org-b:ws-b:sb"]);
    expect(found("fix-login-3f2a")).toEqual([`cloud:${ORG}:ws-1:s1`]);
  });

  it("says where it runs, and leaves a local-only index as it was", () => {
    const entry = index.sessions.find((item) => item.cloudKey === "cloud:org-b:ws-b:sb")!;
    expect(entry.secondary).toBe("beta/site · feature/landing · Beta cloud · Claude");
    const local = { sessions: [], workspaces: [], projects: [] };
    expect(withCloudSessions(local, [])).toBe(local);
  });
});
