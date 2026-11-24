import { fileManager } from "@/lib/platform";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project, SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
// Confirmations are the app's own dialog (PRO-400): one request object, answered true or false.
vi.mock("@/lib/confirm", () => ({ confirmInApp: vi.fn(), chooseInApp: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));

const { ProjectRail } = await import("./ProjectRail");
const { orderConversations } = await import("./SessionSidebar");
const store = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const selection = await import("@/lib/rowSelection");
const privacy = await import("@/lib/dataPrivacy");

const chatsPath = "/store/Chats";
const projects: Project[] = [{ path: "/repos/web", name: "web", kind: "git" }];
const session = (id: string, projectPath: string, modified: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  id, projectPath, cwd: projectPath, title: `Session ${id}`, created: modified, modified, pinned: false, archived: false, worktreeRemoved: false, activeTab: `${id}-tab`,
  tabs: [{ id: `${id}-tab`, title: `Talk ${id}`, harness: "claude", model: "", permissionMode: "auto", status: "idle", created: "", modified: "" }],
  ...extra,
});
let sessions: SessionEntry[];

beforeEach(async () => {
  // Folds are remembered; each test starts from the defaults.
  prefs.setPrefs({ sidebarLayout: "simple", sidebarSections: {}, branchSessions: "sidebar" });
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: unknown) => {
    if (command === "data_privacy_status") return { enabled: false, managed: false };
    if (command === "list_projects") return { projects, lastSelected: null };
    if (command === "list_sessions") return sessions;
    // As the backend answers: the sessions as they are now, archived or back.
    if (command === "set_sessions_archived") {
      const { sessionIds, archived } = args as { sessionIds: string[]; archived: boolean };
      sessions = sessions.map((entry) => (sessionIds.includes(entry.id) ? { ...entry, archived, autoArchived: false } : entry));
      return sessionIds.map((id) => sessions.find((entry) => entry.id === id)!);
    }
    if (command === "list_harnesses") return [];
    if (command === "chats_dir") return chatsPath;
    if (command === "list_workspaces") return [{ path: "/repos/web", name: "web", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }];
    return undefined;
  });
  // AppShell normally loads native policy before mounting these components.
  await privacy.refreshDataPrivacy();
});
afterEach(cleanup);

const mount = () => render(<TooltipProvider><ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenHome={store.openHome} onNewSession={() => {}} onOpenIssues={() => {}} onOpenAgents={store.openAgents} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /></TooltipProvider>);
const rowsIn = (element: HTMLElement) => within(element).getAllByRole("listitem").map((row) => row.querySelector("[title]")?.getAttribute("title"));

async function boot(list: SessionEntry[]) {
  sessions = list;
  await act(async () => {
    await store.bootSessions();
    await store.refreshEverything();
  });
}

describe("new-chat entry points", () => {
  it("announces manual status alongside the branch row's accessible name", async () => {
    await boot([session("here", "/repos/web", new Date().toISOString(), { manualStatus: "in_review" })]);
    mount();
    expect(screen.getByRole("button", { name: "main, Talk here", description: /Status: In review$/ })).toBeTruthy();
  });

  it("opens the composer from the New session destination and a project's +, without creating a session", async () => {
    await boot([session("here", "/repos/web", new Date().toISOString())]);
    const onNewSession = vi.fn();
    render(<TooltipProvider><ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenHome={store.openHome} onNewSession={onNewSession} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /></TooltipProvider>);
    // The titlebar only hides the sidebar: New session and Search are destinations (02.01).
    expect(within(screen.getByTestId("sidebar-titlebar")).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Hide sidebar"]);
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Destinations" })).getByRole("button", { name: "New session" }));
    expect(onNewSession).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "New chat in web" }));
    expect(store.getSessionStore()).toMatchObject({ view: "new", newSessionChat: false, newSessionPreset: { projectPath: "/repos/web", cwd: null }, selectedSessionId: null });
    expect(mocks.invoke.mock.calls.some(([command]) => ["create_session", "create_quick_chat"].includes(command))).toBe(false);
  });
});

describe("Home navigation (#1103)", () => {
  it.each(["simple", "list"] as const)("returns from a session by mouse and keyboard in the %s sidebar", async (sidebarLayout) => {
    const { useShortcut } = await import("@/lib/hotkeys");
    function HomeShortcut() {
      useShortcut("app.home", store.openHome);
      return null;
    }
    await boot([session("here", "/repos/web", "2026-11-05T00:00:00Z")]);
    prefs.setPrefs({ sidebarLayout, shortcuts: {} });
    store.selectSession("here");
    mount();
    render(<HomeShortcut />);
    const home = screen.getByRole("button", { name: "Home" });
    expect(home.getAttribute("aria-pressed")).toBe("false");
    expect(home.textContent).toContain("Ctrl+Alt+0");
    fireEvent.click(home);
    expect(store.getSessionStore().view).toBe("home");
    expect(store.getSessionStore().selectedSessionId).toBeNull();
    expect(home.getAttribute("aria-pressed")).toBe("true");

    act(() => store.selectSession("here"));
    expect(home.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(window, { key: "0", code: "Digit0", ctrlKey: true, altKey: true });
    expect(store.getSessionStore().view).toBe("home");
    expect(store.getSessionStore().selectedSessionId).toBeNull();
    expect(home.getAttribute("aria-pressed")).toBe("true");
    expect(store.getSessionStore().sessions).toHaveLength(1);
  });
});

describe("Overview navigation (PRO-183, PRO-384)", () => {
  it.each(["simple", "list"] as const)("returns from a session in the %s sidebar", async (sidebarLayout) => {
    await boot([session("here", "/repos/web", "2026-11-05T00:00:00Z")]);
    prefs.setPrefs({ sidebarLayout });
    store.selectSession("here");
    mount();
    const home = screen.getByRole("button", { name: /^Overview/ });
    expect(home.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(home);

    expect(store.getSessionStore().view).toBe("agents");
    expect(store.getSessionStore().selectedSessionId).toBeNull();
    expect(home.getAttribute("aria-pressed")).toBe("true");
    expect(store.getSessionStore().sessions).toHaveLength(1);
  });
});

describe("a project's picture", () => {
  it("is the picture of whoever owns the repository on GitHub, until it has a look of its own", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "github_identity") return { login: "trade100x", source: "ssh", email: null, repo: "acme-inc/web" };
      return base(command, args);
    });
    await boot([session("here", "/repos/web", new Date(Date.UTC(2026, 9, 1)).toISOString())]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    const avatar = await within(web).findByTestId("project-avatar");
    expect(avatar.getAttribute("src")).toBe("https://github.com/acme-inc.png?size=32");
    expect(avatar.getAttribute("title")).toBe("On GitHub as acme-inc/web");
    // The project's first lookup refreshes native metadata for this policy generation.
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "github_identity").map(([, args]) => args)).toEqual([{ projectPath: "/repos/web", refresh: true }]);
  });
});

describe("a project's fold", () => {
  it("folds its branches away by the chevron at the row's end and remembers it, the picture staying put", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    await boot([session("here", "/repos/web", at(1)), session("there", "/repos/web", at(2), { branch: "dev" })]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    expect(within(web).getAllByRole("listitem").length).toBeGreaterThan(0);
    const fold = within(web).getByRole("button", { name: "Collapse web" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { fireEvent.click(fold); });
    // The rows stay in the tree so they can slide away; folded, they are hidden from readers and keyboards alike.
    const branches = within(web).getByTestId("project-branches");
    expect(branches.getAttribute("aria-hidden")).toBe("true");
    expect(branches.hasAttribute("inert")).toBe(true);
    expect(branches.getAttribute("class")).toContain("grid-rows-[0fr]");
    expect(within(web).getByRole("button", { name: "Expand web" }).getAttribute("aria-expanded")).toBe("false");
    // Folded, the chevron points at the name; the fold is kept with the other sidebar sections.
    expect(within(web).getByTestId("project-fold").getAttribute("class")).toContain("-rotate-90");
    // The chevron is the row's last control, after the hover actions; the picture is never faded out for it (PRO-373).
    const header = within(web).getByRole("button", { name: "Expand web" }).parentElement!;
    expect(header.lastElementChild).toBe(within(web).getByRole("button", { name: "Expand web" }));
    expect(header.querySelector("[data-row-actions]")!.compareDocumentPosition(header.lastElementChild!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prefs.getPrefs().sidebarSections["project:/repos/web"]).toBe("collapsed");
    await act(async () => { fireEvent.click(within(web).getByRole("button", { name: "Expand web" })); });
    expect(within(web).getByTestId("project-branches").getAttribute("class")).toContain("grid-rows-[1fr]");
  });
});

describe("project context menus (PRO-187)", () => {
  it.each(["right-click", "Shift+F10", "menu button"])("opens the project's actions with %s", async (input) => {
    await boot([session("here", "/repos/web", "2026-11-05T00:00:00Z")]);
    mount();
    const title = screen.getByRole("button", { name: "web overview" });
    if (input === "right-click") fireEvent.contextMenu(title);
    else if (input === "Shift+F10") fireEvent.keyDown(title, { key: "F10", shiftKey: true });
    else fireEvent.click(screen.getByRole("button", { name: "Project menu for web" }));
    const menu = await screen.findByRole("menu");
    // The designed project menu (02.14, PRO-386), with the project's appearance and pipeline kept beside its settings.
    const { shortcutKeys } = await import("@/lib/hotkeys");
    const { joinKeycaps } = await import("@/lib/shortcuts");
    const keys = (action: Parameters<typeof shortcutKeys>[0]) => joinKeycaps(shortcutKeys(action));
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      `New session${keys("app.newSession")}`, `Start from a branch, issue or PR…${keys("app.startFrom")}`,
      "Project settings", "Scripts and actions", "Name and appearance", "Issue pipeline…", "Open in",
      "Pin project", "Hide projectHidden from the sidebar; sessions keep running", "Remove project…The folder on disk is left as it is.",
    ]);
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Open in" }), { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: fileManager }));
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    expect(revealItemInDir).toHaveBeenCalledWith("/repos/web");
  });

  it.each(([
    "simple", "list",
  ] as const).flatMap((sidebarLayout) => [false, true].map((linked) => ({ sidebarLayout, linked }))))("shares the conversation's ⋯ actions with right-click and Shift+F10 in the $sidebarLayout sidebar (linked: $linked)", async ({ sidebarLayout, linked }) => {
    await boot([session("here", "/repos/web", "2026-11-05T00:00:00Z", {
      branch: "main", worktreeName: "feature",
      ...(linked ? { issue: { provider: "github", id: "187", identifier: "#187", title: "Context menus", url: "https://github.com/acme/web/issues/187" }, issueWork: { private: true } } : {}),
    })]);
    prefs.setPrefs({ sidebarLayout });
    mount();
    const title = screen.getByRole("button", { name: sidebarLayout === "simple" ? "main, Talk here" : "Talk here" });
    const items = (menu: HTMLElement) => [...menu.querySelectorAll('[role^="menuitem"]')].map((item) => ({
      role: item.getAttribute("role"), label: item.textContent?.trim(), checked: item.getAttribute("aria-checked"),
    }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Menu for Talk here" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    let menu = await screen.findByRole("menu");
    const expected = items(menu);
    expect(within(menu).getByRole("menuitem", { name: /^Remove workspace…/ })).toBeTruthy();
    // The issue and PR links are a submenu away (PRO-386).
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Issue and pull request" }), { key: "ArrowRight" });
    expect(await screen.findByRole("menuitem", { name: linked ? "Unlink #187" : "Link to issue…" })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: "Don’t share this session" }).getAttribute("aria-checked")).toBe(String(linked));
    for (const input of ["right-click", "Shift+F10"]) {
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      if (input === "right-click") fireEvent.contextMenu(title);
      else fireEvent.keyDown(title, { key: "F10", shiftKey: true });
      menu = await screen.findByRole("menu");
      expect(items(menu), input).toEqual(expected);
    }
  });
});

