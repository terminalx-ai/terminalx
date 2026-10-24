import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project, SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));

const { ProjectRail } = await import("./ProjectRail");
const { orderConversations } = await import("./SessionSidebar");
const store = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");

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
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects, lastSelected: null };
    if (command === "list_sessions") return sessions;
    if (command === "list_harnesses") return [];
    if (command === "chats_dir") return chatsPath;
    if (command === "list_workspaces") return [{ path: "/repos/web", name: "web", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }];
    return undefined;
  });
});
afterEach(cleanup);

const mount = () => render(<TooltipProvider><ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenStats={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /></TooltipProvider>);
const rowsIn = (element: HTMLElement) => within(element).getAllByRole("listitem").map((row) => row.querySelector("[title]")?.getAttribute("title"));

async function boot(list: SessionEntry[]) {
  sessions = list;
  await act(async () => {
    await store.bootSessions();
    await store.refreshEverything();
  });
}

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
    // Asked for the project's folder, not a chat's.
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "github_identity").map(([, args]) => args)).toEqual([{ projectPath: "/repos/web", refresh: false }]);
  });
});

describe("a project's fold", () => {
  it("folds its branches away from the project row and remembers it, the picture giving way to a chevron", async () => {
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
    expect(prefs.getPrefs().sidebarSections["project:/repos/web"]).toBe("collapsed");
    await act(async () => { fireEvent.click(within(web).getByRole("button", { name: "Expand web" })); });
    expect(within(web).getByTestId("project-branches").getAttribute("class")).toContain("grid-rows-[1fr]");
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

  it("starts another session on a branch from its row, in the folder where that branch is checked out", async () => {
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
    const created = mocks.invoke.mock.calls.find(([command]) => command === "create_session");
    expect(created?.[1]).toMatchObject({ req: { projectPath: "/repos/web", cwd: "/repos/web", useWorktree: false } });
    // A branch checked out nowhere gets a new workspace branched from it, named after it.
    expect(within(web).queryByRole("button", { name: "New session on old" })).toBeNull();
    await act(async () => { fireEvent.click(within(web).getByRole("button", { name: "New workspace from old" })); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session").at(-1)?.[1]).toMatchObject({ req: { projectPath: "/repos/web", cwd: null, useWorktree: true, baseRef: "old", worktreeName: "old" } });
    // A worktree's branch has its folder, listed or not.
    await act(async () => { fireEvent.click(within(web).getByRole("button", { name: "New session on raccoon/fix-login" })); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session").at(-1)?.[1]).toMatchObject({ req: { projectPath: "/repos/web", cwd: "/repos/web/.worktrees/fix-login", useWorktree: false } });
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
    const dialog = await import("@tauri-apps/plugin-dialog");
    vi.mocked(dialog.ask).mockResolvedValue(true);
    mount();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Project menu for web" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    await act(async () => { fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from TerminalX…" })); });
    expect(vi.mocked(dialog.ask).mock.calls[0][0]).toBe("Remove web from TerminalX? Its 2 conversations are archived, and the folder on disk is left as it is.");
    const calls = mocks.invoke.mock.calls.filter(([command]) => command === "set_session_archived" || command === "remove_project").map(([command, args]) => [command, args]);
    expect(calls).toEqual([["set_session_archived", { sessionId: "there", archived: true }], ["set_session_archived", { sessionId: "here", archived: true }], ["remove_project", { path: "/repos/web" }]]);
    expect(screen.queryByRole("group", { name: "web" })).toBeNull();
  });

  it("marks each row with its agent only once the conversations use more than one", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    const codex = (entry: SessionEntry) => ({ ...entry, tabs: entry.tabs.map((tab) => ({ ...tab, harness: "codex" })) });
    await boot([session("one", chatsPath, at(1)), session("two", chatsPath, at(2))]);
    mount();
    expect(document.querySelectorAll("[data-agent-id]")).toHaveLength(0);
    cleanup();

    await boot([session("one", chatsPath, at(1)), codex(session("two", chatsPath, at(2)))]);
    mount();
    const chats = screen.getByRole("region", { name: "Chats" });
    expect([...chats.querySelectorAll("[data-agent-id]")].map((mark) => mark.getAttribute("data-agent-id"))).toEqual(["codex", "claude"]);
  });

  it("gathers the conversations on one branch under it, and shows a project's latest few branches before View all", async () => {
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

    expect(within(web).queryByRole("button", { name: "b1, Talk w1" })).toBeNull();
    fireEvent.click(within(web).getByRole("button", { name: "View all" }));
    expect(within(web).getByRole("button", { name: "b1, Talk w1" })).toBeTruthy();
  });

  it("keeps a branch to one row, for whichever of its sessions is open, when its sessions are tabs in the tab bar", async () => {
    prefs.setPrefs({ branchSessions: "tabs" });
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    await boot([session("m1", "/repos/web", at(9)), session("m2", "/repos/web", at(8), { tabs: [{ id: "m2-tab", title: "Talk m2", harness: "claude", model: "", permissionMode: "auto", status: "waiting", created: "", modified: "" }] })]);
    mount();
    const web = screen.getByRole("group", { name: "web" });
    // Not a count with the sessions under it: one row, named by the branch, that opens its latest session.
    const main = within(web).getByRole("button", { name: "main, 2 sessions" });
    expect(within(web).queryByText("Talk m1")).toBeNull();
    expect(within(web).queryByText("Talk m2")).toBeNull();
    // The row's state is the most pressing among them.
    expect(within(main).getByRole("img", { name: "Needs you" })).toBeTruthy();
    fireEvent.click(main);
    expect(within(web).getByRole("button", { name: "main, 2 sessions" }).getAttribute("aria-current")).toBe("true");
    expect(within(web).queryByText("Talk m1")).toBeNull();
  });

  it("invites a first chat when there is none, and no project to show", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => (command === "list_projects" ? { projects: [], lastSelected: null } : base(command, args)));
    await boot([]);
    mount();
    expect(within(screen.getByTestId("conversation-list")).getByRole("button", { name: /Start a chat/ })).toBeTruthy();
  });

  it("names the app's destinations above the conversations, the dashboard first", async () => {
    await boot([]);
    mount();
    const destinations = screen.getByRole("toolbar", { name: "Destinations" });
    expect(within(destinations).getAllByRole("button").map((button) => button.textContent)).toEqual(["Dashboard", "Issues", "Automations"]);
    expect(destinations.compareDocumentPosition(screen.getByTestId("conversation-list")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  const item = await screen.findByRole("menuitem", { name: "Remove workspace, keep conversations…" });
  expect(screen.getByRole("menuitem", { name: "Delete…" })).toBeTruthy();
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
  const kept = screen.getByRole("button", { name: "topic (workspace removed), Talk old" });
  expect(kept.closest("div[title]")?.getAttribute("title")).toContain("/repos/web/.raccoon/worktrees/old · workspace removed · resumes in /repos/web");
  expect(screen.getByRole("button", { name: "topic, Talk live" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /main.*Talk old/ })).toBeNull();
});


it("marks a collapsed group of kept conversations as a removed workspace", async () => {
  const removed = { branch: "main", worktreeRemoved: true, removedWorkspace: { name: "old", path: "/repos/web/.raccoon/worktrees/old", branch: "topic" } };
  await boot([
    session("old1", "/repos/web", new Date().toISOString(), removed),
    session("old2", "/repos/web", new Date().toISOString(), removed),
  ]);
  mount();
  const group = screen.getByTitle("topic (workspace removed)");
  expect(group.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(group);
  expect(screen.getByRole("button", { name: /^Talk old1/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Talk old2/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /New (session|workspace).*topic/ })).toBeNull();
});
