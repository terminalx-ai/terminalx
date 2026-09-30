import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// PRO-61 (CS-7, CS-8, CS-13 subset, CS-14): cloud projects and sessions in
// the sidebar, like local. Sessions and tabs sit under the project; the VM is
// a location chip, and a group row only with more than one workspace.
// Looking never costs money: rendering, expanding and selecting make no
// attach and no resume.

const mocks = vi.hoisted(() => ({
  api: {
    cloudWorkspaces: vi.fn(),
    cloudWorkspaceRepositories: vi.fn(),
    cloudWorkspaceResume: vi.fn(),
    cloudWorkspaceCreate: vi.fn(),
    cloudWorkspaceQuote: vi.fn(),
    cloudRemoteAttach: vi.fn(),
    cloudRemoteActivate: vi.fn(),
    cloudAgentPurgeWorkspace: vi.fn(),
    cloudCatalogLoad: vi.fn(),
    cloudCatalogSave: vi.fn(),
    organizationSelect: vi.fn(),
  },
  workspaceConnection: vi.fn(),
  invoke: vi.fn(),
  ask: vi.fn(),
  status: null as unknown as AccountStatus,
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
  refreshAccount: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask }));

const { CloudSections } = await import("./CloudSections");
const catalog = await import("@/lib/cloudCatalog");
const sessions = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const { resetCloudAgents } = await import("@/lib/cloudAgents");
const { resetCloudSessions } = await import("@/lib/cloudSessions");

const ORG = "org-a";
const acmeApi = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };
const acmeWeb = { identity: "github.com/acme/web", fullName: "acme/web", cloneUrl: "https://github.com/acme/web.git", primary: true };

function item(id: string, fields: Record<string, unknown> = {}): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId: ORG, name: id, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, ...fields },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

const session = (id: string, title: string, fields: Record<string, unknown> = {}) => ({
  id,
  projectPath: "/workspace",
  cwd: "/workspace",
  title,
  created: "2026-09-30T10:00:00.000Z",
  modified: "2026-09-30T11:00:00.000Z",
  archived: false,
  pinned: false,
  tabs: [{ id: `${id}-tab`, harness: "claude", title: null, model: "opus", permissionMode: "bypassPermissions", status: "idle", created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" }],
  ...fields,
});

function signIn() {
  mocks.status = {
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    organizations: [{ id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } }],
  };
}

/** The catalog as a relaunch reads it: rows and each workspace's cached sessions. */
async function load(workspaces: CloudWorkspaceListItem[], cached: Record<string, { sessions: unknown[]; capabilities: string[] | null }> = {}) {
  await catalog.ingestCloudList({ workspaces, quota: { used: workspaces.length, limit: 3 } }, ORG);
  for (const [workspaceId, entry] of Object.entries(cached)) catalog.cacheCloudSessions(ORG, workspaceId, entry.sessions as never, entry.capabilities);
}

const onOpenAccount = vi.fn();
const mount = () =>
  render(
    <TooltipProvider>
      <div role="tree">
        <CloudSections onOpenAccount={onOpenAccount} />
      </div>
    </TooltipProvider>,
  );

const projectRow = (key: string) => screen.getAllByTestId("cloud-project-row").find((node) => node.getAttribute("data-project") === key);
const projectTree = (key: string) => projectRow(key)!.closest('[role="treeitem"]') as HTMLElement;
const sessionNode = (key: string) => screen.getAllByTestId("cloud-session-node").find((node) => node.getAttribute("data-session") === key)!;

/** A real mouse click: pointerdown, mousedown, pointerup, mouseup, click. */
function mouseClick(element: HTMLElement) {
  fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

function expectNoAttachOrResume() {
  expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
  expect(mocks.api.cloudRemoteActivate).not.toHaveBeenCalled();
  expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
}

beforeEach(() => {
  signIn();
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.workspaceConnection.mockReset();
  mocks.ask.mockReset().mockResolvedValue(true);
  onOpenAccount.mockReset();
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  // This desktop's agent cache and checkpoint list: read on expand, never a connection.
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "cloud_agent_cache_load") return { tabs: {} };
    if (command === "cloud_agent_outbox" || command === "cloud_agent_checkpoints") return [];
    return undefined;
  });
  prefs.setPrefs({ cloudProjects: {}, cloudBlankProjects: {}, cloudPinned: {}, cloudCollapsed: {}, sidebarSections: {} });
  act(() => sessions.selectSession(null));
});

afterEach(() => {
  cleanup();
  catalog.resetCloudCatalog();
  resetCloudAgents();
  resetCloudSessions();
});

