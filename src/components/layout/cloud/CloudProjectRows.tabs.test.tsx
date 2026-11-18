import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import type { CloudDashboardSession, CloudDashboardTab } from "@/lib/cloudDashboard";
import { buildCloudSessions, type CloudSessionRow } from "@/lib/cloudSessions";
import { getSessionStore, openWelcome } from "@/lib/sessions";
import { getTerminalState } from "@/lib/terminal";
import { TAB_STATUS_LABEL, type TabStatus } from "@/types/session";
import { cloudSessionKey, type CloudProject } from "@/types/target";
import { threeAgentSession, threeAgentTab, threeAgentWorkspace } from "./cloudSessionFixtures.test-utils";
import { CloudProjectGroup, WorkspaceRows } from "./CloudProjectRows";

// #1172: every agent tab of a cloud session is listed under the session's row.

const prepared = vi.hoisted(() => ({ rows: [] as CloudSessionRow[], dashboard: [] as CloudDashboardSession[] }));
vi.mock("@/lib/featureFlags", () => ({ featureFlags: { teamRoster: "team.roster.v1" }, useFeatureFlag: () => false }));
vi.mock("@/lib/organizationRoster", async (original) => ({
  ...await original<typeof import("@/lib/organizationRoster")>(),
  readOrganizationRoster: vi.fn(async () => undefined),
  useOrganizationRoster: () => ({ roster: null, error: null }),
}));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: { state: "signed-out" } }), getAccount: () => ({ status: { state: "signed-out" } }), subscribeAccount: () => () => undefined }));
vi.mock("@/lib/cloudSessions", async (original) => ({ ...await original<typeof import("@/lib/cloudSessions")>(), useCloudAgentRan: () => false, useCloudWorkspaceSessions: (node: { item: CloudWorkspaceListItem }) => ({ sessions: node.item.workspace.id === "one" ? prepared.rows : [], capabilities: null, manage: false, known: true }) }));
vi.mock("@/lib/cloudDashboard", async (original) => ({ ...await original<typeof import("@/lib/cloudDashboard")>(), useCloudDashboard: () => prepared.dashboard }));
vi.mock("@/lib/sidebarFilter", () => ({ useSidebarFilter: () => ({ active: false }) }));
vi.mock("@/components/issues/IssuePipelineSettingsDialog", () => ({ CloudIssuePipelineSettingsDialog: () => null }));

const key = cloudSessionKey("workspace-org", "one", "agents");

function node(item: CloudWorkspaceListItem) {
  return { key: "cloud:workspace-org:one" as const, item, placedBy: "server" as const };
}

/** A project holding workspace `one` (its sessions drawn flat under the project) and an unopened workspace `two`. */
function project(item: CloudWorkspaceListItem): CloudProject {
  const two = { workspace: { ...item.workspace, id: "two", name: "Two" }, latestOperation: null } as CloudWorkspaceListItem;
  return { key: "cloud:workspace-org:github.com/acme/api", orgId: "workspace-org", identity: "github.com/acme/api", fullName: "acme/api", selected: true, pinned: false, blank: false, workspaces: [node(item), { key: "cloud:workspace-org:two", item: two, placedBy: "server" }] };
}

function renderNamed(item: CloudWorkspaceListItem) {
  return render(<ul><WorkspaceRows node={node(item)} named open onLifecycle={() => undefined} /></ul>);
}

function sessionRow() {
  return screen.getByTestId("cloud-session-row");
}

/** What the session row says of its status to assistive technology. */
function sessionStatusText() {
  return sessionRow().querySelector("span[hidden]")?.textContent ?? "";
}

/** Each tab row as [tab id, label, status label]. */
function tabRows() {
  return screen.getAllByTestId("cloud-session-tab-row").map((row) => [
    row.getAttribute("data-tab"),
    row.getAttribute("aria-label"),
    within(row).getByRole("img", { hidden: true }).getAttribute("aria-label"),
  ]);
}

function dashboardSession(tabs: [string, TabStatus][]): CloudDashboardSession {
  return {
    key, id: key, kind: "cloud", orgId: "workspace-org", orgName: "Org", workspaceId: "one", workspaceName: "One", sessionId: "agents",
    tabs: tabs.map(([tabId, status]) => ({ tabId, status, title: null, requestIds: [], waitingOn: null, from: "live" }) as unknown as CloudDashboardTab),
  } as unknown as CloudDashboardSession;
}

afterEach(() => {
  prepared.rows = [];
  prepared.dashboard = [];
  openWelcome();
  cleanup();
});

