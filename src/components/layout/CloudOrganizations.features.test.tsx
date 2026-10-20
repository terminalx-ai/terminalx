import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// PRO-23 in the chat-first sidebar: what the old cloud tree offered, reached
// again from the organization sections. Personal named sections, the Unread /
// Needs you filter, the workspace lifecycle menus (project, workspace,
// archived, organization), the session menu, and the loading, failed and
// offline lines with Retry. Looking and arranging never connect to or wake a
// workspace; only Resume (or Unarchive) chosen from a menu does.

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
// The workspace view's terminals and tabs have their own tests (CloudWorkspaceView.test.tsx).
vi.mock("@/components/cloud/CloudWorkspaceView", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/cloud/CloudWorkspaceView")>()),
  WorkspaceView: () => <div data-testid="workspace-view" />,
}));
const openNewWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/components/cloud/NewCloudWorkspaceDialog", () => ({ openNewCloudWorkspace: openNewWorkspace }));

const { CloudOrganizations } = await import("./CloudOrganizations");
const { CloudWorkspaceMain } = await import("@/components/cloud/CloudWorkspaceMain");
const catalog = await import("@/lib/cloudCatalog");
const sessions = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const { setSidebarFilter } = await import("@/lib/sidebarFilter");
const { resetCloudSessions } = await import("@/lib/cloudSessions");
const { resetCloudDashboard } = await import("@/lib/cloudDashboard");

const ORG = "org-a";
const OTHER = "org-b";
const ME = "a@example.com";
const API = "github.com/acme/api";
const WEB = "github.com/acme/web";
const acmeApi = { identity: API, fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };
const acmeWeb = { identity: WEB, fullName: "acme/web", cloneUrl: "https://github.com/acme/web.git", primary: true };
const pending = { online: true, reportedAt: Date.now(), activeTurns: 0, pendingApprovals: 1 };

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

const standard = () =>
  load(
    [
      item("fix-login", { repositories: [acmeApi], lastActivityAt: 50 }),
      item("perf-sweep", { state: "suspended", repositories: [acmeApi], lastActivityAt: 40 }),
      item("site", { repositories: [acmeWeb] }),
      item("old", { state: "archived", archivedAt: 1, deleteAfter: Date.now() + 12 * 86_400_000, repositories: [acmeApi] }),
    ],
    {
      "fix-login": { sessions: [session("s1", "Fix login redirect")], capabilities: ["session/1", "session/2"] },
      site: { sessions: [session("s2", "Landing copy")], capabilities: ["session/1"] },
    },
  );

const onOpenOrganizations = vi.fn();
const mount = () => render(<TooltipProvider><CloudOrganizations onOpenOrganizations={onOpenOrganizations} /></TooltipProvider>);
const org = (orgId = ORG) => screen.getAllByTestId("cloud-org-list").find((section) => section.getAttribute("data-org") === orgId)!;
const project = (name: string) => screen.getByRole("group", { name });
const sessionRow = (key: string) => screen.getAllByTestId("cloud-session-row").find((row) => row.getAttribute("data-session") === key)!;
const shownSessions = () => screen.queryAllByTestId("cloud-session-row").map((row) => row.getAttribute("data-session"));

/** A real mouse click: pointerdown, mousedown, pointerup, mouseup, click. */
function mouseClick(element: HTMLElement) {
  fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}
async function openMenu(label: string) {
  mouseClick(screen.getByRole("button", { name: label }));
  return (await screen.findAllByRole("menu")).at(-1)!;
}
const items = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim());

function expectNoAttachOrResume() {
  expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
  expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
}