describe("project menu and listing (PRO-386)", () => {
  it("says a project whose chats are all archived has them, and shows them on a click", async () => {
    await boot([session("old", "/repos/web", "2026-11-05T00:00:00Z", { archived: true })]);
    mount();
    expect(screen.queryByText("No chats yet")).toBeNull();
    fireEvent.click(screen.getByTestId("only-archived"));
    expect(store.getSessionStore().showArchived).toBe(true);
    expect(await screen.findByTestId("archived-sessions")).toBeTruthy();
    act(() => store.setShowArchived(false));
  });

  it("opens Start from a branch, issue or PR, and each settings page, for the project", async () => {
    await boot([session("here", "/repos/web", "2026-11-05T00:00:00Z")]);
    const { onProjectSettingsRequest } = await import("@/lib/projectAdded");
    const requested = vi.fn();
    const stop = onProjectSettingsRequest(requested);
    mount();
    const pick = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Project menu for web" }));
      fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: new RegExp(`^${name}`) }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    };
    const before = store.getSessionStore().startFromRequest;
    await pick("Start from a branch, issue or PR…");
    expect(store.getSessionStore()).toMatchObject({ view: "new", newSessionPreset: { projectPath: "/repos/web", cwd: null }, startFromRequest: before + 1 });
    await pick("Project settings");
    await pick("Scripts and actions");
    expect(requested.mock.calls).toEqual([["/repos/web", "general"], ["/repos/web", "scripts"]]);
    stop();
  });

  it("hides a project from the sidebar, and its hidden line shows it again", async () => {
    let hidden = false;
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_projects") return { projects: [{ ...projects[0], hidden }], lastSelected: null };
      if (command === "update_project") {
        hidden = !!(args as { patch: { hidden?: boolean } }).patch.hidden;
        return { ...projects[0], hidden };
      }
      return base(command, args);
    });
    await boot([session("here", "/repos/web", "2026-11-05T00:00:00Z")]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Project menu for web" }));
    await act(async () => fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Hide project/ })));
    expect(mocks.invoke).toHaveBeenCalledWith("update_project", expect.objectContaining({ patch: { hidden: true } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "web overview" })).toBeNull());
    fireEvent.click(within(screen.getByTestId("hidden-projects")).getByRole("button", { name: /1 hidden project/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show web in the sidebar" })));
    expect(await screen.findByRole("button", { name: "web overview" })).toBeTruthy();
  });
});

