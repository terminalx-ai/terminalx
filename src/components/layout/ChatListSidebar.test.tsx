import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const store = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const selection = await import("@/lib/rowSelection");
const botStore = await import("@/lib/bots");

const chatsPath = "/store/Chats";
const projects: Project[] = [{ path: "/repos/web", name: "web", kind: "git", color: "blue" }];
const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
const session = (id: string, projectPath: string, modified: string, extra: Partial<SessionEntry> = {}, status: SessionEntry["tabs"][number]["status"] = "idle"): SessionEntry => ({
  id, projectPath, cwd: projectPath, title: `Session ${id}`, created: modified, modified, pinned: false, archived: false, worktreeRemoved: false, activeTab: `${id}-tab`,
  tabs: [{ id: `${id}-tab`, title: `Talk ${id}`, harness: "claude", model: "", permissionMode: "auto", status, created: "", modified: "" }],
  ...extra,
});
let sessions: SessionEntry[];
let summaries: Record<string, { lastPrompt?: string; lastReply?: string; waitingOn?: string }>;

beforeEach(async () => {
  store.setShowArchived(false);
  prefs.setPrefs({ sidebarLayout: "list", sidebarSections: {}, sidebarSort: "updated", sidebarProject: null, sidebarFilters: {} });
  summaries = {};
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: { sessionIds?: string[] }) => {
    if (command === "list_projects") return { projects, lastSelected: null };
    if (command === "list_sessions") return sessions;
    if (command === "list_harnesses") return [];
    if (command === "chats_dir") return chatsPath;
    if (command === "list_workspaces") return [];
    // As the backend answers: the sessions as they are now, archived or back.
    if (command === "set_sessions_archived") {
      const { sessionIds, archived } = args as unknown as { sessionIds: string[]; archived: boolean };
      sessions = sessions.map((entry) => (sessionIds.includes(entry.id) ? { ...entry, archived } : entry));
      return sessionIds.map((id) => sessions.find((entry) => entry.id === id)!);
    }
    if (command === "session_summaries") {
      return (args?.sessionIds ?? []).flatMap((sessionId) => (summaries[sessionId] ? [{ sessionId, tabId: `${sessionId}-tab`, lastPrompt: null, lastReply: null, waitingOn: null, updatedAt: at(1), ...summaries[sessionId] }] : []));
    }
    return undefined;
  });
});
afterEach(cleanup);

const mount = () => render(<TooltipProvider><ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenHome={() => {}} onNewSession={() => {}} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /></TooltipProvider>);

async function boot(list: SessionEntry[]) {
  sessions = list;
  await act(async () => {
    await store.bootSessions();
    await store.refreshEverything();
  });
}

const rows = () => within(screen.getByTestId("conversation-list")).getAllByRole("listitem");
const titleOf = (row: HTMLElement) => row.querySelector("[data-row-sessions] [data-row-title]")?.textContent;
const rowTitles = () => [...screen.getByTestId("conversation-list").querySelectorAll("[data-row-title]")].map((title) => title.textContent);

