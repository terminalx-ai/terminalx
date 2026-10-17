import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// PRO-23 row states the local re-check of 2026-10-17 found missing: a session
// of a workspace this desktop is not attached to shows what the server's list
// (and so the Dashboard) says, a stopped workspace says Stopped, and a
// workspace never opened here offers "Open to load sessions" even when this
// account can list its checkpoints. Looking never connects or wakes anything.

const mocks = vi.hoisted(() => ({
  api: {
    cloudWorkspaces: vi.fn(),
    cloudWorkspaceRepositories: vi.fn(),
    cloudWorkspaceResume: vi.fn(),
    cloudWorkspaceUnarchive: vi.fn(),
    cloudWorkspaceOperation: vi.fn(),
    cloudWorkspaceDelete: vi.fn(),
    cloudRemoteAttach: vi.fn(),
    cloudRemoteActivate: vi.fn(),
    cloudAgentPurgeWorkspace: vi.fn(),
    cloudCatalogLoad: vi.fn(),
    cloudCatalogSave: vi.fn(),
    organizationSelect: vi.fn(),
  },
  invoke: vi.fn(),
  workspaceConnection: vi.fn(),
  ask: vi.fn(),
  refreshAccount: vi.fn(),
  status: null as unknown as AccountStatus,
  lifecycle: [] as { initial: string; item: CloudWorkspaceListItem }[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
  workspaceConnection: mocks.workspaceConnection,
  closeWorkspaceConnection: vi.fn(),
}));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: mocks.refreshAccount,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask }));
// The dialog has its own tests (CloudWorkspaceLifecycle.test.tsx); here only what the sidebar hands it.
vi.mock("@/components/cloud/CloudWorkspaceLifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/cloud/CloudWorkspaceLifecycle")>()),
  CloudWorkspaceLifecycleDialog: (props: { initial: string; item: CloudWorkspaceListItem }) => {
    mocks.lifecycle.push(props);
    return <div data-testid="lifecycle-dialog">{props.initial}</div>;
  },
}));
const openNewWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/components/cloud/NewCloudWorkspaceDialog", () => ({ openNewCloudWorkspace: openNewWorkspace }));

const { CloudOrganizations } = await import("./CloudOrganizations");
const catalog = await import("@/lib/cloudCatalog");
const sessions = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const { resetCloudSessions } = await import("@/lib/cloudSessions");
const { getCloudDashboard, resetCloudDashboard } = await import("@/lib/cloudDashboard");
const { resetCloudAgents } = await import("@/lib/cloudAgents");
const { buildCloudPaletteSessions, searchPaletteIndex, withCloudSessions, buildPaletteIndex } = await import("@/lib/commandPalette");

const ORG = "org-a";
const OTHER = "org-b";
const ME = "a@example.com";
const API = "github.com/acme/api";
const acmeApi = { identity: API, fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };

function item(id: string, fields: Record<string, unknown> = {}, orgId = ORG): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId, name: id, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, ...fields },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}
const tab = (id: string, status: string) => ({ id: `${id}-tab`, harness: "claude", title: null, model: "opus", permissionMode: "default", status, created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" });
const session = (id: string, title: string, fields: Record<string, unknown> = {}) => ({
  id, projectPath: "/workspace", cwd: "/workspace", title, created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T11:00:00.000Z", archived: false, pinned: false, tabs: [tab(id, "idle")], ...fields,
});

function signIn(email = ME) {
  mocks.status = {
    state: "signed-in",
    identity: { name: "A", email, organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    multiOrg: true,
    organizations: [
      { id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: OTHER, name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ],
  } as AccountStatus;
}

/** The catalog as a relaunch reads it: rows and each workspace's cached sessions. */
async function load(workspaces: CloudWorkspaceListItem[], cached: Record<string, { sessions: unknown[]; capabilities: string[] | null }> = {}) {
  await act(async () => {
    await catalog.ingestCloudList({ workspaces } as never, ORG);
    for (const [workspaceId, entry] of Object.entries(cached)) catalog.cacheCloudSessions(ORG, workspaceId, entry.sessions as never, entry.capabilities);
  });
}

const mount = () => render(<TooltipProvider><CloudOrganizations /></TooltipProvider>);
const sessionRow = (key: string) => screen.getAllByTestId("cloud-session-row").find((row) => row.getAttribute("data-session") === key)!;
const rowState = (name: string) => within(screen.getByRole("group", { name })).queryByTestId("cloud-workspace-row-state")?.textContent ?? null;

function expectNoAttachOrResume() {
  expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
  expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
}

/** What Search finds for the workspace's name, as the command palette builds it from the Dashboard's projection. */
const paletteCloudKeys = (query: string) =>
  searchPaletteIndex(withCloudSessions(buildPaletteIndex([], [], {}, []), buildCloudPaletteSessions(getCloudDashboard(), [])), query).sessions.map((match) => match.item.cloudKey);

let checkpoints: { tabId: string }[] = [];

beforeEach(() => {
  signIn();
  checkpoints = [];
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.workspaceConnection.mockReset();
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  mocks.api.cloudWorkspaceRepositories.mockResolvedValue({ configured: true, repositories: [] });
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "cloud_agent_cache_load") return { tabs: {} };
    if (command === "cloud_agent_checkpoints") return checkpoints;
    if (command === "cloud_agent_outbox") return [];
    return undefined;
  });
  prefs.setPrefs({ organizationDisplay: "all", hiddenOrganizations: [], selectedOrganization: null, cloudSections: {}, sidebarSections: {}, cloudPinned: {}, cloudProjects: {}, cloudBlankProjects: {} });
  act(() => sessions.selectSession(null));
});

afterEach(async () => {
  cleanup();
  catalog.resetCloudCatalog();
  resetCloudSessions();
  resetCloudAgents();
  await resetCloudDashboard();
});

const online = (activeTurns: number, pendingApprovals = 0) => ({ runtimeActivity: { online: true, reportedAt: Date.now(), activeTurns, pendingApprovals } });

describe("row states from the server's list", () => {
  it("a session of a workspace this desktop is not attached to shows Working while the list says a turn runs, as the Dashboard does", async () => {
    await load([item("second", { repositories: [acmeApi], ...online(1) })], { second: { sessions: [session("s1", "Echo hello")], capabilities: ["session/1", "session/2"] } });
    mount();
    const key = `cloud:${ORG}:second:s1`;
    await waitFor(() => expect(within(sessionRow(key)).getByTestId("working-mark")).toBeTruthy());
    expect(getCloudDashboard().find((entry) => entry.key === key)?.tabs[0].status).toBe("in_progress");
    expectNoAttachOrResume();
  });

  it("and Needs you while the list says it waits on an approval", async () => {
    await load([item("second", { repositories: [acmeApi], ...online(0, 1) })], { second: { sessions: [session("s1", "Echo hello")], capabilities: ["session/1"] } });
    mount();
    await waitFor(() => expect(within(sessionRow(`cloud:${ORG}:second:s1`)).getByRole("img", { name: "Needs you" })).toBeTruthy());
  });

  it("a cached working tab is not believed without a live connection or the list's word", async () => {
    await load([item("second", { repositories: [acmeApi], ...online(0) })], { second: { sessions: [session("s1", "Echo hello", { tabs: [tab("s1", "in_progress")] })], capabilities: ["session/1"] } });
    mount();
    await screen.findAllByTestId("cloud-session-row");
    expect(within(sessionRow(`cloud:${ORG}:second:s1`)).queryByTestId("working-mark")).toBeNull();
  });

  it("a stopped workspace says Stopped, and its sessions are never Working, whatever the list last said", async () => {
    await load([item("perf", { state: "suspended", repositories: [acmeApi], ...online(1) })], { perf: { sessions: [session("s1", "Echo hello")], capabilities: ["session/1"] } });
    mount();
    await screen.findAllByTestId("cloud-session-row");
    expect(rowState("acme/api")).toContain("Stopped");
    expect(within(sessionRow(`cloud:${ORG}:perf:s1`)).queryByTestId("working-mark")).toBeNull();
  });

  it("with several workspaces, each names its own state: Stopped on the stopped one", async () => {
    await load([item("fix", { repositories: [acmeApi], lastActivityAt: 50, ...online(1) }), item("perf", { state: "suspended", repositories: [acmeApi], lastActivityAt: 40 })], {
      fix: { sessions: [session("s1", "Fix")], capabilities: ["session/1"] },
      perf: { sessions: [session("s2", "Perf")], capabilities: ["session/1"] },
    });
    mount();
    await screen.findAllByTestId("cloud-session-row");
    const states = screen.getAllByTestId("cloud-workspace-group").map((group) => [group.getAttribute("data-workspace"), within(group).getByTestId("cloud-workspace-row-state").textContent]);
    expect(states).toEqual([["fix", "1"], ["perf", "Stopped"]]);
    expect(within(sessionRow(`cloud:${ORG}:fix:s1`)).getByTestId("working-mark")).toBeTruthy();
  });
});

describe("a failed first prompt on a project's only workspace (#513)", () => {
  const failed = { repositories: [acmeApi], launch: { phase: "failed", state: "failed", category: "agent-sign-in-required" } };

  it("needs attention while no agent has run there", async () => {
    await load([item("solo", failed)], { solo: { sessions: [], capabilities: ["session/1"] } });
    mount();
    await waitFor(() => expect(rowState("acme/api")).toContain("Needs attention"));
  });

  it("stops needing attention once a session with a tab is known, as the workspace view does (#499)", async () => {
    await load([item("solo", failed)], { solo: { sessions: [session("s1", "Echo hello")], capabilities: ["session/1"] } });
    mount();
    await screen.findAllByTestId("cloud-session-row");
    expect(rowState("acme/api") ?? "").not.toContain("Needs attention");
    expectNoAttachOrResume();
  });
});

describe("a workspace never opened on this desktop", () => {
  // An admin can list the workspace's checkpoints (a member cannot): those name tabs, not sessions.
  it("offers Open to load sessions even when its checkpoints are listed, and opening it reaches the session from the sidebar, the Dashboard and Search", async () => {
    checkpoints = [{ tabId: "t1" }];
    await load([item("alpha", { repositories: [acmeApi], authority: "manage", you: { role: "manager", canApprove: true, canManageShares: true } })]);
    mount();
    const open = await screen.findByRole("button", { name: "Open to load sessions" });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_agent_checkpoints", expect.anything()));
    // Still offered once the checkpoint placeholders are in.
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Open to load sessions" })).toBeTruthy();
    expect(screen.queryByText("No sessions yet.")).toBeNull();
    fireEvent.click(open);
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe(`cloud:${ORG}:alpha`);
    expectNoAttachOrResume();
    // The workspace view's connection reads the runtime's list, which is kept with the catalog.
    act(() => catalog.cacheCloudSessions(ORG, "alpha", [session("s1", "Echo hello from alpha")] as never, ["session/1", "session/2"]));
    const key = `cloud:${ORG}:alpha:s1`;
    await waitFor(() => expect(sessionRow(key)).toBeTruthy());
    expect(getCloudDashboard().map((entry) => entry.key)).toContain(key);
    expect(paletteCloudKeys("alpha")).toContain(key);
  });
});