describe("the conversation list", () => {
  it("puts each conversation under the project it is linked to, a chat by the repo its agent works in, and the rest under Chats", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    await boot([
      session("chat", chatsPath, at(3)),
      session("work", "/repos/web", at(2), { worktreeName: "fix-login", branch: "raccoon/fix-login" }),
      session("here", "/repos/web", at(1)),
      session("gone", chatsPath, at(4), { archived: true }),
      session("follow", chatsPath, at(0), { link: { path: "/repos/web", branch: "feature/new-work" } }),
    ]);
    mount();

    // Under a project, a conversation alone on its branch is named by the branch.
    const web = screen.getByRole("group", { name: "web" });
    expect(within(web).getAllByRole("button", { name: /, Talk/ }).map((row) => row.getAttribute("aria-label"))).toEqual([
      "raccoon/fix-login, Talk work",
      "main, Talk here",
      "feature/new-work, Talk follow",
    ]);
    expect(rowsIn(screen.getByRole("region", { name: "Chats" }))).toEqual(["Talk chat"]);
  });

  it("names the branch a conversation in the shared checkout worked on, not where another one has since switched it", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    // The checkout is on main now; one conversation started on release, one last worked on dev.
    await boot([
      session("kept", "/repos/web", at(2), { branch: "release" }),
      session("moved", "/repos/web", at(1), { branch: "release", link: { path: "/repos/web", branch: "dev" } }),
    ]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    expect(within(web).getAllByRole("button", { name: /, Talk/ }).map((row) => row.getAttribute("aria-label"))).toEqual(["release, Talk kept", "dev, Talk moved"]);
  });

  it("opens the composer on a branch from its row without creating a session", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    await boot([
      session("here", "/repos/web", at(1)),
      session("gone-branch", "/repos/web", at(2), { branch: "old" }),
      session("tree", "/repos/web", at(3), { worktreeName: "fix-login", branch: "raccoon/fix-login", cwd: "/repos/web/.worktrees/fix-login" }),
    ]);
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_harnesses") return [{ id: "claude", name: "Claude", available: true }];
      if (command === "create_session") return session("new", "/repos/web", at(3));
      return base(command, args);
    });
    await act(async () => { await store.refreshHarnesses(); });
    mount();
    const web = screen.getByRole("group", { name: "web" });
    await act(async () => { fireEvent.click(within(web).getByRole("button", { name: "New session on main" })); });
    expect(store.getSessionStore().newSessionPreset).toEqual({ projectPath: "/repos/web", cwd: "/repos/web" });
    // A branch checked out nowhere keeps its base branch until the first prompt.
    expect(within(web).queryByRole("button", { name: "New session on old" })).toBeNull();
    await act(async () => { fireEvent.click(within(web).getByRole("button", { name: "New workspace from old" })); });
    expect(store.getSessionStore().newSessionPreset).toEqual({ projectPath: "/repos/web", cwd: null, fromBranch: "old" });
    // A worktree's branch has its folder, listed or not.
    await act(async () => { fireEvent.click(within(web).getByRole("button", { name: "New session on raccoon/fix-login" })); });
    expect(store.getSessionStore().newSessionPreset).toEqual({ projectPath: "/repos/web", cwd: "/repos/web/.worktrees/fix-login" });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
  });

  it("ticks the branch icon of a branch whose commits are in the default branch", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    const base = mocks.invoke.getMockImplementation()!;
    const checkout = (branch: string, state: string) => ({ path: `/repos/web/.worktrees/${branch}`, name: branch, branch, head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0, state });
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_workspaces") return [...(await base(command, args)), checkout("done", "merged"), checkout("open", "unmerged")];
      return base(command, args);
    });
    await boot([
      session("done", "/repos/web", at(1), { branch: "done", worktreeName: "done", cwd: "/repos/web/.worktrees/done" }),
      session("open", "/repos/web", at(2), { branch: "open", worktreeName: "open", cwd: "/repos/web/.worktrees/open" }),
    ]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    expect(within(web).getAllByRole("button", { name: /, Talk/ }).map((row) => row.getAttribute("aria-label"))).toEqual(["open, Talk open", "done (merged), Talk done"]);
  });

  it("ticks a branch merged with a merge commit too, but not a new one that has nothing of its own yet", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    const base = mocks.invoke.getMockImplementation()!;
    const tree = (name: string, head: string) => ({ path: `/repos/web/.worktrees/${name}`, name, branch: name, head, isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0, state: "clean" });
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_workspaces") return [...(await base(command, args)), tree("landed", "bbb"), tree("fresh", "aaa")];
      return base(command, args);
    });
    const made = { fetched: true, warning: null, commit: "aaa" };
    await boot([
      session("landed", "/repos/web", at(2), { branch: "landed", worktreeName: "landed", cwd: "/repos/web/.worktrees/landed", worktreeBase: made }),
      session("fresh", "/repos/web", at(1), { branch: "fresh", worktreeName: "fresh", cwd: "/repos/web/.worktrees/fresh", worktreeBase: made }),
    ]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    expect(within(web).getAllByRole("button", { name: /, Talk/ }).map((row) => row.getAttribute("aria-label"))).toEqual(["landed (merged), Talk landed", "fresh, Talk fresh"]);
  });

  it("adds a project from the Projects header: a folder, a GitHub clone, or a new empty one", async () => {
    await boot([session("a", "/repos/web", new Date(Date.UTC(2026, 9, 1)).toISOString())]);
    mount();
    const trigger = screen.getByRole("button", { name: "Add a project" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["Open local project", "Open GitHub project", "Quick start"]);
  });

  it("names a worktree by what its agent has checked out there now, a bare commit included", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    const base = mocks.invoke.getMockImplementation()!;
    const tree = (name: string, branch: string | null, head: string) => ({ path: `/repos/web/.worktrees/${name}`, name, branch, head, isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 });
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_workspaces") return [...(await base(command, args)), tree("panda", null, "3657040abcdef"), tree("crane", "feat/other", "abc1234")];
      return base(command, args);
    });
    await boot([
      session("panda", "/repos/web", at(2), { branch: "raccoon/panda", worktreeName: "panda", cwd: "/repos/web/.worktrees/panda" }),
      session("crane", "/repos/web", at(1), { branch: "raccoon/crane", worktreeName: "crane", cwd: "/repos/web/.worktrees/crane" }),
    ]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    expect(within(web).getAllByRole("button", { name: /, Talk/ }).map((row) => row.getAttribute("aria-label"))).toEqual(["detached at 3657040, Talk panda", "feat/other, Talk crane"]);
  });

  it("calls a worktree by its conversation's title until its branch has a name somebody gave it", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    const base = mocks.invoke.getMockImplementation()!;
    const tree = (name: string, branch: string, placeholder: boolean) => ({ path: `/repos/web/.worktrees/${name}`, name, branch, head: "abc1234", isMain: false, managed: true, placeholder, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 });
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_workspaces") return [...(await base(command, args)), tree("calm-ember-panda", "dc/calm-ember-panda", true), tree("crane", "dc/prd", false)];
      return base(command, args);
    });
    await boot([
      session("panda", "/repos/web", at(2), { branch: "dc/calm-ember-panda", worktreeName: "calm-ember-panda", cwd: "/repos/web/.worktrees/calm-ember-panda" }),
      session("crane", "/repos/web", at(1), { branch: "dc/crane", worktreeName: "crane", cwd: "/repos/web/.worktrees/crane" }),
    ]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    expect(within(web).getByRole("button", { name: "dc/prd, Talk crane" })).toBeTruthy();
    expect(within(web).queryByText("dc/calm-ember-panda")).toBeNull();
    expect(within(web).getByRole("button", { name: /^Talk panda/ })).toBeTruthy();
  });

  it("lists a project just added before it has any chat, newest first, and says it has none yet", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_projects") return { projects: [...projects, { path: "/repos/june", name: "june", kind: "git", lastOpened: "2026-10-21T07:00:00Z" }], lastSelected: null };
      return base(command, args);
    });
    await boot([session("a", "/repos/web", new Date(Date.UTC(2026, 9, 1)).toISOString())]);
    mount();
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-label")).filter((name) => name === "web" || name === "june")).toEqual(["june", "web"]);
    expect(within(screen.getByRole("group", { name: "june" })).getByText("No chats yet")).toBeTruthy();
  });

  it("opens the project's overview from its name, and folds it only from its picture", async () => {
    await boot([session("a", "/repos/web", new Date(Date.UTC(2026, 9, 1)).toISOString())]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    await act(async () => { fireEvent.click(within(web).getByRole("button", { name: "web overview" })); });
    expect(store.getSessions().view).toBe("project");
    expect(store.getSessions().selectedProject).toBe("/repos/web");
    expect(within(web).getByRole("button", { name: "web overview" }).getAttribute("aria-current")).toBe("page");
    // Opening it left the project as it was folded.
    expect(within(web).getByRole("button", { name: "Collapse web" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("removes a project from its menu after asking, archiving its conversations rather than deleting them", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    await boot([session("here", "/repos/web", at(1)), session("there", "/repos/web", at(2), { branch: "old" }), session("done", "/repos/web", at(3), { archived: true })]);
    const dialog = await import("@/lib/confirm");
    vi.mocked(dialog.confirmInApp).mockResolvedValue(true);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Project menu for web" }));
    await act(async () => { fireEvent.click(await screen.findByRole("menuitem", { name: /^Remove project…/ })); });
    expect(vi.mocked(dialog.confirmInApp).mock.calls[0][0]).toEqual({ title: "Remove web from TerminalX?", body: "Its 2 conversations are archived (View → Show archived lists them), and the folder on disk is left as it is.", action: "Remove", destructive: true });
    // Archived together, in one change, before the project goes.
    const calls = mocks.invoke.mock.calls.filter(([command]) => command === "set_sessions_archived" || command === "remove_project").map(([command, args]) => [command, args]);
    expect(calls).toEqual([["set_sessions_archived", { sessionIds: ["there", "here"], archived: true }], ["remove_project", { path: "/repos/web" }]]);
    expect(screen.queryByRole("group", { name: "web" })).toBeNull();
  });

  it("draws no agent mark on a row, even when the conversations use more than one agent", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    const codex = (entry: SessionEntry) => ({ ...entry, tabs: entry.tabs.map((tab) => ({ ...tab, harness: "codex" })) });
    // A row is its name and its age; which agent runs it is in the chat.
    await boot([session("one", chatsPath, at(1)), codex(session("two", chatsPath, at(2)))]);
    mount();
    expect(screen.getByRole("region", { name: "Chats" }).querySelectorAll("[data-agent-id]")).toHaveLength(0);
  });

  it("gathers the conversations on one branch under it, and lists all of a project's branches (no View all)", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    await boot([
      session("m1", "/repos/web", at(9)),
      session("m2", "/repos/web", at(8)),
      ...[1, 2, 3].map((n) => session(`w${n}`, "/repos/web", at(n), { worktreeName: `b${n}`, branch: `b${n}` })),
    ]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    const main = within(web).getByRole("button", { name: /^main/ });
    expect(main.textContent).toContain("2");
    expect(within(web).queryByText("Talk m1")).toBeNull();
    fireEvent.click(main);
    expect(within(web).getByText("Talk m1")).toBeTruthy();
    expect(within(web).getByText("Talk m2")).toBeTruthy();

    expect(within(web).getByRole("button", { name: "b1, Talk w1" })).toBeTruthy();
    expect(within(web).queryByRole("button", { name: "View all" })).toBeNull();
  });

  it("keeps a branch to one row, for whichever of its sessions is open, when its sessions are tabs in the tab bar", async () => {
    prefs.setPrefs({ branchSessions: "tabs" });
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    await boot([session("m1", "/repos/web", at(9)), session("m2", "/repos/web", at(8), { tabs: [{ id: "m2-tab", title: "Talk m2", harness: "claude", model: "", permissionMode: "auto", status: "waiting", created: "", modified: "" }] })]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    // Not a count with the sessions under it: one row, read out by its branch and named by its latest session, that opens it.
    const main = within(web).getByRole("button", { name: "main, Talk m1" });
    expect(within(web).getAllByText(/^Talk m/)).toHaveLength(1);
    // The row's state is the most pressing among them: its mark, with no label on the row.
    expect(main.querySelector("[data-session-status]")?.getAttribute("data-status-label")).toBe("Needs you");
    expect(within(main).queryByText("Needs you")).toBeNull();
    fireEvent.click(main);
    expect(within(web).getByRole("button", { name: "main, Talk m1" }).getAttribute("aria-current")).toBe("true");
    expect(within(web).getAllByText(/^Talk m/)).toHaveLength(1);
    expect(store.getSessionStore().selectedSessionId).toBe("m1");
  });

  // #721: a session whose tabs were all closed has nothing in the branch's row of tabs to click; it was unreachable here.
  it("keeps a row of its own for a session of the branch with no tab open, which opens that session", async () => {
    prefs.setPrefs({ branchSessions: "tabs" });
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    // m1, the newest, had its last tab closed; m2 and m3 have tabs.
    await boot([session("m1", "/repos/web", at(9), { tabs: [], activeTab: null }), session("m2", "/repos/web", at(8)), session("m3", "/repos/web", at(7))]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    // The branch's row stands for the sessions whose tabs are in its row of tabs.
    const main = within(web).getByRole("button", { name: "main, Talk m2" });
    const bare = within(web).getByRole("button", { name: /^Session m1/ });
    fireEvent.click(bare);
    expect(store.getSessionStore().selectedSessionId).toBe("m1");
    expect(within(web).getByRole("button", { name: /^Session m1/ }).getAttribute("aria-current")).toBe("true");
    expect(main.getAttribute("aria-current")).toBeNull();
    // The branch's row opens a session with tabs: the latest of them.
    fireEvent.click(within(web).getByRole("button", { name: "main, Talk m2" }));
    expect(store.getSessionStore().selectedSessionId).toBe("m2");
    expect(within(web).getByRole("button", { name: /^Session m1/ }).getAttribute("aria-current")).toBeNull();
  });

  it("invites a first chat when there is none, and no project to show", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => (command === "list_projects" ? { projects: [], lastSelected: null } : base(command, args)));
    await boot([]);
    mount();
    expect(within(screen.getByTestId("conversation-list")).getByRole("button", { name: /Start a chat/ })).toBeTruthy();
  });

  it("names the app's destinations above the conversations as 02.01 does, with their shortcuts", async () => {
    await boot([]);
    mount();
    const destinations = screen.getByRole("toolbar", { name: "Destinations" });
    const ownText = (button: HTMLElement) => [...button.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("");
    expect(within(destinations).getAllByRole("button").map(ownText)).toEqual(["Home", "Overview", "New session", "Search", "Automations", "Issues"]);
    // A key chip on the first four, as bound now; none on the others.
    expect(within(destinations).getAllByRole("button").map((button) => !!button.querySelector("kbd"))).toEqual([true, true, true, true, false, false]);
    expect(destinations.compareDocumentPosition(screen.getByTestId("conversation-list")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("renaming from the sidebar", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
  const tree = (name: string, branch: string, placeholder = false) => ({ path: `/repos/web/.worktrees/${name}`, name, branch, head: "abc1234", isMain: false, managed: true, placeholder, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 });
  const withTrees = (labels?: Record<string, string>) => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_projects") return { projects: [{ ...projects[0], branchLabels: labels }], lastSelected: null };
      if (command === "list_workspaces") return [...(await base(command, args)), tree("calm-ember-panda", "dc/calm-ember-panda", true), tree("crane", "dc/crane")];
      if (command === "rename_branch") return { branch: "Pricing-research", project: { ...projects[0], branchLabels: { "Pricing-research": "Pricing research" } }, sessions: [] };
      if (command === "update_project") return { ...projects[0] };
      return base(command, args);
    });
  };
  const bootTwo = () =>
    boot([
      session("panda", "/repos/web", at(2), { branch: "dc/calm-ember-panda", worktreeName: "calm-ember-panda", cwd: "/repos/web/.worktrees/calm-ember-panda" }),
      session("crane", "/repos/web", at(1), { branch: "dc/crane", worktreeName: "crane", cwd: "/repos/web/.worktrees/crane" }),
    ]);

  it("explains a rename on a detached HEAD, and makes a branch at its commit from the toast (PRO-295)", async () => {
    const { Toasts } = await import("@/components/ui/Toasts");
    const { dismissError, getErrorToasts } = await import("@/lib/errorToasts");
    const base = mocks.invoke.getMockImplementation()!;
    let branched: string | null = null;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_workspaces") return [...(await base(command, args)), { ...tree("crane", "", false), branch: branched, head: "3f2a91c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f", placeholder: false }];
      if (command === "git_branch_here") { branched = "dc/talk-crane"; return branched; }
      return base(command, args);
    });
    await boot([session("crane", "/repos/web", at(1), { branch: "dc/crane", worktreeName: "crane", cwd: "/repos/web/.worktrees/crane" })]);
    render(<Toasts />);
    mount();
    try {
      fireEvent.contextMenu(screen.getByRole("button", { name: "detached at 3f2a91c, Talk crane" }));
      fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Rename branch…" }));
      // No dialog for a branch that is not there: the toast says why, and what to do.
      expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
      const toast = await screen.findByRole("alert");
      expect(within(toast).getByText("Check out a branch before renaming")).toBeTruthy();
      expect(toast.textContent).toContain("This worktree is on a detached HEAD at 3f2a91c, so there's no branch to rename.");
      expect(toast.getAttribute("data-tone")).toBe("warning");
      expect(within(toast).getAllByRole("button").map((button) => button.textContent)).toEqual(["Create a branch here", ""]);

      await act(async () => fireEvent.click(within(toast).getByRole("button", { name: "Create a branch here" })));
      expect(mocks.invoke).toHaveBeenCalledWith("git_branch_here", { projectPath: "/repos/web", cwd: "/repos/web/.worktrees/crane", name: "Talk crane" });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      // The worktree is on the new branch now, which is what the session header names.
      expect(store.getSessionStore().workspaces["/repos/web"].find((entry) => entry.name === "crane")?.branch).toBe("dc/talk-crane");
      expect(screen.queryByRole("button", { name: /detached at/ })).toBeNull();
      expect(screen.getByRole("button", { name: "dc/talk-crane, Talk crane" })).toBeTruthy();
    } finally {
      for (const toast of getErrorToasts()) dismissError(toast.id);
    }
  });

  it("keeps the toast and says so when the branch can't be made", async () => {
    const { Toasts } = await import("@/components/ui/Toasts");
    const { dismissError, getErrorToasts } = await import("@/lib/errorToasts");
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_workspaces") return [...(await base(command, args)), { ...tree("crane", ""), branch: null, head: "3f2a91c8d0" }];
      if (command === "git_branch_here") throw "Repository configuration needs trust.";
      return base(command, args);
    });
    await boot([session("crane", "/repos/web", at(1), { branch: "dc/crane", worktreeName: "crane", cwd: "/repos/web/.worktrees/crane" })]);
    render(<Toasts />);
    mount();
    try {
      fireEvent.contextMenu(screen.getByRole("button", { name: "detached at 3f2a91c, Talk crane" }));
      fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Rename branch…" }));
      await act(async () => fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Create a branch here" })));
      const alerts = await screen.findAllByRole("alert");
      expect(alerts.map((alert) => alert.textContent)).toEqual([
        expect.stringContaining("Check out a branch before renaming"),
        expect.stringContaining("Couldn't create a branch at 3f2a91c:Repository configuration needs trust."),
      ]);
    } finally {
      for (const toast of getErrorToasts()) dismissError(toast.id);
    }
  });

  // Two worktrees detached at one commit read the same, but are two checkouts: each row stands for one (PRO-367).
  const sameCommit = (names: string[]) => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_workspaces") return [...(await base(command, args)), ...names.map((name) => ({ ...tree(name, ""), branch: null, head: "3f2a91c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f" }))];
      if (command === "git_branch_here") return "dc/new";
      return base(command, args);
    });
  };
  const createBranchFrom = async (row: HTMLElement) => {
    fireEvent.contextMenu(row);
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Rename branch…" }));
    await act(async () => fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Create a branch here" })));
  };

  it("gives each checkout detached at the same commit its own row, and branches the one chosen (PRO-367)", async () => {
    const { Toasts } = await import("@/components/ui/Toasts");
    const { dismissError, getErrorToasts } = await import("@/lib/errorToasts");
    sameCommit(["panda", "crane"]);
    await boot([
      session("panda", "/repos/web", at(2), { branch: "dc/panda", worktreeName: "panda", cwd: "/repos/web/.worktrees/panda" }),
      session("crane", "/repos/web", at(1), { branch: "dc/crane", worktreeName: "crane", cwd: "/repos/web/.worktrees/crane" }),
    ]);
    // The newer one is open: it must not stand in for the row the person right-clicks.
    act(() => store.selectSession("panda"));
    render(<Toasts />);
    mount();
    try {
      const web = screen.getByRole("group", { name: "web" });
      expect(within(web).getAllByRole("button", { name: /^detached at/ }).map((row) => row.getAttribute("aria-label"))).toEqual(["detached at 3f2a91c, Talk panda", "detached at 3f2a91c, Talk crane"]);
      await createBranchFrom(screen.getByRole("button", { name: "detached at 3f2a91c, Talk crane" }));
      expect(mocks.invoke).toHaveBeenCalledWith("git_branch_here", { projectPath: "/repos/web", cwd: "/repos/web/.worktrees/crane", name: "Talk crane" });
      expect(mocks.invoke).not.toHaveBeenCalledWith("git_branch_here", expect.objectContaining({ cwd: "/repos/web/.worktrees/panda" }));
    } finally {
      for (const toast of getErrorToasts()) dismissError(toast.id);
    }
  });

  it("keeps Rename… on a detached row while a session in it is live, its newest gone with its worktree (PRO-367)", async () => {
    const { Toasts } = await import("@/components/ui/Toasts");
    const { dismissError, getErrorToasts } = await import("@/lib/errorToasts");
    sameCommit(["crane"]);
    await boot([
      session("panda", "/repos/web", at(3), { branch: "dc/panda", worktreeName: "panda", cwd: "/repos/web/.worktrees/panda", worktreeRemoved: true, removedWorkspace: { path: "/repos/web/.worktrees/panda", branch: null } } as Partial<SessionEntry>),
      session("crane-2", "/repos/web", at(2), { title: "Talk heron", branch: "dc/crane", worktreeName: "crane", cwd: "/repos/web/.worktrees/crane" }),
      session("crane", "/repos/web", at(1), { branch: "dc/crane", worktreeName: "crane", cwd: "/repos/web/.worktrees/crane" }),
    ]);
    render(<Toasts />);
    mount();
    try {
      // Both of crane's sessions share its row (its count says 2); the removed worktree's conversation is kept apart.
      const rows = screen.getAllByRole("button", { name: /^detached at 3f2a91c/ });
      expect(rows.map((row) => row.textContent)).toEqual(["detached at 3f2a91c2"]);
      await createBranchFrom(rows[0]);
      expect(mocks.invoke).toHaveBeenCalledWith("git_branch_here", expect.objectContaining({ projectPath: "/repos/web", cwd: "/repos/web/.worktrees/crane" }));
    } finally {
      for (const toast of getErrorToasts()) dismissError(toast.id);
    }
  });

  it("offers a developer's few actions on a right-click", async () => {
    withTrees();
    await bootTwo();
    mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "dc/crane, Talk crane" }));
    const menu = await screen.findByRole("menu");
    // The designed order (02.13, PRO-386): keys shown only where one is bound.
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["Mark as unreadR", "PinP", "Set status", "Move to section", "Open in", "Rename…", "Rename branch…", "Copy link", "Share session…", "Issue and pull request", "Remove workspace…The conversations are kept", "Archive", "Delete session…"]);
  });

  it("renames a branch's row by its label, never showing its worktree, and its git branch only when asked", async () => {
    withTrees();
    await bootTwo();
    mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "dc/crane, Talk crane" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Rename branch…" }));
    const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
    expect(name.value).toBe("dc/crane");
    fireEvent.change(name, { target: { value: "Pricing research" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Also rename branch" }));
    expect(screen.getByText("dc/crane → Pricing-research")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rename" })));
    expect(mocks.invoke).toHaveBeenCalledWith("rename_branch", { projectPath: "/repos/web", from: "dc/crane", to: "Pricing-research" });
    expect(mocks.invoke).toHaveBeenCalledWith("update_project", { path: "/repos/web", patch: { branchLabel: { branch: "Pricing-research", label: "Pricing research" } } });
  });

  it("shows a branch's label in place of its name, and only relabels it when the branch is left alone", async () => {
    withTrees({ "dc/crane": "Payments" });
    await bootTwo();
    mount();
    const row = screen.getByRole("button", { name: "Payments, Talk crane" });
    fireEvent.contextMenu(row);
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Rename branch…" }));
    const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
    expect(name.value).toBe("Payments");
    fireEvent.change(name, { target: { value: "Billing" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rename" })));
    expect(mocks.invoke.mock.calls.some(([command]) => command === "rename_branch")).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("update_project", { path: "/repos/web", patch: { branchLabel: { branch: "dc/crane", label: "Billing" } } });
  });

  it.each(["double-click", "context menu", "dropdown"])("renames the displayed session on a named branch via %s without changing Git", async (entry) => {
    withTrees({ "dc/crane": "Payments" });
    await bootTwo();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "rename_session" || command === "rename_tab") {
        const { sessionId, tabId, title } = args as { sessionId: string; tabId?: string; title: string };
        sessions = sessions.map((s) => s.id !== sessionId ? s : command === "rename_session"
          ? { ...s, title }
          : { ...s, tabs: s.tabs.map((tab) => tab.id === tabId ? { ...tab, title } : tab) });
        return;
      }
      return base(command, args);
    });
    const { SessionDialogs } = await import("@/components/session/SessionDialogs");
    const { closeRenameSession } = await import("@/lib/dialogs");
    act(() => closeRenameSession());
    render(<SessionDialogs />);
    mount();
    const row = screen.getByRole("button", { name: "Payments, Talk crane" });
    expect(row.querySelector("[data-row-title]")?.textContent).toBe("Talk crane");
    if (entry === "double-click") fireEvent.doubleClick(row);
    else {
      if (entry === "context menu") fireEvent.contextMenu(row);
      else fireEvent.keyDown(screen.getByRole("button", { name: "Menu for Talk crane" }), { key: "ArrowDown" });
      fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Rename…" }));
    }
    const input = await screen.findByRole("textbox", { name: "Session title" });
    expect((input as HTMLInputElement).value).toBe("Talk crane");
    expect(screen.queryByRole("checkbox", { name: "Also rename branch" })).toBeNull();
    fireEvent.change(input, { target: { value: "Investigate billing" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rename" })));
    expect(mocks.invoke).toHaveBeenCalledWith("rename_session", { sessionId: "crane", title: "Investigate billing" });
    // Reload persisted titles, as native session-change events do in the app.
    await act(async () => store.refreshEverything());
    expect(screen.getByRole("button", { name: "Payments, Investigate billing" }).querySelector("[data-row-title]")?.textContent).toBe("Investigate billing");
    expect(store.getSessionStore().sessions.find((s) => s.id === "crane")?.branch).toBe("dc/crane");
    expect(store.getSessionStore().workspaces["/repos/web"].find((w) => w.name === "crane")?.branch).toBe("dc/crane");
    expect(mocks.invoke.mock.calls.some(([command]) => ["rename_branch", "update_project", "git_branch_here"].includes(command))).toBe(false);
  });

  it("renames a conversation by its title where the row shows its title", async () => {
    withTrees();
    await bootTwo();
    const { useDialogs } = await import("@/lib/dialogs");
    let opened: string | null = null;
    const Probe = () => {
      opened = useDialogs().renameSession;
      return null;
    };
    render(<Probe />);
    mount();
    fireEvent.doubleClick(screen.getByRole("button", { name: /^Talk panda/ }));
    expect(opened).toBe("panda");
  });
});

describe("ordering conversations", () => {
  it("puts pinned ones first, then the newest, and keeps the open one even when archived", () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    const ordered = orderConversations([
      session("old", chatsPath, at(1)),
      session("new", "/a", at(5)),
      session("pin", "/b", at(2), { pinned: true }),
      session("arch", chatsPath, at(6), { archived: true }),
      session("open", chatsPath, at(3), { archived: true }),
    ], "open");
    expect(ordered.map((entry) => entry.id)).toEqual(["pin", "new", "open", "old"]);
  });
});

it("orders by messages through background updates, metadata edits, persistence, pins and filters", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
  const oldest = session("old", chatsPath, at(1));
  const middle = session("middle", chatsPath, at(2));
  const newest = session("new", chatsPath, at(3));
  const list = [oldest, middle, newest];
  const ids = (entries = list) => orderConversations(entries, null).map((entry) => entry.id);
  expect(ids()).toEqual(["new", "middle", "old"]);
  oldest.lastMessageAt = at(4); // user sends in the oldest conversation
  expect(ids()).toEqual(["old", "new", "middle"]);
  middle.lastMessageAt = at(5); // background assistant reply
  expect(ids()).toEqual(["middle", "old", "new"]);
  newest.modified = at(9);
  newest.title = "Renamed";
  newest.activeTab = newest.tabs[0].id;
  newest.tabs[0].model = "synthetic-model";
  expect(ids()).toEqual(["middle", "old", "new"]);
  expect(ids(JSON.parse(JSON.stringify(list)))).toEqual(ids());
  newest.pinned = true;
  expect(ids()).toEqual(["new", "middle", "old"]);
  expect(ids(list.filter((entry) => entry.id !== "middle"))).toEqual(["new", "old"]);
  oldest.lastMessageAt = at(5);
  expect(ids()).toEqual(["new", "middle", "old"]);
  expect(ids([...list].reverse())).toEqual(ids());
});

it("offers checkout cleanup separately from conversation deletion in the active sidebar", async () => {
  await boot([session("cleanup", "/repos/web", new Date().toISOString(), { cwd: "/repos/web/.raccoon/worktrees/cleanup", worktreeName: "cleanup" })]);
  mount();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Menu for Talk cleanup" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const item = await screen.findByRole("menuitem", { name: /^Remove workspace…/ });
  expect(screen.getByRole("menuitem", { name: "Delete session…" })).toBeTruthy();
  fireEvent.click(item);
  const dialogs = await import("@/lib/dialogs");
  const Probe = () => <div data-testid="cleanup-request">{JSON.stringify(dialogs.useDialogs().workspaceRemove)}</div>;
  render(<Probe />);
  expect(JSON.parse(screen.getByTestId("cleanup-request").textContent!)).toMatchObject({ mode: "settle", sessionId: "cleanup", path: "/repos/web/.raccoon/worktrees/cleanup" });
  act(() => dialogs.closeWorkspaceRemove());
});


it("keeps removed-workspace provenance separate from a live checkout on the same branch", async () => {
  prefs.setPrefs({ branchSessions: "tabs" });
  await boot([
    session("old", "/repos/web", new Date().toISOString(), { branch: "main", worktreeRemoved: true, removedWorkspace: { name: "old", path: "/repos/web/.raccoon/worktrees/old", branch: "topic" } }),
    session("live", "/repos/web", new Date().toISOString(), { branch: "topic", worktreeName: "live", cwd: "/repos/web/.raccoon/worktrees/live" }),
  ]);
  mount();
  // Set apart under its fold, and not among the live work (#696).
  expect(screen.queryByRole("button", { name: "topic (workspace removed), Talk old" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Removed workspaces (1)" }));
  const kept = screen.getByRole("button", { name: "topic (workspace removed), Talk old" });
  expect(kept.closest("div[title]")?.getAttribute("title")).toContain("/repos/web/.raccoon/worktrees/old · workspace removed · resumes in /repos/web");
  expect(screen.getByRole("button", { name: "topic, Talk live" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /main.*Talk old/ })).toBeNull();
});

it.each(["simple", "list"] as const)("offers Restore workspace for a removed conversation in the %s sidebar", async (sidebarLayout) => {
  prefs.setPrefs({ sidebarLayout });
  await boot([session("restore", "/repos/web", new Date().toISOString(), {
    worktreeRemoved: true, removedWorkspace: { name: "old", path: "/repos/web/.raccoon/worktrees/old", branch: "topic" },
  })]);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Removed workspaces (1)" }));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Menu for Talk restore" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Restore workspace…" }));
  const dialogs = await import("@/lib/dialogs");
  const Probe = () => <div data-testid="restore-request">{dialogs.useDialogs().workspaceRestore}</div>;
  render(<Probe />);
  expect(screen.getByTestId("restore-request").textContent).toBe("restore");
  act(dialogs.closeWorkspaceRestore);
});


/** #696: "Review #590", its workspace gone on Oct 24, sat among the live work for good. */
it("sets removed workspaces apart under a fold, which opens while it holds the open conversation", async () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
  const gone = (name: string) => ({ branch: "main", worktreeRemoved: true, removedWorkspace: { name, path: `/repos/web/.raccoon/worktrees/${name}`, branch: name } });
  await boot([
    session("live", "/repos/web", at(3), { branch: "feature", worktreeName: "feature", cwd: "/repos/web/.raccoon/worktrees/feature" }),
    session("review", "/repos/web", at(2), gone("review-590")),
    session("other", "/repos/web", at(1), gone("other")),
  ]);
  mount();
  const fold = screen.getByRole("button", { name: "Removed workspaces (2)" });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: "feature, Talk live" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Talk review/ })).toBeNull();
  // Not counted among the few a project shows before "View all".
  expect(screen.queryByRole("button", { name: "View all" })).toBeNull();

  fireEvent.click(fold);
  expect(prefs.getPrefs().sidebarSections["removed-workspaces:/repos/web"]).toBe("expanded");
  fireEvent.click(screen.getByRole("button", { name: "review-590 (workspace removed), Talk review" }));
  // Folded again, it stays open while it holds the open conversation.
  fireEvent.click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "review-590 (workspace removed), Talk review" })).toBeTruthy();
});