describe("one list of sessions (View → Group by Sections)", () => {
  it("lists every conversation in one list of one-line rows, pinned ones in the Pinned group, then newest, whatever project it is in", async () => {
    await boot([
      session("chat", chatsPath, at(3)),
      session("work", "/repos/web", at(2), { worktreeName: "fix-login", cwd: "/repos/web/.raccoon/worktrees/fix-login", branch: "raccoon/fix-login" }),
      session("old", "/repos/web", at(1), { pinned: true }),
      session("gone", chatsPath, at(4), { archived: true }),
    ]);
    mount();
    // A row is named by its session's title, never its branch (PRO-384).
    expect(rows().map(titleOf).filter(Boolean)).toEqual(["Talk old", "Talk chat", "Talk work"]);
    expect(within(screen.getByTestId("pinned-group")).getByRole("button", { name: "Pinned 1" })).toBeTruthy();
    // No project level, and no second line or bot face: the same compact rows as the project layout.
    expect(screen.queryByRole("group", { name: "web" })).toBeNull();
    expect(screen.queryByTestId("chat-preview")).toBeNull();
    expect(screen.queryByTestId("chat-mark")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("menuitemradio", { name: "Sections" }).getAttribute("aria-checked")).toBe("true");
  });

  it("puts where a session works in its tooltip, and marks the unread and waiting ones", async () => {
    await boot([
      session("asks", "/repos/web", at(4), { worktreeName: "fix-login", cwd: "/repos/web/.raccoon/worktrees/fix-login", branch: "raccoon/fix-login" }, "waiting"),
      session("said", chatsPath, at(3), {}, "completed"),
      session("quiet", "/repos/web", at(1), { branch: "main" }),
    ]);
    mount();
    const [asks, said, quiet] = rows();
    // A mark, not a label: its name is the label.
    expect(within(asks!).getByRole("button", { description: /^Needs you/ })).toBeTruthy();
    expect(asks!.querySelector("[title]")?.getAttribute("title")).toBe("web · raccoon/fix-login · Talk asks");
    expect(within(said!).getByRole("img", { name: "Unread" })).toBeTruthy();
    expect(said!.querySelector("[title]")?.getAttribute("title")).toBe("Talk said");
    // Nothing unread, nothing waiting.
    expect(within(quiet!).queryAllByRole("img")).toEqual([]);
  });

  it("opens a chat on click, and switches back to the project view from the View menu", async () => {
    await boot([session("one", chatsPath, at(1))]);
    mount();
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Talk one" }));
    expect(store.getSessionStore().selectedSessionId).toBe("one");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Project" }));
    expect(prefs.getPrefs().sidebarLayout).toBe("simple");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("menuitemradio", { name: "Project" }).getAttribute("aria-checked")).toBe("true");
  });
});