describe("a cloud session's agent tabs under its sidebar row", () => {
  it("lists the live session's three tabs in tab order, each with its label and status, under a row saying the most urgent", () => {
    const item = threeAgentWorkspace();
    prepared.rows = buildCloudSessions({ item, live: [threeAgentSession()] });
    renderNamed(item);
    const tabs = screen.getByTestId("cloud-session-tabs");
    expect(sessionRow().closest("li")?.contains(tabs)).toBe(true);
    expect(tabs.getAttribute("role")).toBe("tree");
    expect(tabRows()).toEqual([
      ["tab-codex", "Fix the flaky build", TAB_STATUS_LABEL.in_progress],
      ["tab-claude", "Review the fix", TAB_STATUS_LABEL.completed],
      ["tab-codex-2", "Codex", TAB_STATUS_LABEL.idle],
    ]);
    // Working outranks an unread reply and idle.
    expect(sessionStatusText()).toMatch(/^Working\. /);
  });

  it("opens the chosen tab: the session is selected and that tab is asked for", () => {
    const item = threeAgentWorkspace();
    prepared.rows = buildCloudSessions({ item, live: [threeAgentSession()] });
    renderNamed(item);
    // Nothing is selected yet, so no tab row is drawn as selected.
    expect(screen.getAllByTestId("cloud-session-tab-row").map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "false", "false"]);
    fireEvent.click(screen.getAllByTestId("cloud-session-tab-row")[1]);
    expect(getSessionStore().selectedSessionId).toBe(key);
    expect(getTerminalState().selected[key]).toEqual({ kind: "agent", id: "tab-claude" });
    expect(screen.getAllByTestId("cloud-session-tab-row").map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  });

  it("draws no tab rows for a session with one tab", () => {
    const item = threeAgentWorkspace();
    const one = threeAgentSession();
    one.tabs = one.tabs.slice(0, 1);
    one.activeTab = one.tabs[0].id;
    prepared.rows = buildCloudSessions({ item, live: [one] });
    renderNamed(item);
    expect(sessionRow()).toBeTruthy();
    expect(screen.queryByTestId("cloud-session-tabs")).toBeNull();
    expect(screen.queryByTestId("cloud-session-tab-row")).toBeNull();
  });

  it("lists the cached tabs of a stopped workspace, none of them working", () => {
    const item = threeAgentWorkspace({ state: "suspended" });
    prepared.rows = buildCloudSessions({ item, cached: { sessions: [threeAgentSession()], capabilities: [], at: 1 } });
    renderNamed(item);
    const rows = tabRows();
    expect(rows.map(([tab]) => tab)).toEqual(["tab-codex", "tab-claude", "tab-codex-2"]);
    expect(rows[0][2]).toBe(TAB_STATUS_LABEL.idle);
    expect(rows.map(([, , status]) => status)).not.toContain(TAB_STATUS_LABEL.in_progress);
    expect(sessionStatusText()).toMatch(/^No changes\. /);
  });

  it("reads waiting on the tab with a pending permission and on the session row", () => {
    const item = threeAgentWorkspace();
    prepared.rows = buildCloudSessions({ item, live: [threeAgentSession()], agentTabs: [threeAgentTab("tab-claude", "claude", "idle", 1)] });
    renderNamed(item);
    expect(tabRows()[1]).toEqual(["tab-claude", "Review the fix", TAB_STATUS_LABEL.waiting]);
    expect(sessionStatusText()).toMatch(/^Needs you\. /);
  });

  it("lists no tabs for a workspace not shared with this person", () => {
    const item = threeAgentWorkspace({ you: { role: "none" }, launch: { sessionId: "agents" } });
    prepared.rows = buildCloudSessions({ item, live: [threeAgentSession()] });
    renderNamed(item);
    expect(screen.getAllByTestId("cloud-session-row")).toHaveLength(1);
    expect(screen.queryByTestId("cloud-session-tab-row")).toBeNull();
  });

  it("lists the tabs both flat under a project and under a named workspace row", () => {
    const item = threeAgentWorkspace();
    prepared.rows = buildCloudSessions({ item, live: [threeAgentSession()] });
    const flat = render(<CloudProjectGroup project={project(item)} onLifecycle={() => undefined} />);
    const row = sessionRow();
    expect(row.closest('[data-testid="cloud-workspace-group"]')).toBeNull();
    expect(row.closest('[data-testid="cloud-project-sessions"]')).toBeTruthy();
    expect(within(row.closest("li")!).getAllByTestId("cloud-session-tab-row")).toHaveLength(3);
    flat.unmount();

    renderNamed(item);
    const group = screen.getByTestId("cloud-workspace-group");
    expect(within(group).getByTestId("cloud-session-row").getAttribute("data-session")).toBe(key);
    expect(within(group).getAllByTestId("cloud-session-tab-row")).toHaveLength(3);
  });

  it("takes the Dashboard's tab statuses when the Dashboard lists the session", () => {
    const item = threeAgentWorkspace();
    prepared.rows = buildCloudSessions({ item, live: [threeAgentSession()] });
    prepared.dashboard = [dashboardSession([["tab-codex", "idle"], ["tab-claude", "waiting"], ["tab-codex-2", "in_progress"]])];
    renderNamed(item);
    expect(tabRows().map(([, , status]) => status)).toEqual([TAB_STATUS_LABEL.idle, TAB_STATUS_LABEL.waiting, TAB_STATUS_LABEL.in_progress]);
  });
});