it("marks a collapsed group of kept conversations as a removed workspace", async () => {
  const removed = { branch: "main", worktreeRemoved: true, removedWorkspace: { name: "old", path: "/repos/web/.raccoon/worktrees/old", branch: "topic" } };
  await boot([
    session("old1", "/repos/web", new Date().toISOString(), removed),
    session("old2", "/repos/web", new Date().toISOString(), removed),
  ]);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Removed workspaces (1)" }));
  const group = screen.getByTitle("topic (workspace removed)");
  expect(group.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(group);
  expect(screen.getByRole("button", { name: /^Talk old1/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Talk old2/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /New (session|workspace).*topic/ })).toBeNull();
});

describe("the archive (#718)", () => {
  beforeEach(() => {
    store.setShowArchived(false);
    selection.clearPicked();
  });
  const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
  const showArchived = () => {
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Show archived" }));
  };
  const archiveCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "set_sessions_archived").map(([, args]) => args);

  it("lists each project's archived conversations, and the chats', under Show archived, and Unarchive puts one back", async () => {
    await boot([
      session("here", "/repos/web", at(5)),
      session("old-web", "/repos/web", at(2), { archived: true, autoArchived: true, branch: "dev" }),
      session("chat", chatsPath, at(4)),
      session("old-chat", chatsPath, at(1), { archived: true }),
      // Its project was taken out of TerminalX, which archived it.
      session("left", "/repos/removed", at(3), { archived: true }),
    ]);
    mount();
    expect(screen.queryByTestId("archived-sessions")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Talk old-/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "removed" })).toBeNull();

    showArchived();
    expect(screen.getByRole("button", { name: "View: showing archived" })).toBeTruthy();
    const web = screen.getByRole("group", { name: "web" });
    const webArchive = within(web).getByTestId("archived-sessions");
    expect(within(webArchive).getByRole("button", { name: "Archived (1)" }).getAttribute("aria-expanded")).toBe("true");
    // Its branch is in the row's tooltip; the row itself ends in its time (02.04).
    expect(within(webArchive).getByRole("button", { name: /^Talk old-web/ }).closest("[title]")?.getAttribute("title")).toContain("dev");
    // The live list is as it was.
    expect(within(web).getByRole("button", { name: "main, Talk here" })).toBeTruthy();

    const chats = screen.getByRole("region", { name: "Chats" });
    const chatArchive = within(chats).getByTestId("archived-sessions");
    expect(within(chatArchive).getByRole("button", { name: /^Talk old-chat/ })).toBeTruthy();
    expect(within(chats).getByRole("button", { name: /^Talk chat/ })).toBeTruthy();
    // A project taken out of TerminalX comes back as a group, with what removing it archived.
    const removed = screen.getByRole("group", { name: "removed" });
    expect(within(within(removed).getByTestId("archived-sessions")).getByRole("button", { name: /^Talk left/ })).toBeTruthy();
    expect(within(removed).queryByText("No chats yet")).toBeNull();

    await act(async () => { fireEvent.click(within(webArchive).getByRole("button", { name: "Unarchive Talk old-web" })); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_session_archived").map(([, args]) => args)).toEqual([{ sessionId: "old-web", archived: false }]);
    // Back among the live ones, alone on its branch, and the fold is gone.
    expect(within(web).getByRole("button", { name: "dev, Talk old-web" })).toBeTruthy();
    expect(within(web).queryByTestId("archived-sessions")).toBeNull();

    showArchived();
    expect(screen.queryByTestId("archived-sessions")).toBeNull();
    expect(screen.queryByRole("group", { name: "removed" })).toBeNull();
  });

  it("opens an archived conversation where it is listed, and keeps its fold open while it is open", async () => {
    await boot([session("here", "/repos/web", at(5)), session("old", "/repos/web", at(2), { archived: true, branch: "dev" })]);
    mount();
    // Opened from the palette, with the archive hidden: it shows in the list, marked.
    act(() => store.selectSession("old"));
    expect(within(screen.getByRole("group", { name: "web" })).getByRole("button", { name: "dev, Talk old" }).textContent).toContain("archived");

    showArchived();
    const fold = within(screen.getByRole("group", { name: "web" })).getByRole("button", { name: "Archived (1)" });
    act(() => { fireEvent.click(fold); });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /^Talk old/ }).getAttribute("aria-current")).toBe("true");
  });

  it("picks several rows and archives, brings back or deletes them together", async () => {
    await boot([session("a", chatsPath, at(5)), session("b", chatsPath, at(4)), session("c", chatsPath, at(3)), session("d", chatsPath, at(2))]);
    const dialog = await import("@/lib/confirm");
    vi.mocked(dialog.confirmInApp).mockReset().mockResolvedValue(true);
    mount();
    const row = (id: string) => screen.getByRole("button", { name: new RegExp(`^Talk ${id}`) });
    expect(screen.queryByTestId("sidebar-bulk-bar")).toBeNull();

    // ⌘-click picks without opening; once picking, a plain click picks too.
    act(() => { fireEvent.click(row("a"), { metaKey: true }); });
    expect(screen.getByRole("toolbar", { name: "1 conversation selected" })).toBeTruthy();
    act(() => { fireEvent.click(row("c")); });
    expect(store.getSessions().selectedSessionId).toBeNull();
    expect(row("a").getAttribute("aria-pressed")).toBe("true");
    expect(row("b").getAttribute("aria-pressed")).toBe("false");
    const bar = screen.getByRole("toolbar", { name: "2 conversations selected" });
    expect(within(bar).getByRole("button", { name: /Unarchive/ }).hasAttribute("disabled")).toBe(true);

    await act(async () => { fireEvent.click(within(bar).getByRole("button", { name: /^Archive/ })); });
    expect(archiveCalls()).toEqual([{ sessionIds: ["a", "c"], archived: true }]);
    expect(screen.queryByTestId("sidebar-bulk-bar")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Talk a/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Talk c/ })).toBeNull();

    // Shift-click picks every row drawn between, here in the archive.
    showArchived();
    act(() => { fireEvent.click(row("a"), { metaKey: true }); });
    act(() => { fireEvent.click(row("c"), { shiftKey: true }); });
    const archivedBar = screen.getByRole("toolbar", { name: "2 conversations selected" });
    expect(within(archivedBar).getByRole("button", { name: /^Archive/ }).hasAttribute("disabled")).toBe(true);
    await act(async () => { fireEvent.click(within(archivedBar).getByRole("button", { name: /Unarchive/ })); });
    expect(archiveCalls().at(-1)).toEqual({ sessionIds: ["a", "c"], archived: false });

    // A range of live rows, then Escape lets go of them.
    act(() => { fireEvent.click(row("a"), { ctrlKey: true }); });
    act(() => { fireEvent.click(row("c"), { shiftKey: true }); });
    expect(screen.getByRole("toolbar", { name: "3 conversations selected" })).toBeTruthy();
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.queryByTestId("sidebar-bulk-bar")).toBeNull();

    // Delete asks once, for all of them.
    act(() => { fireEvent.click(row("b"), { metaKey: true }); });
    act(() => { fireEvent.click(row("d")); });
    await act(async () => { fireEvent.click(within(screen.getByRole("toolbar", { name: "2 conversations selected" })).getByRole("button", { name: /Delete/ })); });
    expect(vi.mocked(dialog.confirmInApp)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dialog.confirmInApp).mock.calls[0][0]).toMatchObject({ title: "Delete 2 sessions?", body: expect.stringMatching(/^Their transcripts and attachments are removed\./), destructive: true });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "delete_session").map(([, args]) => args)).toEqual([{ sessionId: "b" }, { sessionId: "d" }]);
    expect(screen.queryByTestId("sidebar-bulk-bar")).toBeNull();
  });

  it("leaves the rows picked when the delete is cancelled", async () => {
    await boot([session("a", chatsPath, at(5)), session("b", chatsPath, at(4))]);
    const dialog = await import("@/lib/confirm");
    vi.mocked(dialog.confirmInApp).mockReset().mockResolvedValue(false);
    mount();
    act(() => { fireEvent.click(screen.getByRole("button", { name: /^Talk a/ }), { metaKey: true }); });
    act(() => { fireEvent.click(screen.getByRole("button", { name: /^Talk b/ }), { metaKey: true }); });
    await act(async () => { fireEvent.click(within(screen.getByRole("toolbar", { name: "2 conversations selected" })).getByRole("button", { name: /Delete/ })); });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "delete_session")).toBe(false);
    expect(screen.getByRole("toolbar", { name: "2 conversations selected" })).toBeTruthy();
  });

  it("lets go of a picked conversation once it is gone, so a plain click opens a row again", async () => {
    await boot([session("a", chatsPath, at(5)), session("b", chatsPath, at(4))]);
    mount();
    act(() => { fireEvent.click(screen.getByRole("button", { name: /^Talk a/ }), { metaKey: true }); });
    expect(screen.getByRole("toolbar", { name: "1 conversation selected" })).toBeTruthy();

    // Deleted from elsewhere: its own menu, the CLI, retention or another window.
    act(() => store.removeSessions(["a"]));
    expect(screen.queryByTestId("sidebar-bulk-bar")).toBeNull();
    expect(selection.getPickedSessions()).toEqual([]);
    const row = screen.getByRole("button", { name: /^Talk b/ });
    expect(row.getAttribute("aria-pressed")).toBeNull();
    act(() => { fireEvent.click(row); });
    expect(store.getSessions().selectedSessionId).toBe("b");
    expect(selection.getPickedSessions()).toEqual([]);
  });
});

