import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// CS-5 (PRO-58): organization sections in the sidebar. Looking never costs
// money: rendering, expanding and selecting make no resume call, and render
// and expand make no attach call at all.

const mocks = vi.hoisted(() => ({
  api: {
    cloudWorkspaces: vi.fn(),
    cloudWorkspaceRepositories: vi.fn(),
    cloudWorkspaceResume: vi.fn(),
    cloudWorkspaceUnarchive: vi.fn(),
    cloudWorkspaceOperation: vi.fn(),
    cloudRemoteAttach: vi.fn(),
    cloudRemoteActivate: vi.fn(),
    cloudAgentPurgeWorkspace: vi.fn(),
    cloudCatalogLoad: vi.fn(),
    cloudCatalogSave: vi.fn(),
    organizationSelect: vi.fn(),
  },
  workspaceConnection: vi.fn(),
  ask: vi.fn(),
  refreshAccount: vi.fn(),
  status: null as unknown as AccountStatus,
  lifecycle: [] as { initial: string; item: CloudWorkspaceListItem }[],
}));

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
// The workspace view's terminals and agent tab have their own tests (CloudSessionPage.test.tsx).
vi.mock("@/components/cloud/CloudSessionPage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/cloud/CloudSessionPage")>()),
  WorkspaceView: () => <div data-testid="workspace-view" />,
}));

const { CloudSections } = await import("./CloudSections");
const { CloudWorkspaceMain } = await import("@/components/cloud/CloudWorkspaceMain");
const catalog = await import("@/lib/cloudCatalog");
const sessions = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");

const ORG = "org-a";
const repositories = [{ identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true }];
const launch = (workBranch: string) => ({ launchId: "l", phase: "running", state: "running", workBranch, agent: "claude", model: null, effort: null, mode: null, hasPrompt: true, category: null, sessionId: null, tabId: null, timings: {} });

function item(id: string, fields: Record<string, unknown>): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId: ORG, name: id, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, ...fields },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

const list = {
  workspaces: [
    item("fix-login", { repositories, launch: launch("terminalx/fix-login-3f2a9c01d4e7"), lastActivityAt: 50 }),
    item("perf-sweep", { state: "suspended", repositories, launch: launch("terminalx/perf-sweep-8be104c2a9f1"), lastActivityAt: 40 }),
    item("image-only", { repositories: [] }),
    item("old", { state: "archived", archivedAt: 1, deleteAfter: Date.now() + 12 * 86_400_000, repositories }),
  ],
};

const connection = { target: { kind: "cloud", organizationId: ORG, workspaceId: "perf-sweep" }, client: { onState: () => () => undefined }, activate: vi.fn(), close: vi.fn() };

function signIn() {
  mocks.status = {
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    organizations: [
      { id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: "org-b", name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: "org-c", name: "Gamma", role: "member", isPersonal: false, cloud: { enabled: false, flags: {} } },
    ],
  };
}

beforeEach(async () => {
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.workspaceConnection.mockReset().mockResolvedValue(connection);
  connection.activate.mockReset();
  mocks.ask.mockReset().mockResolvedValue(true);
  mocks.refreshAccount.mockReset().mockResolvedValue(undefined);
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  mocks.api.cloudWorkspaceResume.mockResolvedValue({ workspace: { ...list.workspaces[1].workspace }, operation: { id: "op", state: "running", action: "resume" } });
  mocks.lifecycle.length = 0;
  signIn();
  await catalog.ingestCloudList(list, ORG);
  act(() => sessions.selectCloudWorkspace(null));
});

afterEach(() => {
  cleanup();
  catalog.resetCloudCatalog();
});

const mount = () =>
  render(
    <TooltipProvider>
      <div role="tree">
        <CloudSections />
      </div>
    </TooltipProvider>,
  );

const row = (name: string) => screen.getAllByTestId("cloud-workspace-node").find((node) => node.getAttribute("data-workspace") === name)!;

