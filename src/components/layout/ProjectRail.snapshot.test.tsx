import { act, cleanup, render } from "@testing-library/react";
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
const prefs = await import("@/lib/prefs");
const sessions = await import("@/lib/sessions");
const account = await import("@/lib/account");

const NOW = new Date("2026-09-30T12:00:00.000Z");
const projectPath = "/repos/raccoon";
const workspace: Workspace = {
  path: projectPath, name: "raccoon", branch: "main", head: "abc1234", isMain: true, managed: false,
  uncommitted: 0, additions: 2, deletions: 1, unpushed: 0, ahead: 0, behind: 0,
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

  it("with the kill switch off, a cloud organization draws the same sidebar as none", async () => {
    // React's generated ids differ between two mounts; nothing else may.
    const html = (element: HTMLElement) => element.innerHTML.replace(/radix-_r_[a-z0-9]+_/g, "radix-id");
    await setAccount(signedIn(withoutCloud));
    const before = html(mount().container);
    cleanup();
    act(() => prefs.setPrefs({ cloudSidebar: false }));
    try {
      await setAccount(signedIn(withCloud));
      expect(html(mount().container)).toBe(before);
    } finally {
      act(() => prefs.setPrefs({ cloudSidebar: true }));
    }
  });

  it("with a cloud organization, adds the Local header and one section per organization", async () => {
    await setAccount(signedIn(withCloud));
    const { container, getByTestId, getAllByTestId } = mount();
    expect(getByTestId("local-section-header").textContent).toBe("Local");
    expect(getAllByTestId("cloud-org-section").map((section) => section.getAttribute("data-org"))).toEqual(["org-a", "org-b"]);
    // The local projects are still drawn, above the organizations.
    expect(container.querySelector('[aria-label="Raccoon"]')).not.toBeNull();
  });
});