describe("row extras and unread reminders (PRO-179)", () => {
  it.each(["simple", "list"] as const)("renders background count updates and live drafts in the %s layout", async (sidebarLayout) => {
    const { setDraft, clearDrafts } = await import("@/lib/drafts");
    const { setTabStatus } = await import("@/lib/agentEvents");
    let additions = 12;
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_workspaces") return [{ path: "/repos/web", name: "web", branch: "main", additions: 1, deletions: 1, branchAdditions: additions, branchDeletions: 4 }];
      return base(command, args);
    });
    const row = session("background", "/repos/web", "2026-11-05T00:00:00Z");
    row.tabs[0].status = "in_progress";
    await boot([row]);
    prefs.setPrefs({ sidebarLayout, colourLineCounts: false });
    mount();
    // A working row ends in its time, as 02.04 draws it, in either layout; its lines show once it stops.
    await waitFor(() => expect(document.querySelector('[data-row-meta="time"]')).toBeTruthy());
    expect(screen.queryByText("+12")).toBeNull();
    expect(store.getSessionStore().selectedSessionId).not.toBe("background");
    additions = 27;
    await act(async () => setTabStatus(row.id, row.tabs[0].id, "completed"));
    expect(await screen.findByText("+27")).toBeTruthy();
    expect(screen.getByText("−4")).toBeTruthy();
    act(() => setDraft("background-tab", "Finish the\nregression test"));
    expect(screen.getByTestId("row-draft").textContent).toBe("Finish the regression test");
    expect(within(screen.getByTestId("row-draft")).getByRole("img", { name: "Draft" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive Talk background" })).toBeTruthy();
    act(() => clearDrafts((id) => id === "background-tab"));
    expect(screen.queryByTestId("row-draft")).toBeNull();
  });

  it.each(["simple", "list"] as const)("toggles the persisted flag with R without changing waiting state in the %s layout", async (sidebarLayout) => {
    const row = session("reminder", "/repos/web", "2026-11-05T00:00:00Z");
    row.tabs[0].status = "waiting";
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "set_tab_unread") {
        const { sessionId, tabId, unread } = args as { sessionId: string; tabId: string; unread: boolean };
        sessions = sessions.map((entry) => entry.id !== sessionId ? entry : { ...entry, tabs: entry.tabs.map((tab) => tab.id !== tabId ? tab : { ...tab, markedUnread: unread }) });
        return;
      }
      return base(command, args);
    });
    await boot([row]);
    prefs.setPrefs({ sidebarLayout });
    mount();
    fireEvent.keyDown(screen.getByRole("button", { name: "Menu for Talk reminder" }), { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "r", metaKey: true });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "set_tab_unread")).toBe(false);
    fireEvent.keyDown(menu, { key: "r" });
    await screen.findByRole("menuitem", { name: "Mark as read" });
    expect(mocks.invoke).toHaveBeenCalledWith("set_tab_unread", { sessionId: "reminder", tabId: "reminder-tab", unread: true });
    expect(store.getSessionStore().sessions[0].tabs[0]).toMatchObject({ markedUnread: true, status: "waiting" });
    fireEvent.keyDown(menu, { key: "r" });
    await screen.findByRole("menuitem", { name: "Mark as unread" });
    expect(store.getSessionStore().sessions[0].tabs[0]).toMatchObject({ markedUnread: false, status: "waiting" });
  });
});

