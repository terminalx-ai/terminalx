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
    cloudDiagnostics: vi.fn(),
    cloudConnectionDiagnostics: vi.fn(),
    cloudDiagnosticsExport: vi.fn(),
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
const cloudTerminals = await import("@/lib/cloudTerminals");
const terminalStore = await import("@/lib/terminal");
const { setVisibleSessionTab } = await import("@/lib/visibleTab");
const { applyCollabEvent, resetCollab } = await import("@/lib/cloudCollab");

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
  cloudTerminals.resetCloudTerminals();
  catalog.resetCloudCatalog();
  resetCloudAgents();
  resetCloudSessions();
  resetCollab();
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
    expect(within(rows[0]).getByRole("treeitem", { name: "Claude Code", hidden: true })).toBeTruthy();
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
    fireEvent.click(within(sessionNode(`cloud:${ORG}:fix-login:s1`)).getByRole("treeitem", { name: "Claude Code", hidden: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expectNoAttachOrResume();
  });

  it("never shows a stopped workspace's cached in-progress tab as working", async () => {
    const working = session("s1", "Long task");
    working.tabs[0].status = "in_progress";
    await load([item("sleepy", { state: "suspended", repositories: [acmeApi] })], { sleepy: { sessions: [working], capabilities: null } });
    mount();
    const tab = within(sessionNode(`cloud:${ORG}:sleepy:s1`)).getByRole("treeitem", { name: "Claude Code", hidden: true });
    expect(tab.getAttribute("title")).toBe("Claude Code · Idle");
    expect(within(sessionNode(`cloud:${ORG}:sleepy:s1`)).getByTestId("cloud-location-chip").getAttribute("title")).toContain("State: Stopped");
  });

  describe("S1 chips (PRO-59)", () => {
    const webExtra = { ...acmeWeb, primary: false };
    const docsExtra = { identity: "github.com/acme/docs", fullName: null, cloneUrl: "https://github.com/acme/docs.git", primary: false };

    it("marks a workspace with extra repositories +N repo, on the project row when it is the only workspace", async () => {
      await load([item("multi", { repositories: [acmeApi, webExtra, docsExtra] }), item("single", { repositories: [acmeWeb] })], {
        multi: { sessions: [session("a", "A")], capabilities: null },
        single: { sessions: [session("b", "B")], capabilities: null },
      });
      mount();
      const api = projectTree(`cloud:${ORG}:github.com/acme/api`);
      const chip = within(api).getByTestId("cloud-extra-repositories");
      expect(chip.textContent).toBe("+2 repos");
      // The tooltip names them; an unselected repository shows by its identity.
      expect(chip.getAttribute("title")).toBe("multi also checks out acme/web, github.com/acme/docs");
      expect(within(api).getByTestId("cloud-project-row").contains(chip)).toBe(true);
      // The extra repository is not a second place for the workspace.
      expect(within(projectTree(`cloud:${ORG}:github.com/acme/web`)).queryByTestId("cloud-extra-repositories")).toBeNull();
      expect(within(projectTree(`cloud:${ORG}:github.com/acme/web`)).getAllByTestId("cloud-session-node")).toHaveLength(1);
    });

    it("puts the chip on the workspace's own row when the project has several", async () => {
      await load([item("multi", { repositories: [acmeApi, webExtra], lastActivityAt: 50 }), item("plain", { repositories: [acmeApi], lastActivityAt: 40 })], {
        multi: { sessions: [session("a", "A")], capabilities: null },
        plain: { sessions: [session("b", "B")], capabilities: null },
      });
      mount();
      const api = projectTree(`cloud:${ORG}:github.com/acme/api`);
      const [multi, plain] = within(api).getAllByTestId("cloud-workspace-node");
      expect(within(multi).getByTestId("cloud-extra-repositories").textContent).toBe("+1 repo");
      expect(within(plain).queryByTestId("cloud-extra-repositories")).toBeNull();
      expect(within(api).getByTestId("cloud-project-row").querySelector('[data-testid="cloud-extra-repositories"]')).toBeNull();
    });

    it("shows the organization's running slots in its header, and says when it is full", async () => {
      await catalog.ingestCloudList({ workspaces: [item("one", { repositories: [acmeApi] })], quota: { used: 1, limit: 2, running: { used: 1, limit: 2 }, total: { used: 5, limit: 20 } } } as never, ORG);
      const view = mount();
      const chip = screen.getByTestId("cloud-org-quota");
      expect(chip.textContent).toBe("1 of 2 running");
      expect(chip.getAttribute("title")).toBe("1 of 2 cloud workspaces running\n5 of 20 workspaces in all, stopped ones included");
      expect(chip.getAttribute("data-at-limit")).toBeNull();
      view.unmount();

      await catalog.ingestCloudList({ workspaces: [item("one", { repositories: [acmeApi] })], quota: { used: 2, limit: 2 } }, ORG);
      mount();
      const full = screen.getByTestId("cloud-org-quota");
      expect(full.textContent).toBe("2 of 2 running");
      expect(full.getAttribute("data-at-limit")).toBe("true");
      expect(full.getAttribute("title")).toContain("Stop one to start another.");
    });

    it("draws neither chip for a server that sends neither field (CS-5 behaviour)", async () => {
      await catalog.ingestCloudList({ workspaces: [item("old", {})] }, ORG);
      catalog.cacheCloudSessions(ORG, "old", [session("a", "A")] as never, null);
      mount();
      expect(screen.queryByTestId("cloud-org-quota")).toBeNull();
      expect(screen.queryByTestId("cloud-extra-repositories")).toBeNull();
      expect(screen.getAllByTestId("cloud-session-node")).toHaveLength(1);
    });

    it("renders both chips without attaching or resuming anything", async () => {
      await load([item("multi", { state: "suspended", repositories: [acmeApi, webExtra] })], { multi: { sessions: [session("a", "A")], capabilities: null } });
      mount();
      expect(screen.getByTestId("cloud-extra-repositories")).toBeTruthy();
      expect(screen.getByTestId("cloud-org-quota")).toBeTruthy();
      expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    });
  });

  describe("the sidebar's Unread / Needs you filter (PRO-23)", () => {
    const sessionsStore = () => import("@/lib/sessions");
    const { resetCloudDashboard } = { resetCloudDashboard: () => import("@/lib/cloudDashboard").then((module) => module.resetCloudDashboard()) };
    const tab = (id: string, status: string) => ({ id: `${id}-tab`, harness: "claude", title: null, model: "opus", permissionMode: "bypassPermissions", status, created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" });
    const pending = { online: true, reportedAt: Date.now(), activeTurns: 0, pendingApprovals: 1 };
    const seed = async () => {
      await load(
        [
          // The list says an approval waits in this running workspace.
          item("asks", { repositories: [acmeApi], lastActivityAt: 50, runtimeActivity: pending }),
          item("quiet", { repositories: [acmeApi], lastActivityAt: 40 }),
          // Stopped: its finished answer was never read.
          item("answered", { state: "suspended", repositories: [acmeWeb] }),
        ],
        {
          asks: { sessions: [session("a1", "Approve the deploy", { tabs: [tab("a1", "waiting")] })], capabilities: ["session/2"] },
          quiet: { sessions: [session("q1", "Nothing new")], capabilities: ["session/2"] },
          answered: { sessions: [session("w1", "Draft the changelog", { tabs: [tab("w1", "completed")] }), session("w2", "Read already")], capabilities: ["session/2"] },
        },
      );
    };
    const titles = () => screen.queryAllByTestId("cloud-session-node").map((node) => node.getAttribute("data-session"));
    const filterTo = async (filter: "all" | "unread" | "needs") => {
      const { setSidebarFilter } = await sessionsStore();
      await act(async () => {
        setSidebarFilter(filter);
        // The dashboard's projection, which the filter reads, settles a microtask later.
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    afterEach(async () => {
      await filterTo("all");
      await resetCloudDashboard();
    });

    it("Needs you shows only the cloud session waiting for a person, and no attach or resume happens", async () => {
      await seed();
      mount();
      expect(titles()).toHaveLength(4);
      await filterTo("needs");
      await waitFor(() => expect(titles()).toEqual([`cloud:${ORG}:asks:a1`]));
      // The other project has nothing waiting: it is not listed at all.
      expect(projectRow(`cloud:${ORG}:github.com/acme/web`)).toBeUndefined();
      // Nor the sibling workspace of the same project, nor a placeholder line for it.
      expect(screen.queryAllByTestId("cloud-workspace-node").map((node) => node.getAttribute("data-workspace"))).toEqual(["asks"]);
      expect(screen.queryByTestId("cloud-workspace-empty")).toBeNull();
      expectNoAttachOrResume();
    });

    it("Unread shows only the finished answer nobody has read, in a stopped workspace too, without waking it", async () => {
      await seed();
      mount();
      await filterTo("unread");
      await waitFor(() => expect(titles()).toEqual([`cloud:${ORG}:answered:w1`]));
      expect(projectRow(`cloud:${ORG}:github.com/acme/api`)).toBeUndefined();
      expectNoAttachOrResume();
    });

    it("opens a collapsed project that holds a match, and says so when an organization has none", async () => {
      await seed();
      const prefs = await import("@/lib/prefs");
      act(() => prefs.setPrefs({ cloudCollapsed: { [`cloud:${ORG}:github.com/acme/api`]: true } }));
      try {
        mount();
        expect(projectTree(`cloud:${ORG}:github.com/acme/api`).getAttribute("aria-expanded")).toBe("false");
        await filterTo("needs");
        await waitFor(() => expect(titles()).toEqual([`cloud:${ORG}:asks:a1`]));
        expect(projectTree(`cloud:${ORG}:github.com/acme/api`).getAttribute("aria-expanded")).toBe("true");
        // The approval is answered elsewhere: the list no longer reports it.
        await load([item("asks", { repositories: [acmeApi], lastActivityAt: 50 }), item("quiet", { repositories: [acmeApi], lastActivityAt: 40 })], {
          asks: { sessions: [session("a1", "Approve the deploy")], capabilities: ["session/2"] },
        });
        await waitFor(() => expect(screen.getByTestId("cloud-org-filtered-empty").textContent).toBe("Nothing needs you."));
        expect(titles()).toEqual([]);
        expect(screen.queryByTestId("cloud-node-archived")).toBeNull();
      } finally {
        act(() => prefs.setPrefs({ cloudCollapsed: {} }));
      }
    });

    it("keeps the selected cloud session in view under a filter it does not match", async () => {
      await seed();
      const { selectCloudSession, selectSession } = await sessionsStore();
      act(() => selectCloudSession(`cloud:${ORG}:quiet:q1`));
      try {
        mount();
        await filterTo("needs");
        await waitFor(() => expect(titles().sort()).toEqual([`cloud:${ORG}:asks:a1`, `cloud:${ORG}:quiet:q1`].sort()));
      } finally {
        act(() => selectSession(null));
      }
    });
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

  it("hides the session menu from a participant, whom the runtime would refuse anyway", async () => {
    await load([item("shared", { repositories: [acmeApi], authority: "participate" }), item("mine", { repositories: [acmeWeb], authority: "manage" })], {
      shared: { sessions: [session("p", "Someone else's")], capabilities: ["session/1", "session/2"] },
      mine: { sessions: [session("m", "My own")], capabilities: ["session/1", "session/2"] },
    });
    mount();
    expect(within(sessionNode(`cloud:${ORG}:shared:p`)).queryByRole("button", { name: /Session menu/ })).toBeNull();
    expect(within(sessionNode(`cloud:${ORG}:mine:m`)).getByRole("button", { name: "Session menu for My own" })).toBeTruthy();
  });

  it("puts the workspace lifecycle actions in the project's menu", async () => {
    await load([item("fix-login", { repositories: [acmeApi] })]);
    mount();
    mouseClick(within(projectRow(`cloud:${ORG}:github.com/acme/api`)!).getByRole("button", { name: "Project menu for acme/api" }));
    const menu = await screen.findByRole("menu");
    const labels = within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim());
    expect(labels).toEqual(["New session", "Pin project", "Refresh", "Cloud diagnostics…", "Stop", "Archive… (stops compute, deleted after 30 days)", "Delete…"]);
    expect(within(menu).getByText("Workspace · fix-login")).toBeTruthy();
  });

  // PRO-38: diagnostics where the project shows, for the project's organization.
  describe("cloud diagnostics from the project menu", () => {
    const openProjectMenu = async () => {
      mouseClick(within(projectRow(`cloud:${ORG}:github.com/acme/api`)!).getByRole("button", { name: "Project menu for acme/api" }));
      return screen.findByRole("menu");
    };
    const emptyReport = {
      v: 1,
      organizationId: ORG,
      generatedAt: 2,
      window: { from: 1, to: 2, maxOperations: 200, truncated: false },
      retention: null,
      stageTimings: { create: null, resume: null },
      operations: [],
      workspaces: [{ workspaceId: "fix-login", provider: "box", state: "ready", runtimeGeneration: 1, lastActivityAt: 1, connections: { ready: 1, waitingForRuntime: 0, expired: 0 }, lastOperationId: null }],
      closeReasons: [],
    };

    beforeEach(() => {
      mocks.api.cloudDiagnostics.mockReset().mockResolvedValue(emptyReport);
      mocks.api.cloudConnectionDiagnostics.mockReset().mockResolvedValue([]);
    });

    it("opens the organization's report for an administrator, marking the project's workspace", async () => {
      await load([item("fix-login", { repositories: [acmeApi] })]);
      mount();
      fireEvent.click(within(await openProjectMenu()).getByRole("menuitem", { name: /Cloud diagnostics/ }));
      const dialog = await screen.findByTestId("cloud-diagnostics-dialog");
      expect(within(dialog).getByText("Cloud diagnostics · Acme")).toBeTruthy();
      // A server that authorizes by the active organization: no organization is named.
      await waitFor(() => expect(mocks.api.cloudDiagnostics).toHaveBeenCalledWith(7, null));
      const row = await within(dialog).findByText("fix-login");
      expect(row.closest("li")!.hasAttribute("data-current")).toBe(true);
      // Looking spends nothing: no attach and no resume.
      expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
      expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    });

    it("asks for the project's own organization when the server authorizes by membership", async () => {
      mocks.status = { ...mocks.status, multiOrg: true };
      await load([item("fix-login", { repositories: [acmeApi] })]);
      mount();
      fireEvent.click(within(await openProjectMenu()).getByRole("menuitem", { name: /Cloud diagnostics/ }));
      await screen.findByTestId("cloud-diagnostics-dialog");
      await waitFor(() => expect(mocks.api.cloudDiagnostics).toHaveBeenCalledWith(7, ORG));
    });

    it("is not offered to a member of the project's organization", async () => {
      mocks.status = { ...mocks.status, organizations: mocks.status.organizations!.map((org) => ({ ...org, role: "member" })) };
      await load([item("fix-login", { repositories: [acmeApi] })]);
      mount();
      const labels = within(await openProjectMenu()).getAllByRole("menuitem").map((entry) => entry.textContent?.trim());
      expect(labels).not.toContain("Cloud diagnostics…");
      expect(mocks.api.cloudDiagnostics).not.toHaveBeenCalled();
    });
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

// A cloud session's terminals in the sidebar, like a local session's shells.
describe("terminals under the session", () => {
  const KEY = `cloud:${ORG}:fix-login:s1`;
  const WORKSPACE = `cloud:${ORG}:fix-login`;
  const pty = (ptyId: string, number: number, sessionId?: string) => ({ ptyId, number, epoch: "e1", pid: number, cwd: "/w", cols: 80, rows: 24, createdAt: 1, offset: 0, exited: false, exitCode: null, control: "other" as const, ...(sessionId ? { sessionId } : {}) });
  const xterm = () => ({ el: document.createElement("div"), term: { write: vi.fn(), onData: vi.fn(), onBinary: vi.fn(), onResize: vi.fn(), dispose: vi.fn(), cols: 80, rows: 24, resize: vi.fn() }, fit: {} }) as never;
  /** What a connected session view put in the store: the runtime's terminal list. */
  const listed = async (terminals: ReturnType<typeof pty>[]) => {
    const client = { connection: { state: "connected" }, listPtys: async () => ({ epoch: "e1", terminals }), attachPty: async () => ({ cursor: () => undefined, detach: () => undefined }) } as never;
    await act(async () => {
      await cloudTerminals.syncCloudTerminals(WORKSPACE, client, xterm);
    });
  };
  const tabRows = () => within(sessionNode(KEY)).getAllByRole("treeitem").filter((row) => row.hasAttribute("aria-controls"));
  /** A session that is not open starts collapsed; its chevron shows its tabs. */
  const expand = (title: string) => fireEvent.click(screen.getByRole("button", { name: `Expand ${title}` }));
  const selectedRows = () => tabRows().filter((row) => row.getAttribute("aria-selected") === "true").map((row) => row.getAttribute("aria-label"));

  beforeEach(async () => {
    await load([item("fix-login", { repositories: [acmeApi] })], { "fix-login": { sessions: [session("s1", "Fix login redirect"), session("s2", "Add tests")], capabilities: ["session/2"] } });
  });

  it("lists a session's terminals under it, and a new one when the runtime's list gains it", async () => {
    mount();
    expand("Fix login redirect");
    expand("Add tests");
    expect(tabRows().map((row) => row.getAttribute("aria-label"))).toEqual(["Claude Code"]);
    await listed([pty("p1", 1, "s1")]);
    expect(tabRows().map((row) => row.getAttribute("aria-label"))).toEqual(["Claude Code", "Terminal 1"]);
    // Someone else opens another: it appears with the next read of the list.
    await listed([pty("p1", 1, "s1"), pty("p2", 2, "s1"), pty("p3", 3, "s2")]);
    expect(tabRows().map((row) => row.getAttribute("aria-label"))).toEqual(["Claude Code", "Terminal 1", "Terminal 2"]);
    expect(within(sessionNode(`cloud:${ORG}:fix-login:s2`)).getByRole("treeitem", { name: "Terminal 3" })).toBeTruthy();
    expect(screen.queryByTestId("cloud-workspace-terminals")).toBeNull();
    expectNoAttachOrResume();
  });

  it("marks the row of the tab that shows, and a row switches to its tab", async () => {
    await listed([pty("p1", 1, "s1")]);
    act(() => sessions.selectCloudSession(KEY));
    mount();
    // The agent tab shows first: its row is the selected one, not the terminal's.
    expect(selectedRows()).toEqual(["Claude Code"]);

    fireEvent.click(within(sessionNode(KEY)).getByRole("treeitem", { name: "Terminal 1" }));
    expect(terminalStore.getTerminalState().selected[KEY]).toEqual({ kind: "terminal", id: `cloud:${WORKSPACE}:p1` });
    expect(selectedRows()).toEqual(["Terminal 1"]);

    // Clicking the agent row goes back: it used to stay highlighted and do nothing.
    fireEvent.click(within(sessionNode(KEY)).getByRole("treeitem", { name: "Claude Code" }));
    expect(terminalStore.getTerminalState().selected[KEY]).toEqual({ kind: "agent", id: "s1-tab" });
    expect(selectedRows()).toEqual(["Claude Code"]);
    expectNoAttachOrResume();
  });

  it("follows the open session view: the tab it reports showing is the row that is marked", async () => {
    await listed([pty("p1", 1, "s1")]);
    act(() => sessions.selectCloudSession(KEY));
    mount();
    // The shortcuts (⌘⇧[ / ⌘⇧]) switch in the view; the sidebar follows what it shows.
    act(() => setVisibleSessionTab(KEY, { kind: "terminal", id: `cloud:${WORKSPACE}:p1` }));
    expect(selectedRows()).toEqual(["Terminal 1"]);
    act(() => setVisibleSessionTab(KEY, { kind: "agent", id: "s1-tab" }));
    expect(selectedRows()).toEqual(["Claude Code"]);
    act(() => setVisibleSessionTab(KEY, null));
  });

  it("opens a row of another session on that tab", async () => {
    await listed([pty("p3", 3, "s2")]);
    act(() => sessions.selectCloudSession(KEY));
    mount();
    const other = `cloud:${ORG}:fix-login:s2`;
    expand("Add tests");
    fireEvent.click(within(sessionNode(other)).getByRole("treeitem", { name: "Terminal 3" }));
    expect(sessions.getSessionStore().selectedSessionId).toBe(other);
    expect(terminalStore.getTerminalState().selected[other]).toEqual({ kind: "terminal", id: `cloud:${WORKSPACE}:p3` });
    expect(within(sessionNode(other)).getByRole("treeitem", { name: "Terminal 3" }).getAttribute("aria-selected")).toBe("true");
    // The session left behind marks no tab.
    expect(selectedRows()).toEqual([]);
  });

  it('lists terminals that belong to no session once, as "Workspace terminals" (a runtime without pty/2)', async () => {
    await listed([pty("p1", 1), pty("p2", 2)]);
    mount();
    expand("Fix login redirect");
    expect(tabRows().map((row) => row.getAttribute("aria-label"))).toEqual(["Claude Code"]);
    const group = screen.getByTestId("cloud-workspace-terminals");
    expect(within(group).getByText("Workspace terminals")).toBeTruthy();
    const rows = within(group).getAllByRole("treeitem").filter((row) => row.hasAttribute("aria-controls"));
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Terminal 1", "Terminal 2"]);

    // Choosing one opens the workspace's own view on that terminal.
    fireEvent.click(rows[1]);
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe(WORKSPACE);
    expect(cloudTerminals.cloudTerminalsOf(WORKSPACE).selected).toBe(`cloud:${WORKSPACE}:p2`);
    // Its row is marked once that view shows the terminal.
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
    act(() => cloudTerminals.setCloudTerminalShown(WORKSPACE, true));
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
    expectNoAttachOrResume();
  });

  // The live re-test: after a share was revoked, a selected "Terminal 1" row stayed under the "Not shared" workspace.
  it("leaves no terminal, tab or session row behind when access is removed, and keeps the selection on the session's lock row", async () => {
    const shared = (role: string) => [item("fix-login", { repositories: [acmeApi], launch: { launchId: "l", phase: "running", state: "started", workBranch: "terminalx/fix-login-3f2a", agent: "claude", sessionId: "s1", tabId: "s1-tab", timings: {} }, you: { role, canApprove: false, canManageShares: false } })];
    await load(shared("driver"), { "fix-login": { sessions: [session("s1", "Fix login redirect"), session("s2", "Add tests")], capabilities: ["session/2"] } });
    await listed([pty("p1", 1, "s1"), pty("p9", 9)]);
    act(() => sessions.selectCloudSession(KEY));
    mount();
    fireEvent.click(within(sessionNode(KEY)).getByRole("treeitem", { name: "Terminal 1" }));
    expect(selectedRows()).toEqual(["Terminal 1"]);
    expect(screen.getByTestId("cloud-workspace-terminals")).toBeTruthy();

    // The runtime says role none (the share was revoked), then the list says so too.
    act(() => applyCollabEvent(WORKSPACE, { type: "you", you: { userId: "u-bob", role: "none", canApprove: false } }));
    expect(cloudTerminals.cloudTerminalsOf(WORKSPACE).terminals).toEqual([]);
    expect(screen.queryByRole("treeitem", { name: /^Terminal/ })).toBeNull();
    expect(screen.queryByTestId("cloud-workspace-terminals")).toBeNull();
    await act(async () => void (await catalog.ingestCloudList({ workspaces: shared("none"), quota: { used: 1, limit: 3 } }, ORG)));

    // One row, named after the workspace, for the session that is open: it shows the lock pane.
    const rows = screen.getAllByTestId("cloud-session-node");
    expect(rows.map((row) => row.getAttribute("data-session"))).toEqual([KEY]);
    expect(within(rows[0]).getByTestId("cloud-access-chip").textContent).toBe("Not shared");
    expect(within(rows[0]).queryByText("Fix login redirect")).toBeNull();
    expect(screen.queryByText("Add tests")).toBeNull();
    // No tab or terminal row at all, so none is selected; the session row itself is.
    expect(screen.getAllByRole("treeitem").filter((row) => row.hasAttribute("aria-controls"))).toEqual([]);
    expect(within(rows[0]).getByText("Not shared with you.")).toBeTruthy();
    expect(sessions.getSessionStore().selectedSessionId).toBe(KEY);
    expect(rows[0].querySelector("[data-tree-row]")!.className).toMatch(/\bbg-selected\b/);
    expect(terminalStore.getTerminalState().selected[KEY]).toBeUndefined();
    expect(catalog.getCloudCatalog().orgs[ORG].sessions["fix-login"]).toBeUndefined();

    // Whatever a window still holds of an unshared workspace (a read that landed late) is not listed either.
    await listed([pty("p1", 1, "s1"), pty("p9", 9)]);
    expect(screen.queryByRole("treeitem", { name: /^Terminal/ })).toBeNull();
    expect(screen.queryByTestId("cloud-workspace-terminals")).toBeNull();
    expectNoAttachOrResume();
  });

  it("shows a member a workspace that was never shared with them with no tab or terminal row", async () => {
    await catalog.ingestCloudList(
      { workspaces: [item("fix-login", { repositories: [acmeApi], launch: { launchId: "l", phase: "running", state: "started", workBranch: "terminalx/fix-login-3f2a", agent: "claude", sessionId: "s1", tabId: "s1-tab", timings: {} }, you: { role: "none", canApprove: false, canManageShares: false } })] },
      ORG,
    );
    await listed([pty("p1", 1, "s1"), pty("p9", 9)]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Expand fix-login" }));
    expect(screen.getAllByTestId("cloud-session-node")).toHaveLength(1);
    expect(screen.getAllByRole("treeitem").filter((row) => row.hasAttribute("aria-controls"))).toEqual([]);
    expect(screen.queryByTestId("cloud-workspace-terminals")).toBeNull();
    expect(within(sessionNode(KEY)).getByText("Not shared with you.")).toBeTruthy();
    expectNoAttachOrResume();
  });

  it("gives the title its first characters ahead of the chips, on cloud rows only", async () => {
    mount();
    // jsdom lays nothing out, so no width is set here; the WebKit layout check
    // (pnpm test:webkit-layout) measures it. The chips are what can shrink.
    const chip = within(sessionNode(KEY)).getByTestId("cloud-location-chip");
    expect(chip.className).toContain("shrink");
    expect(chip.className).not.toContain("shrink-0");
    expect(chip.getAttribute("title")).toContain("Cloud workspace fix-login");
  });
});