it("offers conversation-preserving cleanup in the list view and marks kept history", async () => {
  await boot([
    session("live", "/repos/web", at(2), { worktreeName: "live", cwd: "/repos/web/.raccoon/worktrees/live" }),
    session("kept", "/repos/web", at(1), { worktreeRemoved: true, removedWorkspace: { name: "old", path: "/repos/web/.raccoon/worktrees/old", branch: "topic" } }),
  ]);
  mount();
  // Set apart from the live chats under its fold (#696).
  expect(screen.queryByRole("button", { name: /^Talk kept/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Removed workspaces (1)" }));
  const kept = screen.getByRole("button", { name: "Talk kept (workspace removed)" });
  expect(within(kept).getByText("removed")).toBeTruthy();
  expect(kept.closest("div[title]")?.getAttribute("title")).toContain("/repos/web/.raccoon/worktrees/old · workspace removed · resumes in /repos/web");
  fireEvent.pointerDown(screen.getByRole("button", { name: "Menu for Talk live" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  expect(await screen.findByRole("menuitem", { name: /^Remove workspace…/ })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Delete session…" })).toBeTruthy();
});

describe("renaming a chat in the list", () => {
  it("opens Rename from a double-click, a right-click or the row's menu, with the developer's few actions beside it", async () => {
    await boot([session("a", "/repos/web", at(1), { branch: "dc/payments" })]);
    const { useDialogs, closeRenameSession } = await import("@/lib/dialogs");
    let opened: string | null = null;
    const Probe = () => {
      opened = useDialogs().renameSession;
      return null;
    };
    render(<Probe />);
    mount();
    const row = screen.getByRole("button", { name: "Talk a" });
    fireEvent.doubleClick(row);
    expect(opened).toBe("a");
    act(() => closeRenameSession());

    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["Mark as unreadR", "PinP", "Set status", "Move to section", "Open in", "Rename…", "Copy link", "Share session…", "Issue and pull request", "Archive", "Delete session…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Rename/ }));
    expect(opened).toBe("a");
  });

  it("shows a branch by the label it was given", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: { sessionIds?: string[] }) =>
      command === "list_projects" ? { projects: [{ ...projects[0], branchLabels: { "dc/payments": "Payments" } }], lastSelected: null } : base(command, args),
    );
    await boot([session("a", "/repos/web", at(1), { branch: "dc/payments" })]);
    mount();
    expect(rows()[0]!.querySelector("[title]")?.getAttribute("title")).toBe("web · Payments · Talk a");
  });
});

describe("the archive in the chat list (#718)", () => {
  beforeEach(() => {
    store.setShowArchived(false);
    selection.clearPicked();
  });

  it("lists the archived chats at the end under Show archived, and Unarchive puts one back", async () => {
    await boot([session("live", chatsPath, at(3)), session("old", chatsPath, at(5), { archived: true }), session("older", "/repos/web", at(1), { archived: true })]);
    mount();
    expect(rows().map(titleOf)).toEqual(["Talk live"]);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Show archived" }));
    const fold = screen.getByTestId("archived-sessions");
    expect(within(fold).getByRole("button", { name: "Archived (2)" }).getAttribute("aria-expanded")).toBe("true");
    // Newest first, after the live ones, however new.
    expect(rowTitles()).toEqual(["Talk live", "Talk old", "Talk older"]);
    expect(within(fold).getAllByTitle("web · Talk older")).toHaveLength(1);

    await act(async () => { fireEvent.click(within(fold).getByRole("button", { name: "Unarchive Talk old" })); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_session_archived").map(([, args]) => args)).toEqual([{ sessionId: "old", archived: false }]);
    expect(within(screen.getByTestId("archived-sessions")).getByRole("button", { name: "Archived (1)" })).toBeTruthy();
    expect(rowTitles()).toEqual(["Talk old", "Talk live", "Talk older"]);
  });

  it("picks chats for the bulk bar as the project view does", async () => {
    await boot([session("a", chatsPath, at(3)), session("b", chatsPath, at(2))]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Talk a" }), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Talk b" }), { shiftKey: true });
    const bar = screen.getByRole("toolbar", { name: "2 conversations selected" });
    expect(store.getSessions().selectedSessionId).toBeNull();
    await act(async () => { fireEvent.click(within(bar).getByRole("button", { name: /^Archive/ })); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_sessions_archived").map(([, args]) => args)).toEqual([{ sessionIds: ["a", "b"], archived: true }]);
    expect(screen.queryByRole("button", { name: "Talk a" })).toBeNull();
  });
});


describe("a bot's chats (PRO-468)", () => {
  afterEach(() => botStore.resetBotsForTests());

  it("are under their bot, not in the list or the status layout, while the bot is listed", async () => {
    const bot = { id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac", reportsTo: "owner", worksIn: ["personal"], created: at(1), modified: at(1) };
    const listing = { revision: 1, bots: [bot], unreadable: 0 };
    const answer = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => (command === "bot_list" ? listing : answer(command, args)));
    await boot([session("plain", chatsPath, at(2)), session("home", chatsPath, at(3), { bot: { id: "b1", home: true } }), session("orphan", chatsPath, at(1), { bot: { id: "gone" } })]);
    await act(async () => botStore.bootBots());
    for (const layout of ["list", "status"] as const) {
      prefs.setPrefs({ sidebarLayout: layout });
      mount();
      const titles = [...document.querySelectorAll("[data-row-title]")].map((title) => title.textContent);
      expect(titles, layout).toContain("Talk plain");
      expect(titles, "a chat whose bot is gone stays where it can be found").toContain("Talk orphan");
      expect(titles, layout).not.toContain("Talk home");
      cleanup();
    }
  });
});

describe("status grouping and view controls (PRO-164)", () => {
  it("groups each session independently, updates counts and remembers collapsed headers", async () => {
    await boot([session("one", "/repos/web", at(1), { manualStatus: "in_review" }), session("two", "/repos/web", at(2), { manualStatus: "in_review" }), session("three", chatsPath, at(3))]);
    mount();
    expect(screen.getByRole("button", { name: "Talk one", description: /Status: In review$/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "View" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Status" }));
    const header = screen.getByRole("button", { name: "In review 2" });
    expect(screen.getByRole("button", { name: "Backlog 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Done/ })).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Talk one" })).toBeNull();
    expect(prefs.getPrefs().sidebarSections["status:local:in_review"]).toBe("collapsed");
    await act(async () => { store.upsertSession({ ...sessions[0], manualStatus: "done" }); });
    expect(screen.getByRole("button", { name: "In review 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Talk one" })).toBeTruthy();
  });

  it("combines a project with Needs you and creation order, and keeps the archive project-filtered", async () => {
    await boot([
      session("old", "/repos/web", at(1), { lastMessageAt: at(10) }, "waiting"),
      session("new", chatsPath, at(2), { link: { path: "/repos/web/" } }, "waiting"),
      session("other", "/repos/other", at(3), {}, "waiting"),
      session("read", "/repos/web", at(4)),
      session("archive", "/repos/web", at(5), { archived: true }),
      session("hidden-archive", "/repos/other", at(6), { archived: true }),
    ]);
    act(() => {
      store.selectSession(null);
      prefs.setPrefs({ sidebarLayout: "status", sidebarProject: "/repos/web", sidebarSort: "created", sidebarFilters: { local: "needs" } });
    });
    mount();
    expect(screen.queryByRole("button", { name: "Talk other" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Talk read" })).toBeNull();
    expect(screen.getByRole("button", { name: "Backlog 2" })).toBeTruthy();
    // DOM order follows creation while the older session has newer messages.
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons.findIndex((text) => text?.includes("Talk new"))).toBeLessThan(buttons.findIndex((text) => text?.includes("Talk old")));
    act(() => { prefs.setPrefs({ sidebarFilters: {} }); store.setShowArchived(true); });
    expect(screen.getByRole("button", { name: "Talk archive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Talk hidden-archive" })).toBeNull();
  });

  it("keeps the selected session visible when its project does not match", async () => {
    await boot([session("web", "/repos/web", at(1)), session("other", "/repos/other", at(2)), session("hidden", "/repos/other", at(3))]);
    act(() => { store.selectSession("other"); prefs.setPrefs({ sidebarProject: "/repos/web", sidebarFilters: { local: "needs" } }); });
    mount();
    expect(screen.getByRole("button", { name: "Talk other" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Talk hidden" })).toBeNull();
    act(() => prefs.setPrefs({ sidebarFilters: {} }));
    expect(screen.getByRole("button", { name: "Talk web" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Talk other" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Talk hidden" })).toBeNull();
  });

  it("searches project choices with the keyboard without hover stealing focus", async () => {
    await boot([session("web", "/repos/web", at(1)), session("other", "/repos/other", at(2))]);
    act(() => store.selectSession(null));
    mount();
    fireEvent.keyDown(screen.getByRole("button", { name: "View" }), { key: "ArrowDown" });
    const trigger = await screen.findByRole("menuitem", { name: /^Filter by project/ });
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const search = await screen.findByRole("textbox", { name: "Search projects" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    const all = screen.getByRole("menuitemradio", { name: "All projects" });
    // With no query, mouse users still get the usual highlighted result.
    fireEvent.pointerMove(all, { pointerType: "mouse" });
    expect(document.activeElement).toBe(all);
    fireEvent.keyDown(all, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "web" } });
    expect(screen.queryByRole("menuitemradio", { name: "other" })).toBeNull();
    // Moving from the formerly hovered row fires leave before the next move.
    // Radix otherwise focuses the menu content and interrupts the typed query.
    fireEvent.pointerLeave(all, { pointerType: "mouse" });
    expect(document.activeElement).toBe(search);
    fireEvent.pointerMove(screen.getByRole("menuitemradio", { name: "web" }), { pointerType: "mouse" });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(all);
    fireEvent.keyDown(all, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(all, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "web" })));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(prefs.getPrefs().sidebarProject).toBe("/repos/web");
    expect(screen.queryByRole("button", { name: "Talk other" })).toBeNull();
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