describe("quick chats (#1464)", () => {
  const scratch = (id: string) => `/store/quick/${id}`;
  const quick = (id: string, modified: string, extra: Partial<SessionEntry> = {}) => session(id, scratch(id), modified, { kind: "quick", ...extra });
  const checkouts = { "/repos/web": [
    { path: "/repos/web", name: "web", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 },
    { path: "/repos/web/.worktrees/fix", name: "fix", branch: "raccoon/fix", head: "def", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 },
  ] };

  it("links a quick chat in scratch, or pointed outside every project, to nothing, and one pointed inside a project to it", async () => {
    const { conversationLink } = await import("./SessionSidebar");
    expect(conversationLink(quick("q1", "2026-11-01"), projects, chatsPath, checkouts)).toBeNull();
    expect(conversationLink(quick("q2", "2026-11-01", { cwd: "/Users/me/notes" }), projects, chatsPath, checkouts)).toBeNull();
    // A folder whose name only starts like the project's is not inside it.
    expect(conversationLink(quick("q3", "2026-11-01", { cwd: "/repos/website" }), projects, chatsPath, checkouts)).toBeNull();
    expect(conversationLink(quick("q4", "2026-11-01", { cwd: "/repos/web/src" }), projects, chatsPath, checkouts)).toMatchObject({ path: "/repos/web", name: "web", branch: "main" });
    // A worktree kept inside the project's folder names its own branch.
    expect(conversationLink(quick("q5", "2026-11-01", { cwd: "/repos/web/.worktrees/fix" }), projects, chatsPath, checkouts)).toMatchObject({ path: "/repos/web", name: "web", branch: "raccoon/fix" });
    // A project taken out of TerminalX does not take its quick chats back.
    expect(conversationLink(quick("q6", "2026-11-01", { cwd: "/repos/web" }), [{ ...projects[0], archived: true }], chatsPath, checkouts)).toBeNull();
  });

  it("makes no project of a quick chat: it is under Chats, or under the listed project it works in, archived ones too", async () => {
    const { groupConversations } = await import("./SessionSidebar");
    const entries = [
      quick("scratch", "2026-11-04"),
      quick("outside", "2026-11-03", { cwd: "/Users/me/notes" }),
      quick("inside", "2026-11-02", { cwd: "/repos/web/.worktrees/fix" }),
      quick("old", "2026-11-01", { archived: true }),
      quick("old-inside", "2026-11-01", { archived: true, cwd: "/repos/web" }),
      session("work", "/repos/web", "2026-11-01"),
    ];
    const { groups, chats, archivedChats } = groupConversations(entries, projects, chatsPath, checkouts, null, true, true);
    expect(groups.map((group) => group.path)).toEqual(["/repos/web"]);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(["inside", "work"]);
    expect(groups[0].branches.inside).toBe("raccoon/fix");
    expect(groups[0].archived.map((entry) => entry.id)).toEqual(["old-inside"]);
    expect(chats.map((entry) => entry.id)).toEqual(["scratch", "outside"]);
    expect(archivedChats.map((entry) => entry.id)).toEqual(["old"]);
  });

  it("never brings a saved order's scratch path back as an empty project", async () => {
    const { groupConversations } = await import("./SessionSidebar");
    const order = { custom: true, sessions: ["scratch"], projects: [scratch("scratch"), "/repos/web"], revision: 1 };
    const { groups, chats } = groupConversations([quick("scratch", "2026-11-01")], projects, chatsPath, checkouts, null, true, false, "updated", order);
    expect(groups.map((group) => group.path)).toEqual(["/repos/web"]);
    expect(chats.map((entry) => entry.id)).toEqual(["scratch"]);
  });

  it("puts a quick chat another session started with its parent's project while the sidebar nests children", async () => {
    const { groupConversations } = await import("./SessionSidebar");
    const parent = session("lead", "/repos/web", "2026-11-01");
    const helper = quick("helper", "2026-11-02", { parent: { sessionId: "lead" } });
    expect(groupConversations([parent, helper], projects, chatsPath, checkouts, null, true, false, "updated", undefined, true).groups[0].sessions.map((entry) => entry.id)).toEqual(["helper", "lead"]);
    // Off, or with its parent not in the list, it is a chat like any other.
    expect(groupConversations([parent, helper], projects, chatsPath, checkouts, null, true, false).chats.map((entry) => entry.id)).toEqual(["helper"]);
    expect(groupConversations([helper], projects, chatsPath, checkouts, null, true, false, "updated", undefined, true).chats.map((entry) => entry.id)).toEqual(["helper"]);
    // Parents that loop nest nothing.
    const a = quick("a", "2026-11-02", { parent: { sessionId: "b" } });
    const b = quick("b", "2026-11-01", { parent: { sessionId: "a" } });
    expect(groupConversations([a, b], projects, chatsPath, checkouts, null, true, false, "updated", undefined, true).chats.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("gives a quick chat pointed into a project a row of its own, by its title, with the branch's sessions as tabs", async () => {
    prefs.setPrefs({ branchSessions: "tabs" });
    await boot([
      session("here", "/repos/web", "2026-11-01T10:00:00Z"),
      quick("older", "2026-11-01T09:00:00Z", { cwd: "/repos/web" }),
      quick("newer", "2026-11-01T11:00:00Z", { cwd: "/repos/web/src" }),
    ]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    const rows = [...web.querySelectorAll("[data-row-sessions]")].map((row) => row.getAttribute("data-row-sessions"));
    expect(rows).toEqual(["newer", "here", "older"]);
    expect(within(web).getByRole("button", { name: "Talk older" })).toBeTruthy();
    expect(within(web).getByRole("button", { name: "Talk newer" })).toBeTruthy();
    expect(within(web).getByRole("button", { name: "main, Talk here" })).toBeTruthy();
  });

  it("lists quick chats by title under Chats, never a group named by an id, and says where each runs in its tooltip", async () => {
    const id = "01a1ce55-efc8-7be2-9a00-5f1e2a3b4c5d";
    const named = quick(id, "2026-11-03", { title: "Review the diff" });
    await boot([
      { ...named, tabs: named.tabs.map((tab) => ({ ...tab, title: "Review the diff" })) },
      quick("pointed", "2026-11-02", { cwd: "/Users/me/notes" }),
      quick("pinned", "2026-11-01", { pinned: true }),
      session("here", "/repos/web", "2026-11-01"),
    ]);
    mount();
    expect(screen.queryByRole("group", { name: id })).toBeNull();
    expect(screen.getByTestId("conversation-list").textContent).not.toContain(id);
    expect(rowsIn(screen.getByRole("region", { name: "Chats" }))).toEqual(["Scratch folder · Review the diff", "notes · Talk pointed"]);
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-label")).filter(Boolean)).not.toContain(id);
  });
});

describe("custom order (PRO-169)", () => {
  it("uses the saved order inside the archive and restores recency when off", async () => {
    const { archivedConversations, groupConversations } = await import("./SessionSidebar");
    const entries = [session("recent", "/repos/web", "2026-11-02", { archived: true }), session("older", "/repos/web", "2026-11-01", { archived: true })];
    const order = { custom: true, sessions: ["older", "recent"], projects: [], revision: 1 };
    expect(archivedConversations(entries, "updated", order).map((s) => s.id)).toEqual(["older", "recent"]);
    expect(archivedConversations(entries, "updated", { ...order, custom: false }).map((s) => s.id)).toEqual(["recent", "older"]);
    expect(groupConversations(entries, projects, chatsPath, {}, null, true, true, "updated", order).groups[0].archived.map((s) => s.id)).toEqual(["older", "recent"]);
  });
  it("restores recency when off without losing either saved order, and keeps new sessions first", async () => {
    const { groupConversations } = await import("./SessionSidebar");
    const order = { custom: true, sessions: ["older", "recent"], projects: ["/repos/other", "/repos/web"], revision: 1 };
    const entries = [session("recent", "/repos/web", "2026-11-02"), session("older", "/repos/web", "2026-11-01"), session("other", "/repos/other", "2026-11-01")];
    const attached = [...projects, { path: "/repos/other", name: "other", kind: "git" as const }];
    const grouped = (custom: boolean, list = entries) => groupConversations(list, attached, chatsPath, {}, null, true, false, "updated", { ...order, custom });
    expect(grouped(true).groups.map((g) => g.path)).toEqual(["/repos/other", "/repos/web"]);
    expect(grouped(true).groups[1].sessions.map((s) => s.id)).toEqual(["older", "recent"]);
    expect(grouped(false).groups[0].sessions.map((s) => s.id)).toEqual(["recent", "older"]);
    expect(grouped(true).groups[1].sessions.map((s) => s.id)).toEqual(["older", "recent"]);
    expect(grouped(true, [...entries, session("new", "/repos/web", "2026-11-03")]).groups[1].sessions.map((s) => s.id)).toEqual(["new", "older", "recent"]);
  });
  it("uses one mutually exclusive View sort in both sidebar layouts", async () => {
    const ordering = await import("@/lib/sidebarOrder");
    let saved = { custom: false, sessions: ["older", "recent"], projects: [], revision: 10 };
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "set_sidebar_order") {
        saved = { ...saved, ...(args as { patch: object }).patch, revision: saved.revision + 1 };
        return saved;
      }
      return base(command, args);
    });
    await boot([session("recent", "/repos/web", "2026-11-02", { branch: "recent" }), session("older", "/repos/web", "2026-11-01", { branch: "raccoon/quiet-amber-fox" })]);
    await act(async () => { await ordering.saveSidebarOrder({ custom: false }); });
    mount();
    fireEvent.keyDown(screen.getByTestId("sidebar-filter"), { key: "ArrowDown" });
    expect((await screen.findByRole("menuitemradio", { name: "Updated" })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Custom order" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Custom order" }));
    // The handle names the displayed conversation, not its hidden generated branch.
    await screen.findByRole("button", { name: "Reorder Talk older" });
    const rowIds = () => [...screen.getByTestId("conversation-list").querySelectorAll("[data-row-sessions]")].map((row) => row.getAttribute("data-row-sessions"));
    expect(rowIds()).toEqual(["older", "recent"]);
    act(() => prefs.setPrefs({ sidebarLayout: "list" }));
    await screen.findByRole("button", { name: "Reorder Talk older" });
    expect(rowIds()).toEqual(["older", "recent"]);
    // Updated and Created are one choice; Custom order is a checkbox beside them, and checked it wins.
    const choose = async (current: string, next: string) => {
      fireEvent.keyDown(screen.getByTestId("sidebar-filter"), { key: "ArrowDown" });
      const choices = [...await Promise.all(["Updated", "Created"].map((name) => screen.findByRole("menuitemradio", { name }))), screen.getByRole("menuitemcheckbox", { name: "Custom order" })];
      expect(choices.filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.textContent)).toEqual([current === "Custom" ? "Custom order" : current]);
      fireEvent.click(next === "Custom" ? screen.getByRole("menuitemcheckbox", { name: "Custom order" }) : screen.getByRole("menuitemradio", { name: next }));
      await waitFor(() => expect(prefs.getPrefs().sidebarSort).toBe(next.toLowerCase()));
    };
    await choose("Custom", "Created");
    expect(rowIds()).toEqual(["recent", "older"]);
    expect(screen.queryByRole("button", { name: /Reorder/ })).toBeNull();
    await choose("Created", "Custom");
    expect(rowIds()).toEqual(["older", "recent"]);
    await choose("Custom", "Updated");
    expect(rowIds()).toEqual(["recent", "older"]);
    expect(screen.queryByRole("button", { name: /Reorder/ })).toBeNull();
    expect(saved.sessions).toEqual(["older", "recent"]);
  });
});

