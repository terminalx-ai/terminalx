import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus } from "@/lib/api";
import type { Project, SessionEntry, Workspace } from "@/types/session";

// A DOM snapshot of the whole sidebar rail (destinations, the project list
// header, projects and the account entry). It was recorded before the
// organization sections (PRO-58) were added: signed out, or signed in with no
// organization that has cloud workspaces enabled, the sidebar must stay
// exactly as it was.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  account: null as unknown as AccountStatus,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set() }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));

const { ProjectRail } = await import("./ProjectRail");
const sessions = await import("@/lib/sessions");
const account = await import("@/lib/account");

const NOW = new Date("2026-09-30T12:00:00.000Z");
const projectPath = "/repos/raccoon";
const workspace: Workspace = {
  path: projectPath, name: "raccoon", branch: "main", head: "abc1234", isMain: true, managed: false,
  uncommitted: 0, additions: 2, deletions: 1, unpushed: 0, ahead: 0, behind: 0, state: "merged", sizeBytes: 8192,
};
const projects: Project[] = [{ path: projectPath, name: "Raccoon", pinned: true }, { path: "/notes", name: "Notes", kind: "folder" }];
const sessionList: SessionEntry[] = [
  {
    id: "s1", projectPath, cwd: projectPath, worktreeRemoved: false, title: "Fix scroll snapping",
    created: "2026-09-29T00:00:00.000Z", modified: "2026-09-30T11:58:00.000Z", archived: false, pinned: false,
    tabs: [{ id: "t1", harness: "claude", title: null, model: "opus", permissionMode: "auto", status: "in_progress", created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" }],
    activeTab: "t1",
  },
];

const signedIn = (organizations: AccountStatus["organizations"]): AccountStatus => ({
  state: "signed-in",
  identity: { name: "Ada", email: "ada@example.com", organization: "Acme", organizationId: "org-a" },
  expiresAt: null,
  lastError: null,
  context: { scope: "scope", revision: "scope:1" },
  organizations,
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  mocks.account = { state: "signed-out", identity: null, expiresAt: null, lastError: null };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects, lastSelected: projectPath };
    if (command === "list_sessions") return sessionList;
    if (command === "list_harnesses") return [{ id: "claude", name: "Claude", available: true }];
    if (command === "list_workspaces") return [workspace];
    if (command === "account_status") return mocks.account;
    if (command === "list_automations") return [];
    return null;
  });
  await act(async () => {
    await sessions.bootSessions();
    await sessions.refreshEverything();
    await account.bootAccount();
  });
});
afterEach(cleanup);
afterAll(() => vi.useRealTimers());

const noop = () => {};
const mount = () =>
  render(
    <TooltipProvider>
      <ProjectRail
        onOpenSettings={noop}
        onOpenAccount={noop}
        onOpenIssues={noop}
        onOpenAgents={noop}
        onOpenStats={noop}
        onOpenAutomations={noop}
        onOpenSkills={noop}
        onSearch={noop}
      />
    </TooltipProvider>,
  );

async function setAccount(status: AccountStatus) {
  mocks.account = status;
  await act(async () => {
    await account.refreshAccount();
  });
}

describe("sidebar rail DOM", () => {
  it("signed out", async () => {
    await setAccount({ state: "signed-out", identity: null, expiresAt: null, lastError: null });
    expect(mount().container).toMatchSnapshot();
  });

  it("signed in, with no organization that has cloud workspaces enabled", async () => {
    await setAccount(
      signedIn([
        { id: "org-a", name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: false, flags: {} } },
        { id: "org-old", name: "Old", role: "member" },
      ]),
    );
    expect(mount().container).toMatchSnapshot();
  });

  // Added with the organization sections (PRO-58): the snapshots above are unchanged, and these compare against them.
  const withoutCloud = [
    { id: "org-a", name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: false, flags: {} } },
    { id: "org-old", name: "Old", role: "member" },
  ];
  const withCloud = [
    { id: "org-a", name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
    { id: "org-b", name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
  ];

  it("with a cloud organization, adds the Local header and one section per organization", async () => {
    await setAccount(signedIn(withCloud));
    const { container, getByTestId, getAllByTestId } = mount();
    expect(getByTestId("local-section-header").textContent).toBe("Local");
    expect(getAllByTestId("cloud-org-section").map((section) => section.getAttribute("data-org"))).toEqual(["org-a", "org-b"]);
    // The local projects are still drawn, above the organizations.
    expect(container.querySelector('[aria-label="Raccoon"]')).not.toBeNull();
  });

  it("LOCAL is unchanged by cloud projects, their sessions and a selected cloud session (PRO-61)", async () => {
    const html = (element: Element) => element.outerHTML.replace(/radix-_r_[a-z0-9]+_/g, "radix-id");
    const localProjects = (container: HTMLElement) => [...container.querySelectorAll('[role="treeitem"][aria-label="Raccoon"], [role="treeitem"][aria-label="Notes"]')].map(html);
    await setAccount(signedIn(withoutCloud));
    const before = localProjects(mount().container);
    cleanup();
    await setAccount(signedIn(withCloud));
    act(() => sessions.selectCloudSession("cloud:org-a:ws-1:s-1"));
    try {
      const { container } = mount();
      expect(localProjects(container)).toEqual(before);
    } finally {
      act(() => sessions.selectSession(null));
    }
  });

  it("scrolls Local and every organization section in one container between the fixed top and the fixed footer (PRO-61)", async () => {
    for (const orgs of [withoutCloud, withCloud]) {
      await setAccount(signedIn(orgs));
      const { getByTestId } = mount();
      const rail = getByTestId("sidebar-rail");
      const tree = getByTestId("sidebar-tree");
      const classes = (element: Element) => element.className.split(/\s+/);
      // The rail is held to the window's height; only the tree scrolls.
      expect(classes(rail)).toEqual(expect.arrayContaining(["flex-col", "h-full", "min-h-0", "overflow-hidden"]));
      expect(classes(tree)).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "basis-0", "overflow-y-auto"]));
      // Everything else in the rail keeps its size.
      for (const child of [...rail.children].filter((element) => element !== tree)) expect(classes(child)).toContain("shrink-0");
      // Local and the organization sections are inside that one container.
      expect(tree.querySelector('[aria-label="Raccoon"]')).not.toBeNull();
      if (orgs === withCloud) expect(tree.querySelectorAll('[data-testid="cloud-org-section"]').length).toBe(2);
      cleanup();
    }
  });

  it("marks only the destination the main slot shows as active", async () => {
    await setAccount(signedIn(withCloud));
    const { getByRole } = mount();
    const active = () =>
      ["Issues", "Agent Dashboard", "Stats & Usage", "Automations", "Skills"].filter((label) =>
        getByRole("button", { name: new RegExp(`^${label.replace(/[&]/g, "\\$&")}`) }).className.split(" ").includes("bg-selected"),
      );
    act(() => sessions.openIssues());
    expect(active()).toEqual(["Issues"]);
    act(() => sessions.selectCloudWorkspace("cloud:org-a:ws-1"));
    expect(active()).toEqual([]);
    act(() => sessions.openIssues());
    act(() => sessions.selectSession(null));
    expect(active()).toEqual([]);
  });

  it("Refresh all also re-reads the account, so organizations and a changed role appear", async () => {
    const { getByRole } = mount();
    mocks.invoke.mockClear();
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Refresh all" }));
    });
    // Its organizations and roles are asked of the account service at once, not left to the throttle.
    expect(mocks.invoke.mock.calls).toContainEqual(["account_refresh_roles", { force: true }]);
  });
});
