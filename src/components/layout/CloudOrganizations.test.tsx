import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import type { Project, SessionEntry } from "@/types/session";

// The cloud organizations in the chat-first sidebar: a section per
// organization after the local projects, its cloud projects folding to their
// sessions, drawn and worked like the local projects. Looking never wakes a
// workspace.

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), status: null as unknown as AccountStatus, resume: vi.fn(), workspaceConnection: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: { ...original.api, cloudWorkspaceResume: mocks.resume, cloudWorkspaces: vi.fn(), cloudCatalogLoad: vi.fn(), cloudCatalogSave: vi.fn(), cloudAgentPurgeWorkspace: vi.fn() },
    workspaceConnection: mocks.workspaceConnection,
    closeWorkspaceConnection: vi.fn(),
  };
});
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));

const { ProjectRail } = await import("./ProjectRail");
const store = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const catalog = await import("@/lib/cloudCatalog");
const { resetCloudSessions } = await import("@/lib/cloudSessions");

const ORG = "org-a";
const OTHER = "org-b";
const acmeApi = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };
const betaSite = { identity: "github.com/beta/site", fullName: "beta/site", cloneUrl: "https://github.com/beta/site.git", primary: true };
const chatsPath = "/store/Chats";
const projects: Project[] = [{ path: "/repos/web", name: "web", kind: "git" }];
const local: SessionEntry = {
  id: "here", projectPath: "/repos/web", cwd: "/repos/web", title: "Session here", created: "2026-10-01T00:00:00.000Z", modified: "2026-10-01T00:00:00.000Z", pinned: false, archived: false, worktreeRemoved: false, activeTab: "here-tab",
  tabs: [{ id: "here-tab", title: "Talk here", harness: "claude", model: "", permissionMode: "auto", status: "idle", created: "", modified: "" }],
};

function item(id: string, orgId: string, fields: Record<string, unknown> = {}): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId, name: id, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, repositories: [acmeApi], ...fields },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}
const session = (id: string, title: string, status: string, fields: Record<string, unknown> = {}) => ({
  id, projectPath: "/workspace", cwd: "/workspace", title, created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T11:00:00.000Z", archived: false, pinned: false,
  tabs: [{ id: `${id}-tab`, harness: "claude", title: null, model: "opus", permissionMode: "default", status, created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" }],
  ...fields,
});

beforeEach(async () => {
  prefs.setPrefs({ sidebarLayout: "simple", sidebarSections: {}, hiddenOrganizations: [], organizationDisplay: "all", selectedOrganization: null, cloudPinned: {}, cloudProjects: {}, cloudBlankProjects: {} });
  mocks.status = {
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    multiOrg: true,
    organizations: [
      { id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: OTHER, name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ],
  } as AccountStatus;
  mocks.resume.mockReset();
  mocks.workspaceConnection.mockReset();
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects, lastSelected: null };
    if (command === "list_sessions") return [local];
    if (command === "list_harnesses") return [];
    if (command === "chats_dir") return chatsPath;
    if (command === "list_workspaces") return [{ path: "/repos/web", name: "web", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }];
    if (command === "cloud_agent_cache_load") return { tabs: {} };
    if (command === "cloud_agent_outbox" || command === "cloud_agent_checkpoints" || command === "session_summaries") return [];
    return undefined;
  });
  await act(async () => {
    await store.bootSessions();
    await store.refreshEverything();
    store.selectSession(null);
    // Acme: two workspaces of one repository and a blank project; Beta: one workspace.
    await catalog.ingestCloudList({ workspaces: [item("ws-1", ORG), item("ws-2", ORG), item("image-only", ORG, { repositories: [] })], quota: { used: 3, limit: 5 } }, ORG);
    await catalog.ingestCloudList({ workspaces: [item("ws-b", OTHER, { repositories: [betaSite] })], quota: { used: 1, limit: 5 } }, OTHER);
  });
  catalog.cacheCloudSessions(ORG, "ws-1", [session("s1", "Fix login redirect", "idle", { branch: "terminalx/fix-login" })] as never, ["session/2"]);
  catalog.cacheCloudSessions(ORG, "ws-2", [session("s2", "Add tests", "in_progress")] as never, ["session/2"]);
  catalog.cacheCloudSessions(OTHER, "ws-b", [session("sb", "Landing page copy", "completed", { branch: "feature/landing" })] as never, ["session/2"]);
});
afterEach(() => {
  cleanup();
  catalog.resetCloudCatalog();
  resetCloudSessions();
});