/** A real mouse click: pointerdown, mousedown, pointerup, mouseup, click. */
function mouseClick(element: HTMLElement) {
  fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

function openMenu(name: string) {
  mouseClick(within(row(name)).getByRole("button", { name: `Actions for ${name}` }));
}

describe("organization sections", () => {
  it("draws the default organization first, then the others with a switch, and none without cloud", () => {
    mount();
    const sections = screen.getAllByTestId("cloud-org-section");
    expect(sections.map((section) => section.getAttribute("data-org"))).toEqual([ORG, "org-b"]);
    expect(within(sections[1]).getByTestId("cloud-org-switch").textContent).toBe("Switch");
    expect(within(sections[0]).queryByTestId("cloud-org-switch")).toBeNull();
  });

  it("keeps the default organization expanded and the others to one compact line, remembered per organization", () => {
    mount();
    const [acme, beta] = screen.getAllByTestId("cloud-org-section");
    expect(acme.getAttribute("aria-expanded")).toBe("true");
    expect(beta.getAttribute("aria-expanded")).toBe("false");
    // Collapsed: its body is hidden, so the section is its header line only.
    expect(within(beta).getByTestId("cloud-org-hint").closest("[hidden]")).not.toBeNull();
    expect(within(beta).getByTestId("cloud-org-role").textContent).toBe("member");
    fireEvent.click(within(beta).getByRole("button", { name: "Expand Beta organization" }));
    expect(prefs.getPrefs().sidebarSections["org:org-b"]).toBe("expanded");
    fireEvent.click(within(acme).getByRole("button", { name: "Collapse Acme organization" }));
    expect(prefs.getPrefs().sidebarSections["org:org-a"]).toBe("collapsed");
    cleanup();
    mount();
    const [acmeAgain, betaAgain] = screen.getAllByTestId("cloud-org-section");
    expect(acmeAgain.getAttribute("aria-expanded")).toBe("false");
    expect(betaAgain.getAttribute("aria-expanded")).toBe("true");
    act(() => prefs.setPrefs({ sidebarSections: {} }));
  });

  it("opens an organization's menu with a mouse click, keeps it open, and closes it with a second click", async () => {
    mount();
    const trigger = screen.getByRole("button", { name: "Menu for Acme" });
    mouseClick(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual(["Refresh cloud workspaces"]);
    // Still open after the whole click sequence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("menu")).toBe(menu);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The row keeps its actions shown while the menu is open, whatever the hover.
    expect(trigger.closest("span")!.className).toMatch(/(^| )flex( |$)/);
    mouseClick(trigger);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("opens an organization's menu from the keyboard", async () => {
    mount();
    const trigger = screen.getByRole("button", { name: "Menu for Beta" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Switch to show cloud sessions/ })).toBeTruthy();
  });

  it("keeps Switch a real, focusable button in a collapsed organization's row", () => {
    mount();
    const beta = screen.getAllByTestId("cloud-org-section")[1];
    const header = within(beta).getByTestId("cloud-org-header");
    const toggle = within(header).getByRole("button", { name: "Beta" });
    const switchButton = within(header).getByRole("button", { name: "Switch" });
    // Shown on hover and on focus within the row, and reached with Tab from the row's name.
    expect(switchButton.closest("span")!.className).toContain("group-focus-within/row:flex");
    const order = [...header.querySelectorAll<HTMLElement>("button")];
    expect(order.indexOf(switchButton)).toBeGreaterThan(order.indexOf(toggle));
    expect(switchButton.tabIndex).not.toBe(-1);
  });

  it("offers the switch in the organization's menu too", async () => {
    mount();
    mouseClick(screen.getByRole("button", { name: "Menu for Beta" }));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Switch to show cloud sessions/ }));
    await waitFor(() => expect(mocks.api.organizationSelect).toHaveBeenCalledWith("org-b", "s:1"));
  });

  it("shows a Ready and a Stopped workspace under their repository, with branch and state", () => {
    mount();
    const project = screen.getAllByTestId("cloud-project-row").find((node) => node.textContent?.includes("acme/api"))!;
    const tree = project.closest('[role="treeitem"]') as HTMLElement;
    const rows = within(tree).getAllByTestId("cloud-workspace-node");
    expect(rows.map((node) => node.getAttribute("data-workspace"))).toEqual(["fix-login", "perf-sweep"]);
    expect(within(rows[0]).getByTestId("cloud-workspace-row-state").textContent).toBe("Ready");
    expect(within(rows[1]).getByTestId("cloud-workspace-row-state").textContent).toBe("Stopped");
    expect(within(rows[0]).getByTestId("cloud-workspace-row-branch").textContent).toBe("terminalx/fix-login-3f2a9c01d4e7");
    expect(screen.getByTestId("cloud-node-other").textContent).toContain("Other workspaces (1)");
    expect(screen.getByTestId("cloud-node-archived").textContent).toContain("Archived workspaces (1)");
  });

  it("places a workspace from createMemory when the server lists no repositories", async () => {
    catalog.resetCloudCatalog();
    signIn();
    const created = item("remembered", {});
    await catalog.ingestCloudList({ workspaces: [created] }, ORG);
    catalog.rememberCreatedWorkspace({ workspace: created.workspace, operation: { id: "op" } as never }, [{ cloneUrl: "git@github.com:acme/web.git" }]);
    mount();
    const project = screen.getAllByTestId("cloud-project-row").find((node) => node.textContent?.includes("acme/web"))!;
    expect(within(project.closest('[role="treeitem"]') as HTMLElement).getAllByTestId("cloud-workspace-node")[0].getAttribute("data-workspace")).toBe("remembered");
  });

  it("rendering and expanding every node make 0 attach and 0 resume calls", () => {
    mount();
    for (let pass = 0; pass < 2; pass++) {
      for (const toggle of document.querySelectorAll<HTMLButtonElement>("[data-tree-toggle]")) fireEvent.click(toggle);
    }
    // Everything expanded is still drawn from the catalog.
    expect(screen.getAllByTestId("cloud-workspace-node").length).toBe(4);
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.api.cloudRemoteActivate).not.toHaveBeenCalled();
    expect(connection.activate).not.toHaveBeenCalled();
  });

  it("clicking a Stopped workspace shows it in the main slot without resuming it", async () => {
    mount();
    fireEvent.click(within(row("perf-sweep")).getByText("perf-sweep"));
    const key = sessions.getSessionStore().selectedCloudWorkspace!;
    expect(key).toBe(`cloud:${ORG}:perf-sweep`);
    expect(row("perf-sweep").getAttribute("aria-selected")).toBe("true");
    render(<CloudWorkspaceMain workspaceKey={key} sidebarOpen onToggleSidebar={() => undefined} />);
    await screen.findByTestId("workspace-view");
    expect(screen.getByTestId("cloud-stopped-banner")).toBeTruthy();
    // It connects to read saved conversations, never waking compute.
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: ORG, workspaceId: "perf-sweep" }, "connect");
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(connection.activate).not.toHaveBeenCalled();
  });

  it("a workspace that is still starting is shown without connecting", async () => {
    await catalog.ingestCloudList({ workspaces: [item("starting", { state: "provisioning", repositories })] }, ORG);
    render(<CloudWorkspaceMain workspaceKey={`cloud:${ORG}:starting`} sidebarOpen onToggleSidebar={() => undefined} />);
    expect(screen.getByTestId("cloud-workspace-main").textContent).toContain("Allocating");
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  });
});