describe("sessions under the project", () => {
  it("lists a project's sessions and tabs from the cache and the launch placeholder, with the VM only as a location chip", async () => {
    await load(
      [item("fix-login", { repositories: [acmeApi], launch: { launchId: "l", phase: "running", state: "started", workBranch: "terminalx/fix-login-3f2a", agent: "claude", sessionId: "first", tabId: "first-tab", timings: {} } })],
      { "fix-login": { sessions: [session("second", "Add tests", { modified: "2026-09-30T12:00:00.000Z" })], capabilities: ["session/2"] } },
    );
    mount();
    const tree = projectTree(`cloud:${ORG}:github.com/acme/api`);
    const rows = within(tree).getAllByTestId("cloud-session-node");
    // Newest first; the launch placeholder is named after the workspace until the runtime says more.
    expect(rows.map((row) => row.getAttribute("data-session"))).toEqual([`cloud:${ORG}:fix-login:second`, `cloud:${ORG}:fix-login:first`]);
    expect(within(rows[0]).getByText("Add tests")).toBeTruthy();
    expect(within(rows[1]).getByText("fix-login", { selector: "span.flex-1" })).toBeTruthy();
    // One workspace: no VM row, a location chip with the hover card.
    expect(within(tree).queryByTestId("cloud-workspace-node")).toBeNull();
    const chip = within(rows[0]).getByTestId("cloud-location-chip");
    expect(chip.textContent).toContain("fix-login");
    expect(chip.getAttribute("title")).toContain("Runs on box");
    // Tabs sit under their session.
    expect(within(rows[0]).getByRole("treeitem", { name: "Claude", hidden: true })).toBeTruthy();
    expectNoAttachOrResume();
  });

  it("render, expand and select make 0 attach and 0 resume calls, and selecting sets a cloud key", async () => {
    await load([item("fix-login", { state: "suspended", repositories: [acmeApi] })], { "fix-login": { sessions: [session("s1", "Fix login redirect")], capabilities: ["session/2"] } });
    mount();
    for (let pass = 0; pass < 2; pass++) {
      for (const toggle of document.querySelectorAll<HTMLButtonElement>("[data-tree-toggle]")) fireEvent.click(toggle);
    }
    fireEvent.click(within(sessionNode(`cloud:${ORG}:fix-login:s1`)).getByText("Fix login redirect"));
    expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:fix-login:s1`);
    // A tab click selects its session too, and still looks only.
    fireEvent.click(within(sessionNode(`cloud:${ORG}:fix-login:s1`)).getByRole("treeitem", { name: "Claude", hidden: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expectNoAttachOrResume();
  });

  it("never shows a stopped workspace's cached in-progress tab as working", async () => {
    const working = session("s1", "Long task");
    working.tabs[0].status = "in_progress";
    await load([item("sleepy", { state: "suspended", repositories: [acmeApi] })], { sleepy: { sessions: [working], capabilities: null } });
    mount();
    const tab = within(sessionNode(`cloud:${ORG}:sleepy:s1`)).getByRole("treeitem", { name: "Claude", hidden: true });
    expect(tab.getAttribute("title")).toBe("Claude · Idle");
    expect(within(sessionNode(`cloud:${ORG}:sleepy:s1`)).getByTestId("cloud-location-chip").getAttribute("title")).toContain("State: Stopped");
  });

  it("groups by VM only when a project has more than one workspace", async () => {
    await load(
      [item("fix-login", { repositories: [acmeApi], lastActivityAt: 50 }), item("perf", { repositories: [acmeApi], state: "suspended", lastActivityAt: 40 }), item("web-1", { repositories: [acmeWeb] })],
      { "fix-login": { sessions: [session("a", "A")], capabilities: null }, perf: { sessions: [session("b", "B")], capabilities: null }, "web-1": { sessions: [session("c", "C")], capabilities: null } },
    );
    mount();
    const api = projectTree(`cloud:${ORG}:github.com/acme/api`);
    const groups = within(api).getAllByTestId("cloud-workspace-node");
    expect(groups.map((node) => node.getAttribute("data-workspace"))).toEqual(["fix-login", "perf"]);
    expect(within(groups[0]).getAllByTestId("cloud-session-node").map((node) => node.getAttribute("data-session"))).toEqual([`cloud:${ORG}:fix-login:a`]);
    // Grouped: the group row names the VM, so the sessions carry no chip.
    expect(within(groups[0]).queryByTestId("cloud-location-chip")).toBeNull();
    const web = projectTree(`cloud:${ORG}:github.com/acme/web`);
    expect(within(web).queryByTestId("cloud-workspace-node")).toBeNull();
    expect(within(web).getByTestId("cloud-location-chip")).toBeTruthy();
  });

  it("offers rename, pin, archive and delete only on runtimes with session/2", async () => {
    await load([item("new-rt", { repositories: [acmeApi] }), item("old-rt", { repositories: [acmeWeb] })], {
      "new-rt": { sessions: [session("n", "On a new runtime")], capabilities: ["session/1", "session/2"] },
      "old-rt": { sessions: [session("o", "On an old runtime")], capabilities: ["session/1"] },
    });
    mount();
    expect(within(sessionNode(`cloud:${ORG}:old-rt:o`)).queryByRole("button", { name: /Session menu/ })).toBeNull();
    mouseClick(within(sessionNode(`cloud:${ORG}:new-rt:n`)).getByRole("button", { name: "Session menu for On a new runtime" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual(["Rename", "Pin", "Archive", "Delete session…"]);
  });

  it("offers the session menu only to a manager of the workspace (PRO-30 review)", async () => {
    await load(
      [
        item("managed", { repositories: [acmeApi], you: { role: "manager", canApprove: true } }),
        item("driven", { repositories: [acmeWeb], you: { role: "driver", canApprove: false } }),
      ],
      {
        managed: { sessions: [session("m", "Managed")], capabilities: ["session/1", "session/2"] },
        driven: { sessions: [session("d", "Driven")], capabilities: ["session/1", "session/2"] },
      },
    );
    mount();
    expect(within(sessionNode(`cloud:${ORG}:managed:m`)).getByRole("button", { name: "Session menu for Managed" })).toBeTruthy();
    // session/2 is granted, but only managers may rename, pin, archive or delete.
    expect(within(sessionNode(`cloud:${ORG}:driven:d`)).queryByRole("button", { name: /Session menu/ })).toBeNull();
  });

  it("puts the workspace lifecycle actions in the project's menu", async () => {
    await load([item("fix-login", { repositories: [acmeApi] })]);
    mount();
    mouseClick(within(projectRow(`cloud:${ORG}:github.com/acme/api`)!).getByRole("button", { name: "Project menu for acme/api" }));
    const menu = await screen.findByRole("menu");
    const labels = within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim());
    expect(labels).toEqual(["New session", "Pin project", "Refresh", "Stop", "Archive… (stops compute, deleted after 30 days)", "Delete…"]);
    expect(within(menu).getByText("Workspace · fix-login")).toBeTruthy();
  });

  it("`+` on a project opens the new-session form for it, spending nothing", async () => {
    await load([item("fix-login", { repositories: [acmeApi] })]);
    mount();
    fireEvent.click(within(projectRow(`cloud:${ORG}:github.com/acme/api`)!).getByRole("button", { name: "New session in acme/api" }));
    expect(sessions.getSessionStore().cloudSessionPreset).toEqual({ projectKey: `cloud:${ORG}:github.com/acme/api` });
    expect(sessions.getSessionStore().selectedSessionId).toBeNull();
    expectNoAttachOrResume();
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();
  });
});

describe("+ Add project", () => {
  it("adds a selected repository from the picker when the GitHub App is connected", async () => {
    await load([item("fix-login", { repositories: [acmeApi] })]);
    mocks.api.cloudWorkspaceRepositories.mockResolvedValue({
      configured: true,
      repositories: [
        { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", defaultBranch: "main", private: true, state: "accessible", reason: null },
        { fullName: "acme/web", cloneUrl: "https://github.com/acme/web.git", defaultBranch: "main", private: false, state: "accessible", reason: null },
      ],
    });
    mount();
    mouseClick(screen.getByTestId("cloud-add-project"));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /From repository/ }));
    const dialog = await screen.findByTestId("cloud-add-repository");
    const options = await within(dialog).findAllByRole("option");
    // Already in the sidebar: shown, not offered twice.
    expect(options[0].textContent).toContain("Added");
    expect((options[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("option", { name: /acme\/web/ }));
    expect(prefs.getPrefs().cloudProjects[ORG]).toEqual(["github.com/acme/web"]);
    await waitFor(() => expect(projectRow(`cloud:${ORG}:github.com/acme/web`)).toBeTruthy());
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();
    expectNoAttachOrResume();
  });

  it("says so, and links to Settings, when the GitHub App is not connected", async () => {
    await load([]);
    mocks.api.cloudWorkspaceRepositories.mockResolvedValue({ configured: false, repositories: [] });
    mount();
    mouseClick(screen.getByTestId("cloud-add-project"));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /From repository/ }));
    const notice = await screen.findByTestId("cloud-github-not-connected");
    expect(notice.textContent).toContain("The GitHub App is not connected for Acme");
    fireEvent.click(within(notice).getByRole("button", { name: "Open Settings" }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it("adds a blank project by name without creating anything on the server", async () => {
    await load([]);
    mount();
    mouseClick(screen.getByTestId("cloud-add-project"));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /New project/ }));
    const dialog = await screen.findByTestId("cloud-new-blank-project");
    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "scratch" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add project" }));
    expect(prefs.getPrefs().cloudBlankProjects[ORG]).toEqual(["scratch"]);
    const row = await waitFor(() => projectRow(`cloud:${ORG}:blank/scratch`)!);
    expect(row.textContent).toContain("scratch");
    expect(row.textContent).toContain("no repo");
    // Its first session's form opens; nothing is created or quoted until Start.
    expect(sessions.getSessionStore().cloudSessionPreset).toEqual({ projectKey: `cloud:${ORG}:blank/scratch` });
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceQuote).not.toHaveBeenCalled();
    expectNoAttachOrResume();
  });

  it("shows a blank project on another device from the server's list alone", async () => {
    // Another device: nothing in prefs, only the list, where the workspace has no repository.
    await load([item("ws-1", { name: "scratch", repositories: [] })], { "ws-1": { sessions: [session("s1", "Sketch an idea")], capabilities: ["session/2"] } });
    mount();
    const row = projectRow(`cloud:${ORG}:blank/scratch`)!;
    expect(row.textContent).toContain("scratch");
    expect(row.textContent).toContain("no repo");
    expect(within(projectTree(`cloud:${ORG}:blank/scratch`)).getAllByTestId("cloud-session-node").map((node) => node.getAttribute("data-session"))).toEqual([`cloud:${ORG}:ws-1:s1`]);
    expect(screen.queryByTestId("cloud-node-other")).toBeNull();
  });
});

// PRO-61 follow-ups from the live run.
describe("rows behave like local rows", () => {
  it("keeps a project's + and menu in the accessibility tree and the Tab order without hovering", async () => {
    await load([item("fix-login", { repositories: [acmeApi] })]);
    mount();
    const row = projectRow(`cloud:${ORG}:github.com/acme/api`)!;
    // Found without `hidden: true`: they are exposed, not display:none.
    const plus = within(row).getByRole("button", { name: "New session in acme/api" });
    const menu = within(row).getByRole("button", { name: "Project menu for acme/api" });
    for (const button of [plus, menu]) {
      expect(button.tabIndex).not.toBe(-1);
      expect(button.closest("span")!.className).toContain("sr-only");
      expect(button.closest("span")!.className).toContain("group-focus-within/row:not-sr-only");
    }
  });

  it("a click on a project row does what a local one does, every time: focus it, and with no session open show its new-session form", async () => {
    await load([item("fix-login", { repositories: [acmeApi] })], { "fix-login": { sessions: [session("s1", "Fix login redirect")], capabilities: null } });
    mount();
    const key = `cloud:${ORG}:github.com/acme/api`;
    const name = within(projectRow(key)!).getByText("acme/api").closest("button")!;
    for (let clicks = 0; clicks < 3; clicks++) {
      fireEvent.click(name);
      expect(sessions.getSessionStore().cloudSessionPreset).toEqual({ projectKey: key });
      // Clicking the name never collapses it; the chevron does.
      expect(projectTree(key).getAttribute("aria-expanded")).toBe("true");
    }
    // With a session open, the click only focuses the project, as locally.
    act(() => sessions.selectCloudSession(`cloud:${ORG}:fix-login:s1`));
    fireEvent.click(name);
    expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:fix-login:s1`);
    expect(sessions.getSessionStore().selectedCloudProject).toBe(key);
    expectNoAttachOrResume();
  });

  it("keeps keyboard focus on the clicked project or session row", async () => {
    await load([item("fix-login", { repositories: [acmeApi] })], { "fix-login": { sessions: [session("s1", "Fix login redirect")], capabilities: null } });
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "Issues";
    document.body.appendChild(elsewhere);
    mount();
    elsewhere.focus();
    const title = within(sessionNode(`cloud:${ORG}:fix-login:s1`)).getByText("Fix login redirect").closest("button")!;
    fireEvent.click(title);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(document.activeElement).toBe(title);
    elsewhere.focus();
    const name = within(projectRow(`cloud:${ORG}:github.com/acme/api`)!).getByText("acme/api").closest("button")!;
    fireEvent.click(name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(document.activeElement).toBe(name);
    elsewhere.remove();
  });
});
