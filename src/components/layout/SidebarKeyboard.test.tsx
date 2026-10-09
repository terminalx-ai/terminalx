import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import type { Project, SessionEntry, Workspace } from "@/types/session";

// PRO-23 CS-19: the sidebar tree by keyboard across Local and every
// organization section. Arrow keys, Home and End move focus through section
// headers, cloud projects, sessions and tabs as they do through local rows;
// Left and Right collapse and expand; Enter and Space open. Moving never
// connects or wakes anything.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  status: null as unknown as AccountStatus,
  resume: vi.fn(),
  workspaceConnection: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set() }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: { ...original.api, cloudWorkspaceResume: mocks.resume, cloudCatalogLoad: vi.fn(), cloudCatalogSave: vi.fn(), cloudAgentPurgeWorkspace: vi.fn() },
    workspaceConnection: mocks.workspaceConnection,
    closeWorkspaceConnection: vi.fn(),
  };
});
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
  bootAccount: vi.fn(),
}));
vi.mock("@/lib/cloudConnections", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cloudConnections")>();
  return { ...original, wakeCloudConnection: vi.fn(original.wakeCloudConnection), retainCloudConnection: vi.fn(original.retainCloudConnection) };
});

const { ProjectRail } = await import("./ProjectRail");
const prefs = await import("@/lib/prefs");
const sessions = await import("@/lib/sessions");
const catalog = await import("@/lib/cloudCatalog");
const connections = await import("@/lib/cloudConnections");
const { resetCloudAgents } = await import("@/lib/cloudAgents");
const { resetCloudSessions } = await import("@/lib/cloudSessions");

const ORG = "org-a";
const projectPath = "/repos/raccoon";
const workspace: Workspace = {
  path: projectPath, name: "raccoon", branch: "main", head: "abc1234", isMain: true, managed: false,
  uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0,
};
const projects: Project[] = [{ path: projectPath, name: "Raccoon" }];
const localSessions: SessionEntry[] = [];