describe("lifecycle menu", () => {
  it("offers Stop, Archive and Delete on a running workspace, through the existing dialog", async () => {
    mount();
    openMenu("fix-login");
    const menu = await screen.findByRole("menu");
    const labels = within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim());
    expect(labels).toEqual(["Stop", "Archive… (stops compute, deleted after 30 days)", "Delete…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Stop" }));
    await waitFor(() => expect(screen.getByTestId("lifecycle-dialog").textContent).toBe("stop"));
    expect(mocks.lifecycle.at(-1)!.item.workspace.id).toBe("fix-login");
  });

  it("offers Resume on a stopped workspace, and resumes only when chosen", async () => {
    mount();
    openMenu("perf-sweep");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual(["Resume", "Archive… (stops compute, deleted after 30 days)", "Delete…"]);
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Resume" }));
    await waitFor(() => expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledTimes(1));
    expect(mocks.api.cloudWorkspaceResume).toHaveBeenCalledWith("perf-sweep");
    // The row follows the operation at once.
    await waitFor(() => expect(within(row("perf-sweep")).getByTestId("cloud-workspace-row-state").textContent).toBe("Resuming"));
  });

  it("unarchives from the Archived workspaces node", async () => {
    mocks.api.cloudWorkspaceUnarchive.mockResolvedValue({ workspace: { ...list.workspaces[3].workspace, state: "suspended", archivedAt: null }, operation: { id: "op" } });
    mocks.api.cloudWorkspaces.mockResolvedValue(list);
    mocks.api.cloudWorkspaceRepositories.mockResolvedValue({ configured: true, repositories: [] });
    mount();
    fireEvent.click(within(screen.getByTestId("cloud-node-archived")).getByRole("button", { name: /Expand Archived/ }));
    openMenu("old");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual(["Unarchive", "Delete…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unarchive" }));
    await waitFor(() => expect(mocks.api.cloudWorkspaceUnarchive).toHaveBeenCalledWith("old"));
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });
});

describe("another organization", () => {
  it("switches after a warning, with today's organization switch", async () => {
    mount();
    fireEvent.click(screen.getByTestId("cloud-org-switch"));
    await waitFor(() => expect(mocks.api.organizationSelect).toHaveBeenCalledWith("org-b", "s:1"));
    expect(mocks.ask.mock.calls[0][0]).toContain("Cloud sessions open in Acme will close");
    expect(mocks.refreshAccount).toHaveBeenCalled();
  });

  it("does not switch when the warning is declined", async () => {
    mocks.ask.mockResolvedValue(false);
    mount();
    fireEvent.click(screen.getByTestId("cloud-org-switch"));
    await waitFor(() => expect(mocks.ask).toHaveBeenCalled());
    expect(mocks.api.organizationSelect).not.toHaveBeenCalled();
  });
});