beforeEach(() => {
  signIn();
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.workspaceConnection.mockReset();
  mocks.ask.mockReset().mockResolvedValue(true);
  mocks.refreshAccount.mockReset().mockResolvedValue(undefined);
  mocks.lifecycle.length = 0;
  onOpenOrganizations.mockReset();
  openNewWorkspace.mockReset();
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  mocks.api.cloudWorkspaceRepositories.mockResolvedValue({ configured: true, repositories: [] });
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "cloud_agent_cache_load") return { tabs: {} };
    if (command === "cloud_agent_outbox" || command === "cloud_agent_checkpoints") return [];
    return undefined;
  });
  prefs.setPrefs({ organizationDisplay: "all", hiddenOrganizations: [], selectedOrganization: null, cloudSections: {}, sidebarSections: {}, cloudPinned: {}, cloudProjects: {}, cloudBlankProjects: {} });
  act(() => sessions.selectSession(null));
});

afterEach(async () => {
  cleanup();
  act(() => setSidebarFilter("all"));
  catalog.resetCloudCatalog();
  resetCloudSessions();
  await resetCloudDashboard();
});

describe("personal named sections", () => {
  const mine = () => prefs.getPrefs().cloudSections[ME]?.[ORG] ?? [];
  const sectionNames = () => screen.queryAllByTestId("cloud-section-name").map((name) => name.textContent);
  const section = (name: string) => screen.getByRole("group", { name: `${name} section` });
  const projectsIn = (element: HTMLElement) => within(element).queryAllByTestId("cloud-project-group").map((group) => group.getAttribute("data-project"));
  async function typeName(name: string, key = "Enter") {
    const input = await screen.findByTestId("cloud-section-name-input");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key });
  }
  const moveMenu = async (name: string) => {
    const menu = await openMenu(`Project menu for ${name}`);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move to section" }));
    return (await screen.findAllByRole("menu")).at(-1)!;
  };

  it("creates a section from the organization's menu with its name field focused, kept for this account and organization", async () => {
    await standard();
    mount();
    fireEvent.click(within(await openMenu("Menu for Acme")).getByRole("menuitem", { name: "New section" }));
    await typeName("Active");
    expect(sectionNames()).toEqual(["Active"]);
    expect(mine()).toEqual([{ id: expect.any(String), name: "Active", projects: [] }]);
    expect(within(section("Active")).getByTestId("cloud-section-empty").textContent).toContain("Move a project here");
    expectNoAttachOrResume();
  });

  it("moves projects into sections from a project's menu and back, sections first", async () => {
    await standard();
    mount();
    fireEvent.click(within(await moveMenu("acme/api")).getByRole("menuitem", { name: "New section…" }));
    await typeName("Active");
    fireEvent.click(within(await openMenu("Menu for Acme")).getByRole("menuitem", { name: "New section" }));
    await typeName("Parked");
    expect(projectsIn(section("Active"))).toEqual([`cloud:${ORG}:${API}`]);
    fireEvent.click(within(await moveMenu("acme/api")).getByRole("menuitemradio", { name: "Parked" }));
    await waitFor(() => expect(projectsIn(section("Parked"))).toEqual([`cloud:${ORG}:${API}`]));
    expect(projectsIn(section("Active"))).toEqual([]);
    const parked = await moveMenu("acme/api");
    expect(within(parked).getByRole("menuitemradio", { name: "Parked" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(parked).getByRole("menuitem", { name: "Remove from Parked" }));
    await waitFor(() => expect(projectsIn(section("Parked"))).toEqual([]));
    // The sections come first, then the projects in none.
    const order = within(org()).getAllByTestId(/^cloud-(section|project-group)$/).map((element) => element.getAttribute("data-section") ? "section" : element.getAttribute("data-project"));
    expect(order).toEqual(["section", "section", `cloud:${ORG}:${API}`, `cloud:${ORG}:${WEB}`]);
    expectNoAttachOrResume();
  });

  it("renames from the menu, with F2 or a double-click; Escape and a blank name keep the old one", async () => {
    await standard();
    mount();
    fireEvent.click(within(await openMenu("Menu for Acme")).getByRole("menuitem", { name: "New section" }));
    await typeName("Active");
    fireEvent.click(within(await openMenu("Menu for section Active")).getByRole("menuitem", { name: "Rename section" }));
    await typeName("Doing");
    expect(sectionNames()).toEqual(["Doing"]);
    fireEvent.keyDown(screen.getByTestId("cloud-section-row"), { key: "F2" });
    await typeName("Never mind", "Escape");
    expect(sectionNames()).toEqual(["Doing"]);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Doing section" }));
    await typeName("   ");
    expect(sectionNames()).toEqual(["Doing"]);
    expect(mine()[0].name).toBe("Doing");
  });

  it("reorders with Move up and Move down, and deleting one puts its projects back without touching a workspace", async () => {
    await standard();
    prefs.setPrefs({ cloudSections: { [ME]: { [ORG]: [{ id: "s1", name: "One", projects: [API] }, { id: "s2", name: "Two", projects: [] }, { id: "s3", name: "Three", projects: [] }] } } });
    mount();
    let menu = await openMenu("Menu for section One");
    expect(within(menu).getByRole("menuitem", { name: "Move up" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move down" }));
    await waitFor(() => expect(sectionNames()).toEqual(["Two", "One", "Three"]));
    menu = await openMenu("Menu for section Three");
    expect(within(menu).getByRole("menuitem", { name: "Move down" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move up" }));
    await waitFor(() => expect(sectionNames()).toEqual(["Two", "Three", "One"]));
    fireEvent.click(within(await openMenu("Menu for section One")).getByRole("menuitem", { name: "Delete section" }));
    await waitFor(() => expect(sectionNames()).toEqual(["Two", "Three"]));
    expect(within(org()).getAllByTestId("cloud-project-group").map((group) => group.getAttribute("data-project"))).toEqual([`cloud:${ORG}:${API}`, `cloud:${ORG}:${WEB}`]);
    expect(mocks.api.cloudWorkspaceDelete).not.toHaveBeenCalled();
  });

  it("keeps sections and their folds after a relaunch, and shows none to another account", async () => {
    await standard();
    prefs.setPrefs({
      cloudSections: { [ME]: { [ORG]: [{ id: "s1", name: "Parked", projects: [WEB] }, { id: "s2", name: "Active", projects: [API, "github.com/acme/gone"] }] } },
      sidebarSections: { "cloud-section:s1": "collapsed" },
    });
    mount();
    expect(sectionNames()).toEqual(["Parked", "Active"]);
    expect(within(section("Parked")).getByRole("button", { name: "Parked section" }).getAttribute("aria-expanded")).toBe("false");
    // A project a section names that is not listed now is simply not shown.
    expect(projectsIn(section("Active"))).toEqual([`cloud:${ORG}:${API}`]);
    fireEvent.click(within(section("Parked")).getByRole("button", { name: "Parked section" }));
    expect(prefs.getPrefs().sidebarSections["cloud-section:s1"]).toBe("expanded");
    cleanup();

    signIn("b@example.com");
    mount();
    expect(sectionNames()).toEqual([]);
    expect(within(org()).getAllByTestId("cloud-project-group")).toHaveLength(2);
  });
});

describe("the Unread / Needs you filter", () => {
  const seed = () =>
    load(
      [
        item("asks", { repositories: [acmeApi], lastActivityAt: 50, runtimeActivity: pending }),
        item("quiet", { repositories: [acmeApi], lastActivityAt: 40 }),
        item("answered", { state: "suspended", repositories: [acmeWeb] }),
      ],
      {
        asks: { sessions: [session("a1", "Approve the deploy", { tabs: [tab("a1", "waiting")] })], capabilities: ["session/2"] },
        quiet: { sessions: [session("q1", "Nothing new")], capabilities: ["session/2"] },
        answered: { sessions: [session("w1", "Draft the changelog", { tabs: [tab("w1", "completed")] }), session("w2", "Read already")], capabilities: ["session/2"] },
      },
    );
  const filterTo = async (filter: "all" | "unread" | "needs") => {
    await act(async () => {
      setSidebarFilter(filter);
      // The dashboard's projection, which the filter reads, settles a microtask later.
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("Needs you shows only the waiting session, opening its folded project, and wakes nothing", async () => {
    await seed();
    prefs.setPrefs({ sidebarSections: { [`cloud-project:cloud:${ORG}:${API}`]: "collapsed" } });
    mount();
    expect(shownSessions()).toHaveLength(4);
    await filterTo("needs");
    await waitFor(() => expect(shownSessions()).toEqual([`cloud:${ORG}:asks:a1`]));
    expect(within(project("acme/api")).getByRole("button", { name: "Collapse acme/api" }).getAttribute("aria-expanded")).toBe("true");
    // The other project has nothing waiting; the sibling workspace has no row.
    expect(screen.queryByRole("group", { name: "acme/web" })).toBeNull();
    expect(screen.queryAllByTestId("cloud-workspace-group").map((group) => group.getAttribute("data-workspace"))).toEqual(["asks"]);
    expectNoAttachOrResume();
  });

  it("Unread shows the finished answer nobody has read in a stopped workspace, without waking it", async () => {
    await seed();
    mount();
    await filterTo("unread");
    await waitFor(() => expect(shownSessions()).toEqual([`cloud:${ORG}:answered:w1`]));
    expect(screen.queryByRole("group", { name: "acme/api" })).toBeNull();
    expectNoAttachOrResume();
  });

  it("says so when an organization has nothing that passes, and keeps the selected session in view", async () => {
    await seed();
    act(() => sessions.selectCloudSession(`cloud:${ORG}:quiet:q1`));
    mount();
    await filterTo("needs");
    await waitFor(() => expect(shownSessions().sort()).toEqual([`cloud:${ORG}:asks:a1`, `cloud:${ORG}:quiet:q1`].sort()));
    act(() => sessions.selectSession(null));
    await load([item("quiet", { repositories: [acmeApi] })], { quiet: { sessions: [session("q1", "Nothing new")], capabilities: ["session/2"] } });
    await waitFor(() => expect(within(org()).getByTestId("cloud-org-filtered-empty").textContent).toBe("Nothing needs you."));
  });

  it("shows a section only with what matched, opened", async () => {
    await seed();
    prefs.setPrefs({
      cloudSections: { [ME]: { [ORG]: [{ id: "s1", name: "Parked", projects: [WEB] }, { id: "s2", name: "Active", projects: [API] }] } },
      sidebarSections: { "cloud-section:s2": "collapsed" },
    });
    mount();
    await filterTo("needs");
    await waitFor(() => expect(screen.queryAllByTestId("cloud-section-name").map((name) => name.textContent)).toEqual(["Active"]));
    expect(screen.getByRole("button", { name: "Active section" }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("workspace lifecycle menus", () => {
  it("puts a lone workspace's Stop, Archive and Delete in its project's menu, through the existing dialog", async () => {
    await standard();
    mount();
    const menu = await openMenu("Project menu for acme/web");
    expect(items(menu)).toEqual(expect.arrayContaining(["New session", "Pin project", "Move to section", "Refresh", "Stop", "Archive… (stops compute, deleted after 30 days)", "Delete…"]));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Stop" }));
    await waitFor(() => expect(screen.getByTestId("lifecycle-dialog").textContent).toBe("stop"));
    expect(mocks.lifecycle.at(-1)!.item.workspace.id).toBe("site");
    expectNoAttachOrResume();
  });

  it("names each workspace of a project with several, with its state and its own menu; Resume runs only when chosen", async () => {
    await standard();
    mount();
    const groups = within(project("acme/api")).getAllByTestId("cloud-workspace-group");
    expect(groups.map((group) => group.getAttribute("data-workspace"))).toEqual(["fix-login", "perf-sweep"]);
    expect(within(groups[1]).getByTestId("cloud-workspace-row-state").textContent).toBe("Stopped");
    const menu = await openMenu("Actions for perf-sweep");
    expect(items(menu)).toEqual(["Resume", "Archive… (stops compute, deleted after 30 days)", "Delete…"]);
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    mocks.api.cloudWorkspaceResume.mockResolvedValue({ workspace: { ...item("perf-sweep", { repositories: [acmeApi] }).workspace, state: "suspended" }, operation: { id: "op", state: "running", action: "resume" } });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Resume" }));
    await waitFor(() => expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledWith("perf-sweep", ORG));
    // Its submenu in the project's menu offers the same.
    const projectMenu = await openMenu("Project menu for acme/api");
    expect(within(projectMenu).getByRole("menuitem", { name: "fix-login" })).toBeTruthy();
  });

  it("opens a workspace's own view from the project's menu, running or stopped, without waking it; not while it changes or failed", async () => {
    await load(
      [
        item("site", { repositories: [acmeWeb] }),
        item("fix-login", { repositories: [acmeApi], lastActivityAt: 50 }),
        item("perf-sweep", { state: "suspended", repositories: [acmeApi], lastActivityAt: 40 }),
        item("booting", { state: "provisioning", repositories: [{ ...acmeApi, identity: "github.com/acme/boot", fullName: "acme/boot" }] }),
        item("broken", { state: "attention-required", repositories: [{ ...acmeApi, identity: "github.com/acme/broken", fullName: "acme/broken" }] }),
      ],
      // Its sessions are known, so the sidebar shows no "Open to load sessions" line for it.
      { site: { sessions: [session("s2", "Landing copy")], capabilities: ["session/2"] } },
    );
    mount();
    expect(within(project("acme/web")).queryByTestId("cloud-workspace-empty")).toBeNull();
    let menu = await openMenu("Project menu for acme/web");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open workspace" }));
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe(`cloud:${ORG}:site`);
    // A stopped workspace of a project with several: from its submenu, and it is not resumed.
    menu = await openMenu("Project menu for acme/api");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "perf-sweep" }));
    const submenu = (await screen.findAllByRole("menu")).at(-1)!;
    fireEvent.click(within(submenu).getByRole("menuitem", { name: "Open workspace" }));
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe(`cloud:${ORG}:perf-sweep`);
    for (const name of ["acme/boot", "acme/broken"]) {
      menu = await openMenu(`Project menu for ${name}`);
      expect(within(menu).queryByRole("menuitem", { name: "Open workspace" })).toBeNull();
      fireEvent.keyDown(menu, { key: "Escape" });
    }
    expectNoAttachOrResume();
  });

  it("shows a stopped workspace's view from Open workspace by connecting, never waking it", async () => {
    const connection = { target: { kind: "cloud", organizationId: ORG, workspaceId: "perf-sweep" }, client: { onState: () => () => undefined }, activate: vi.fn(), close: vi.fn() };
    mocks.workspaceConnection.mockResolvedValue(connection);
    await standard();
    mount();
    const menu = await openMenu("Project menu for acme/api");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "perf-sweep" }));
    fireEvent.click(within((await screen.findAllByRole("menu")).at(-1)!).getByRole("menuitem", { name: "Open workspace" }));
    const key = sessions.getSessionStore().selectedCloudWorkspace!;
    expect(key).toBe(`cloud:${ORG}:perf-sweep`);
    render(<CloudWorkspaceMain workspaceKey={key} sidebarOpen onToggleSidebar={() => undefined} />);
    await screen.findByTestId("workspace-view");
    expect(screen.getByTestId("cloud-stopped-banner")).toBeTruthy();
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: ORG, workspaceId: "perf-sweep" }, "connect");
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(connection.activate).not.toHaveBeenCalled();
  });

  it("lists archived workspaces folded at the organization's end, with their deadline, Read conversations and Unarchive", async () => {
    await standard();
    mocks.api.cloudWorkspaceUnarchive.mockResolvedValue({ workspace: { ...item("old").workspace, state: "suspended", archivedAt: null }, operation: { id: "op" } });
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [] });
    mount();
    const archived = screen.getByTestId("cloud-node-archived");
    fireEvent.click(within(archived).getByRole("button", { name: "Archived workspaces (1)" }));
    expect(within(archived).getByTestId("cloud-archived-note").textContent).toContain("Storage keeps billing");
    expect(within(archived).getByTestId("cloud-archive-deadline").textContent).toMatch(/^Deleted automatically on .* \(in 1[12] days\)\.$/);
    const menu = await openMenu("Actions for old");
    expect(items(menu)).toEqual(["Read conversations", "Unarchive", "Delete…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unarchive" }));
    await waitFor(() => expect(mocks.api.cloudWorkspaceUnarchive).toHaveBeenCalledWith("old", ORG));
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("offers the organization's refresh, new workspace and hide from its header, and the hidden count opens Settings", async () => {
    await standard();
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [] });
    mount();
    let menu = await openMenu("Menu for Acme");
    expect(items(menu)).toEqual(["Refresh cloud workspaces", "New section", "New cloud workspace…", "Hide organization"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New cloud workspace…" }));
    expect(openNewWorkspace).toHaveBeenCalledTimes(1);
    menu = await openMenu("Menu for Acme");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Refresh cloud workspaces" }));
    await waitFor(() => expect(mocks.api.cloudWorkspaces).toHaveBeenCalled());
    menu = await openMenu("Menu for Beta");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Hide organization" }));
    await waitFor(() => expect(screen.queryAllByTestId("cloud-org-list").map((section) => section.getAttribute("data-org"))).toEqual([ORG]));
    fireEvent.click(screen.getByTestId("hidden-organizations"));
    expect(onOpenOrganizations).toHaveBeenCalledTimes(1);
    expectNoAttachOrResume();
  });

  it("offers the add-project menu: a member may add a repository, a new project says who can", async () => {
    await standard();
    mount();
    const menu = await openMenu("Add project to Beta");
    expect(within(menu).getByRole("menuitem", { name: "From repository…" }).getAttribute("aria-disabled")).toBeNull();
    expect(within(menu).getByTestId("cloud-add-blank-project").getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByTestId("cloud-add-blank-project").textContent).toContain("admins only");
  });

  // PRO-107: GitHub is on the organization's own page now, not in Settings → Account.
  it("sends the way to choose repositories to the organization's own page", async () => {
    const { takeOrganizationRequest } = await import("@/lib/settingsLinks");
    await standard();
    mount();
    let menu = await openMenu("Add project to Beta");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "From repository…" }));
    const empty = await screen.findByTestId("cloud-no-repositories");
    expect(empty.textContent).toContain("Choose them on Beta's page in Settings → Organizations, under GitHub.");
    fireEvent.click(within(empty).getByRole("button", { name: "Open Beta's settings" }));
    expect(takeOrganizationRequest()).toBe(OTHER);
    expect(screen.queryByTestId("cloud-add-repository")).toBeNull();

    mocks.api.cloudWorkspaceRepositories.mockResolvedValue({ configured: false, repositories: [] });
    menu = await openMenu("Add project to Beta");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "From repository…" }));
    const missing = await screen.findByTestId("cloud-github-not-connected");
    expect(missing.textContent).toContain("on Beta's page in Settings → Organizations, under GitHub");
    expect(missing.textContent).not.toContain("Settings → Account");
    fireEvent.click(within(missing).getByRole("button", { name: "Open Beta's settings" }));
    expect(takeOrganizationRequest()).toBe(OTHER);
  });

  it("renames, pins, archives and deletes a session from its menu, on a runtime with session/2 only", async () => {
    await standard();
    mount();
    expect(within(sessionRow(`cloud:${ORG}:site:s2`)).queryByRole("button", { name: /Session menu/ })).toBeNull();
    const menu = await openMenu("Session menu for Fix login redirect");
    expect(items(menu)).toEqual(["Rename", "Pin", "Archive", "Delete session…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    expect(within(sessionRow(`cloud:${ORG}:fix-login:s1`)).getByRole("textbox", { name: "Session name" })).toBeTruthy();
  });
});

describe("an organization's states", () => {
  it("says it is loading, then why it failed, under its header even when folded, and Retry lists it again", async () => {
    prefs.setPrefs({ sidebarSections: { [`list:org:${ORG}`]: "collapsed" } });
    let fail: (reason: unknown) => void = () => undefined;
    let answer: (value: unknown) => void = () => undefined;
    mocks.api.cloudWorkspaces.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    mount();
    expect(within(org()).getByTestId("cloud-org-loading").textContent).toBe("Loading cloud projects…");
    const first = act(() => catalog.refreshCloudCatalog(ORG));
    fail({ code: "cloud_workspace_unavailable" });
    await first;
    const failed = within(org()).getByTestId("cloud-org-failed");
    expect(failed.textContent).toContain("Couldn’t load cloud projects. The cloud service did not answer.");
    mocks.api.cloudWorkspaces.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    fireEvent.click(within(failed).getByRole("button", { name: "Retry loading Acme" }));
    expect((within(org()).getByRole("button", { name: "Retrying Acme" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({ workspaces: [item("site", { repositories: [acmeWeb] })] }));
    await waitFor(() => expect(within(org()).queryByTestId("cloud-org-failed")).toBeNull());
    expectNoAttachOrResume();
  });

  it("keeps an offline organization's rows and offers Retry beside 'last known'", async () => {
    await standard();
    mocks.api.cloudWorkspaces.mockRejectedValueOnce({ code: "cloud_workspace_unavailable" });
    await act(() => catalog.refreshCloudCatalog(ORG));
    mount();
    const offline = within(org()).getByTestId("cloud-org-offline");
    expect(offline.textContent).toMatch(/^Offline · last known .+Retry$/);
    expect(within(org()).getAllByTestId("cloud-project-group").length).toBeGreaterThan(0);
    mocks.api.cloudWorkspaces.mockResolvedValueOnce({ workspaces: [item("site", { repositories: [acmeWeb] })] });
    fireEvent.click(within(offline).getByRole("button", { name: "Retry loading Acme" }));
    await waitFor(() => expect(screen.queryByTestId("cloud-org-offline")).toBeNull());
  });

  it("offers Switch for an organization that is not live, after a warning", async () => {
    mocks.status = { ...mocks.status, multiOrg: false } as AccountStatus;
    mocks.api.organizationSelect.mockResolvedValue(undefined);
    await standard();
    mount();
    const line = within(org(OTHER)).getByTestId("cloud-org-not-live");
    fireEvent.click(within(line).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(mocks.api.organizationSelect).toHaveBeenCalledWith(OTHER, "s:1"));
    expect(mocks.ask).toHaveBeenCalledTimes(1);
  });

  it("says once what this Mac dropped of a workspace deleted elsewhere, and the notice can be dismissed", async () => {
    await standard();
    mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: true, unsentCommands: 2, cachedTabs: 1 });
    await act(async () => {
      await catalog.ingestCloudList({ workspaces: [], tombstones: [{ id: "site", orgId: ORG, deletedAt: 5, expiresAt: 6 }] }, ORG);
    });
    mount();
    const notice = await screen.findByTestId("cloud-tombstone-notice");
    expect(notice.textContent).toMatch(/“site” was permanently deleted\./);
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByTestId("cloud-tombstone-notice")).toBeNull());
  });
});