const mount = () => render(<TooltipProvider><ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenStats={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /></TooltipProvider>);
const orgSection = (orgId: string) => screen.getAllByTestId("cloud-org-list").find((section) => section.getAttribute("data-org") === orgId)!;

describe("cloud organizations in the sidebar", () => {
  it("lists each organization after Local, its cloud projects folding to their sessions, in both layouts", async () => {
    mount();
    const list = screen.getByTestId("conversation-list");
    // Local first, then the organizations by name, as sections like the local one.
    const headings = within(list).getAllByRole("button", { name: /^(Local|Acme|Beta)$/ }).map((button) => button.textContent);
    expect(headings).toEqual(["Local", "Acme", "Beta"]);
    expect(within(list).queryByRole("button", { name: "Projects" })).toBeNull();
    const acme = orgSection(ORG);
    // A repository with two workspaces is one project; each workspace names its sessions. A blank project is listed by its name.
    expect(within(acme).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["acme/api", "image-only"]);
    const api = within(acme).getByRole("group", { name: "acme/api" });
    expect(within(api).getAllByTestId("cloud-workspace-group").map((row) => row.getAttribute("data-workspace"))).toEqual(["ws-1", "ws-2"]);
    const fix = within(api).getByRole("button", { name: /^Fix login redirect/ });
    // A row ends in its branch; a working one shows the working sign there instead.
    expect(fix.textContent).toContain("terminalx/fix-login");
    const adding = within(api).getByRole("button", { name: /^Add tests/ });
    expect(adding.querySelector('[data-testid="status-working"], [aria-label="Working"]') || adding.textContent === "Add tests").toBeTruthy();
    // Beta's one workspace lists its sessions directly under the project.
    const beta = orgSection(OTHER);
    expect(within(beta).queryAllByTestId("cloud-workspace-group")).toHaveLength(0);
    expect(within(within(beta).getByRole("group", { name: "beta/site" })).getByRole("button", { name: /^Landing page copy/ })).toBeTruthy();
    // Nothing was woken or connected to draw this.
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
    cleanup();

    prefs.setPrefs({ sidebarLayout: "list" });
    mount();
    expect(screen.getAllByTestId("cloud-org-list").map((section) => section.getAttribute("data-org"))).toEqual([ORG, OTHER]);
  });

  it("opens a session on click, starts one from a project's + for an admin only, and folds a project", async () => {
    mount();
    const api = within(orgSection(ORG)).getByRole("group", { name: "acme/api" });
    await act(async () => { fireEvent.click(within(api).getByRole("button", { name: /^Fix login redirect/ })); });
    expect(store.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:ws-1:s1`);
    expect(within(api).getByRole("button", { name: /^Fix login redirect/ }).getAttribute("aria-current")).toBe("true");
    // + on a project: the new-session form in that project. A member's project has no +.
    await act(async () => { fireEvent.click(within(api).getByRole("button", { name: "New session in acme/api" })); });
    expect(store.getSessionStore().cloudSessionPreset?.projectKey).toBe(`cloud:${ORG}:github.com/acme/api`);
    expect(within(orgSection(OTHER)).queryByRole("button", { name: /^New session in/ })).toBeNull();
    // Folding hides the sessions and is remembered with the other sidebar folds.
    await act(async () => { fireEvent.click(within(api).getByRole("button", { name: "Collapse acme/api" })); });
    expect(within(api).getByTestId("cloud-project-sessions").getAttribute("aria-hidden")).toBe("true");
    expect(prefs.getPrefs().sidebarSections[`cloud-project:cloud:${ORG}:github.com/acme/api`]).toBe("collapsed");
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  });

  it("narrows local and cloud alike from the View menu's Unread / Needs you, and leads back to everything", async () => {
    const { setSidebarFilter } = await import("@/lib/sidebarFilter");
    mount();
    expect(screen.getByRole("button", { name: "main, Talk here" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Needs you" }));
      await Promise.resolve();
    });
    try {
      // Nothing local waits on a person, and nothing in either organization does.
      expect(screen.queryByRole("button", { name: "main, Talk here" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Local" })).toBeNull();
      expect(within(orgSection(ORG)).getByTestId("cloud-org-filtered-empty").textContent).toBe("Nothing needs you.");
      expect(screen.getByRole("button", { name: "View: showing Needs you" }).getAttribute("data-filter")).toBe("needs");
      const empty = screen.getByTestId("sidebar-filter-empty");
      expect(empty.textContent).toContain("Nothing needs you.");
      await act(async () => { fireEvent.click(within(empty).getByRole("button", { name: "Show all sessions" })); });
      expect(screen.getByRole("button", { name: "main, Talk here" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
    } finally {
      act(() => setSidebarFilter("all"));
    }
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  });
});