const acmeApi = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };
const cloudItem = {
  workspace: { id: "ws-1", orgId: ORG, name: "fix-login", provider: "box", state: "suspended", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, repositories: [acmeApi] },
  latestOperation: null,
} as unknown as CloudWorkspaceListItem;
const cloudSession = {
  id: "s1", projectPath: "/workspace", cwd: "/workspace", title: "Fix login redirect", created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T11:00:00.000Z", archived: false, pinned: false,
  tabs: [{ id: "t1", harness: "claude", title: null, model: "opus", permissionMode: "default", status: "idle", created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" }],
};

beforeAll(async () => {
  mocks.status = {
    state: "signed-in",
    identity: { name: "Ada", email: "ada@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "scope", revision: "scope:1" },
    multiOrg: true,
    organizations: [
      { id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: "org-b", name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ],
  } as AccountStatus;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects, lastSelected: projectPath };
    if (command === "list_sessions") return localSessions;
    if (command === "list_harnesses") return [{ id: "claude", name: "Claude", available: true }];
    if (command === "list_workspaces") return [workspace];
    if (command === "list_automations") return [];
    if (command === "cloud_agent_cache_load") return { tabs: {} };
    if (command === "cloud_agent_outbox" || command === "cloud_agent_checkpoints") return [];
    return null;
  });
  await act(async () => {
    await sessions.bootSessions();
    await sessions.refreshEverything();
  });
});

beforeEach(async () => {
  prefs.setPrefs({ cloudProjects: {}, cloudBlankProjects: {}, cloudPinned: {}, cloudCollapsed: {}, sidebarSections: {}, hiddenOrganizations: [], organizationDisplay: "all", selectedOrganization: null });
  await act(async () => {
    await catalog.ingestCloudList({ workspaces: [cloudItem], quota: { used: 1, limit: 2 } }, ORG);
    await catalog.ingestCloudList({ workspaces: [], quota: { used: 0, limit: 2 } }, "org-b");
  });
  catalog.cacheCloudSessions(ORG, "ws-1", [cloudSession] as never, ["session/2"]);
  act(() => sessions.selectSession(null));
  for (const fn of [mocks.resume, mocks.workspaceConnection, connections.wakeCloudConnection, connections.retainCloudConnection]) vi.mocked(fn).mockClear();
});

afterEach(() => {
  cleanup();
  catalog.resetCloudCatalog();
  resetCloudAgents();
  resetCloudSessions();
});
afterAll(() => act(() => prefs.setPrefs({ sidebarSections: {} })));

const noop = () => {};
function mount() {
  render(
    <TooltipProvider>
      <ProjectRail onOpenSettings={noop} onOpenAccount={noop} onOpenIssues={noop} onOpenAgents={noop} onOpenStats={noop} onOpenAutomations={noop} onOpenSkills={noop} onSearch={noop} />
    </TooltipProvider>,
  );
  return screen.getByTestId("sidebar-tree");
}

/** Press a key where focus is, as the tree sees it. */
function press(key: string) {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  fireEvent.keyDown(target, { key });
}

/** The tree item that holds focus now. */
const focusedItem = () => (document.activeElement as HTMLElement).closest('[role="treeitem"]')?.getAttribute("aria-label");

function expectNoWake() {
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
  expect(connections.retainCloudConnection).not.toHaveBeenCalled();
}

describe("tree keyboard across Local and organization sections", () => {
  it("lets the One-mode header switcher own ArrowDown and choose an organization", async () => {
    prefs.setPrefs({ organizationDisplay: "one", selectedOrganization: ORG });
    mount();
    const picker = screen.getByRole("button", { name: "Choose organization in sidebar" });
    picker.focus();
    press("ArrowDown");
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Beta" }));
    expect(screen.getAllByTestId("cloud-org-section").map((section) => section.getAttribute("data-org"))).toEqual(["org-b"]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Choose organization in sidebar" })));
    expectNoWake();
  });

  it("skips hidden sections without gaps, reaches the hidden-organizations link, and keeps Local when all are hidden", () => {
    prefs.setPrefs({ hiddenOrganizations: ["org-b"] });
    const tree = mount();
    within(tree).getByRole("button", { name: "Local" }).focus();
    press("End");
    expect(focusedItem()).toBe("1 organization hidden");
    press("ArrowUp");
    expect(focusedItem()).toBe("Fix login redirect");
    press("ArrowDown");
    expect(focusedItem()).toBe("1 organization hidden");
    expect(within(tree).queryByRole("treeitem", { name: "Beta organization" })).toBeNull();
    act(() => prefs.setPrefs({ hiddenOrganizations: [ORG, "org-b"] }));
    within(tree).getByRole("button", { name: "Local" }).focus();
    press("End");
    expect(focusedItem()).toBe("2 organizations hidden");
    press("Home");
    expect(focusedItem()).toBe("Local section");
    expectNoWake();
  });

  it("puts the Local header in the tree as a section, with its projects under it", () => {
    const tree = mount();
    const local = within(tree).getByRole("treeitem", { name: "Local section" });
    expect(local.getAttribute("aria-expanded")).toBe("true");
    expect(within(local).getByRole("treeitem", { name: "Raccoon" })).toBeTruthy();
    expect(within(tree).getByRole("treeitem", { name: "Acme organization" })).toBeTruthy();
  });

  it("Home and End reach the first and last section; the arrows move from Local into the organizations", () => {
    const tree = mount();
    fireEvent.click(within(tree).getByRole("button", { name: "Collapse Raccoon" }));
    within(tree).getByRole("button", { name: "Local" }).focus();
    press("End");
    expect(focusedItem()).toBe("Beta organization");
    press("Home");
    expect(focusedItem()).toBe("Local section");
    press("ArrowDown");
    expect(focusedItem()).toBe("Raccoon");
    press("ArrowDown");
    expect(focusedItem()).toBe("Acme organization");
    press("ArrowDown");
    expect(focusedItem()).toBe("acme/api");
    press("ArrowDown");
    expect(focusedItem()).toBe("Fix login redirect");
    press("ArrowUp");
    expect(focusedItem()).toBe("acme/api");
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowUp");
    expect(focusedItem()).toBe("Local section");
    expectNoWake();
  });

  it("Right and Left expand and collapse cloud rows and sections, and walk to a child or the parent, like local rows", () => {
    const tree = mount();
    within(tree).getByRole("button", { name: "Fix login redirect" }).focus();
    const session = within(tree).getByRole("treeitem", { name: "Fix login redirect" });
    expect(session.getAttribute("aria-expanded")).toBe("false");
    press("ArrowRight");
    expect(session.getAttribute("aria-expanded")).toBe("true");
    press("ArrowRight");
    expect(focusedItem()).toBe("Claude Code");
    press("ArrowLeft");
    expect(focusedItem()).toBe("Fix login redirect");
    press("ArrowLeft");
    expect(session.getAttribute("aria-expanded")).toBe("false");
    press("ArrowLeft");
    expect(focusedItem()).toBe("acme/api");
    press("ArrowLeft");
    expect(within(tree).getByRole("treeitem", { name: "acme/api" }).getAttribute("aria-expanded")).toBe("false");
    press("ArrowLeft");
    expect(focusedItem()).toBe("Acme organization");
    press("ArrowLeft");
    expect(within(tree).getByRole("treeitem", { name: "Acme organization" }).getAttribute("aria-expanded")).toBe("false");
    press("ArrowRight");
    expect(within(tree).getByRole("treeitem", { name: "Acme organization" }).getAttribute("aria-expanded")).toBe("true");

    // The Local section collapses and expands the same way.
    press("Home");
    const local = within(tree).getByRole("treeitem", { name: "Local section" });
    press("ArrowLeft");
    expect(local.getAttribute("aria-expanded")).toBe("false");
    expect(within(tree).queryByRole("treeitem", { name: "Raccoon" })).toBeNull();
    press("ArrowRight");
    expect(local.getAttribute("aria-expanded")).toBe("true");
    expect(within(tree).getByRole("treeitem", { name: "Raccoon" })).toBeTruthy();
    expectNoWake();
  });

  it("Enter and Space on a cloud tab open its session, and never wake the stopped workspace", () => {
    const tree = mount();
    within(tree).getByRole("button", { name: "Fix login redirect" }).focus();
    press("ArrowRight");
    press("ArrowDown");
    expect(focusedItem()).toBe("Claude Code");
    press("Enter");
    expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:ws-1:s1`);
    act(() => sessions.selectSession(null));
    press(" ");
    expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:ws-1:s1`);
    expectNoWake();
  });
});