describe("the Machines section (PRO-345)", () => {
  const machines = async (paired: boolean) => {
    const experimental = await import("@/lib/experimentalSettings");
    const connections = await import("@/lib/machineConnections");
    const { pairedMachine } = await import("@/components/machines/machineFixtures.test-utils");
    experimental.resetExperimentalSettingsForTests();
    connections.resetMachineConnectionsForTests();
    const answer = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: never) => {
      if (command === "machines_list") return !paired ? [] : [pairedMachine({ machineId: "m1", name: "Mac mini" }), pairedMachine({ machineId: "m2", name: "dev-server", os: { family: "linux", version: null } })];
      if (command === "machines_connections") return !paired ? [] : [{ machineId: "m1", state: { state: "direct", route: { kind: "lan", endpoint: "ws://192.168.1.20:6768/machine/1" }, since: 1, rttMs: 3 } }, { machineId: "m2", state: { state: "offline", lastSeenAt: null, retryInMs: 10_000 } }];
      return answer(command, args);
    });
    await connections.refreshPairedMachines();
    return connections;
  };
  afterEach(async () => {
    (await import("@/lib/experimentalSettings")).resetExperimentalSettingsForTests();
    (await import("@/lib/machineConnections")).resetMachineConnectionsForTests();
    store.selectCloudWorkspace(null);
  });

  it("lists each paired machine with its state in place of the Development section, and opens its view", async () => {
    await machines(true);
    await boot([session("one", "/repos/web", new Date().toISOString())]);
    mount();
    const section = await screen.findByTestId("machines-section");
    expect(screen.queryByTestId("dev-runtime-section")).toBeNull();
    const mini = within(section).getByRole("region", { name: "Mac mini" });
    expect(within(mini).getByTestId("machine-state-label").textContent).toBe("Direct");
    expect(within(within(section).getByRole("region", { name: "dev-server" })).getByTestId("machine-state-label").textContent).toBe("Offline");
    fireEvent.click(within(mini).getByRole("button"));
    expect(store.getSessionStore().selectedCloudWorkspace).toBe("machine:m1");
  });

  it("shows nothing with no machine paired (PRO-360)", async () => {
    await machines(false);
    await boot([session("one", "/repos/web", new Date().toISOString())]);
    mount();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_list"));
    expect(screen.queryByTestId("machines-section")).toBeNull();
  });
});
