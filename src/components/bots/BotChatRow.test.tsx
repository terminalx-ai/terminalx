import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Bot } from "@/types/bots";
import type { SessionEntry } from "@/types/session";

/**
 * PRO-521: a bot's chat is renamed and closed from its bot's Chat tab with the app's own session actions. The session
 * store, the row menu, the rename dialog, the archive notice and the delete confirmation are the real ones; only the
 * backend (`invoke`) and the views beside the chat list are stood in.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  bots: { loaded: true, bots: [] as Bot[], revision: 1, unreadable: 0, error: null as string | null, templates: null },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path, isTauri: () => false }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), message: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));
vi.mock("@/lib/bots", async (original) => ({ ...(await original<typeof import("@/lib/bots")>()), useBotStore: () => mocks.bots }));
vi.mock("@/components/session/SessionView", () => ({
  SessionView: ({ session, chrome }: { session: SessionEntry; chrome?: { leading?: ReactNode } }) => <div data-testid="session-view" data-session={session.id}>{chrome?.leading}</div>,
}));
vi.mock("@/components/bots/BotDuties", () => ({ BotDuties: () => null }));
vi.mock("@/components/bots/BotRoleMemory", () => ({ BotRoleMemory: () => null }));
vi.mock("./BotSettings", () => ({ BotSettings: () => null }));
vi.mock("./BotMenu", () => ({ BotMenu: () => null }));
vi.mock("./BotHandoffs", () => ({ HandoffStrip: () => null, TeamBriefEditor: () => null, TeamBriefRow: () => null }));
vi.mock("./BotRuns", () => ({ RunPlanCards: () => null, StartedRunRow: () => null }));

const { BotView } = await import("./BotView");
const { useStayOnBot } = await import("./useStayOnBot");
const { botViewFor } = await import("@/lib/botChats");
const { SessionDialogs } = await import("@/components/session/SessionDialogs");
const { ArchiveNotices } = await import("@/components/ui/ArchiveNotices");
const { ConfirmDialogHost } = await import("@/components/ui/ConfirmDialog");
const store = await import("@/lib/sessions");
const privacy = await import("@/lib/dataPrivacy");
const dialogs = await import("@/lib/dialogs");
const archive = await import("@/lib/archiveNotices");

const atlas: Bot = {
  id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
};
const chat = (id: string, title: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  id, kind: "quick", projectPath: `/scratch/${id}`, cwd: "/bots/b1", title, created: "2026-11-20T09:00:00Z", modified: "2026-11-20T09:00:00Z",
  archived: false, pinned: false, worktreeRemoved: false, activeTab: `${id}-tab`,
  tabs: [{ id: `${id}-tab`, title, harness: "claude", model: "", permissionMode: "auto", status: "idle", created: "", modified: "" }],
  ...extra,
} as SessionEntry);

let sessions: SessionEntry[];
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

/** The window around a bot's view, as AppShell mounts it: the view the store selects, and the app's own dialogs. */
function Window() {
  const state = store.useSessionStore();
  const selected = state.sessions.find((entry) => entry.id === state.selectedSessionId) ?? null;
  const botView = botViewFor(true, mocks.bots.bots, selected, state);
  useStayOnBot(true, mocks.bots.bots, botView);
  return (
    <TooltipProvider>
      {botView ? <BotView botId={botView.botId} chatId={botView.chatId} sidebarOpen onToggleSidebar={() => {}} titlebarInset={78} /> : <p data-testid="not-a-bot-view">{state.view}</p>}
      <SessionDialogs />
      <ArchiveNotices />
      <ConfirmDialogHost />
    </TooltipProvider>
  );
}

beforeEach(async () => {
  mocks.bots = { loaded: true, bots: [atlas], revision: 1, unreadable: 0, error: null, templates: null };
  sessions = [
    chat("home", "Home chat", { bot: { id: "b1", home: true } }),
    chat("check", "Check the runner", { bot: { id: "b1" }, modified: "2026-11-20T09:30:00Z" }),
    chat("duty", "Morning look around", { bot: { id: "b1" }, botDuty: { id: "d1" } } as Partial<SessionEntry>),
    chat("fix", "Fix the relay log", { kind: undefined, projectPath: "/repo", cwd: "/repo", parent: { sessionId: "check" }, botStarted: { id: "b1" } } as Partial<SessionEntry>),
  ];
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: unknown) => {
    if (command === "data_privacy_status") return { enabled: false, managed: false };
    if (command === "list_projects") return { projects: [], lastSelected: null };
    if (command === "list_sessions") return sessions;
    if (command === "list_harnesses") return [{ id: "claude", name: "Claude Code" }];
    if (command === "chats_dir") return "/store/Chats";
    if (command === "quick_chat_scratch") return { path: `/scratch/${(args as { sessionId: string }).sessionId}`, files: 0, more: false };
    if (command === "sole_workspace_of") return null;
    if (command === "set_sessions_archived") {
      const { sessionIds, archived } = args as { sessionIds: string[]; archived: boolean };
      sessions = sessions.map((entry) => (sessionIds.includes(entry.id) ? { ...entry, archived } : entry));
      return sessionIds.map((id) => sessions.find((entry) => entry.id === id)!);
    }
    return undefined;
  });
  await privacy.refreshDataPrivacy();
  await act(async () => {
    await store.bootSessions();
    await store.refreshEverything();
  });
  act(() => store.openBot("b1"));
});
afterEach(() => {
  cleanup();
  // The app's dialogs and notices are the window's, kept outside any one view: each test starts with none open.
  act(() => {
    dialogs.closeRenameSession();
    for (const notice of archive.getArchiveNotices()) archive.dismissArchiveNotice(notice.id);
  });
});

const group = (name: string) => within(screen.getByRole("region", { name }));
const titles = (name: string) => group(name).getAllByTestId("bot-chat-title").map((title) => title.textContent);
const row = (name: string, title: string) => group(name).getByText(title).closest("button")!;

async function openMenu(element: HTMLElement) {
  fireEvent.contextMenu(element);
  return within(await screen.findByRole("menu"));
}

describe("a bot's chats have the app's session actions (PRO-521)", () => {
  it("opens the sidebar's own session menu on a chat in every group, by right-click and by its ⋯", async () => {
    render(<Window />);
    for (const [name, title] of [["Chats with Atlas", "Check the runner"], ["Started by Atlas", "Fix the relay log"], ["Duty runs", "Morning look around"]]) {
      const menu = await openMenu(row(name, title));
      const items = menu.getAllByRole("menuitem").map((item) => item.textContent?.trim());
      expect(items, title).toEqual(expect.arrayContaining(["Mark as unreadR", "PinP", "Rename…", "Copy link", "Share session…", "Archive", "Delete session…"]));
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
    // The ⋯ on the row is the same list, for a pointer or the keyboard.
    fireEvent.keyDown(screen.getByRole("button", { name: "Menu for Check the runner" }), { key: "ArrowDown" });
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Rename…" })).toBeTruthy();
    expect(menu.getByRole("menuitem", { name: "Delete session…" })).toBeTruthy();
  });

  it("renames a chat with the app's rename dialog, and the new name is the session's and its tab's", async () => {
    render(<Window />);
    const menu = await openMenu(row("Chats with Atlas", "Check the runner"));
    fireEvent.click(menu.getByRole("menuitem", { name: "Rename…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Rename session" }));
    const field = dialog.getByRole("textbox", { name: "Session title" }) as HTMLInputElement;
    expect(field.value).toBe("Check the runner");
    fireEvent.change(field, { target: { value: "Runner secrets audit" } });
    fireEvent.click(dialog.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename session" })).toBeNull());

    // One rename, by the session commands every other view uses: the session's title, and its one tab's.
    expect(calls("rename_session")).toEqual([{ sessionId: "check", title: "Runner secrets audit" }]);
    expect(calls("rename_tab")).toEqual([{ sessionId: "check", tabId: "check-tab", title: "Runner secrets audit" }]);
    // The backend's answer, as every window hears it.
    const renamed = { ...sessions.find((entry) => entry.id === "check")!, title: "Runner secrets audit" };
    renamed.tabs = [{ ...renamed.tabs[0], title: "Runner secrets audit" }];
    act(() => mocks.listeners.get("session_updated")?.({ payload: renamed }));

    // The bot's page shows it, and so does the name the sidebar and search go by.
    expect(titles("Chats with Atlas")).toEqual(["Home chat", "Runner secrets audit"]);
    const entry = store.getSessionStore().sessions.find((candidate) => candidate.id === "check")!;
    expect([entry.title, store.conversationTitle(entry)]).toEqual(["Runner secrets audit", "Runner secrets audit"]);
    // Opened, its header carries the new name too.
    fireEvent.click(row("Chats with Atlas", "Runner secrets audit"));
    expect(screen.getByTestId("session-view").textContent).toBe("Runner secrets audit");
  });

  it("renames by double-click and by the menu's N key, as a sidebar row does", async () => {
    render(<Window />);
    fireEvent.doubleClick(row("Chats with Atlas", "Check the runner"));
    const dialog = within(await screen.findByRole("dialog", { name: "Rename session" }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename session" })).toBeNull());
    expect(calls("rename_session")).toEqual([]);

    await openMenu(row("Duty runs", "Morning look around"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "n" });
    expect(((await screen.findByRole("textbox", { name: "Session title" })) as HTMLInputElement).value).toBe("Morning look around");
  });

  it("renames the home chat, which then goes by its new name on the bot's page", async () => {
    render(<Window />);
    expect(titles("Chats with Atlas")[0]).toBe("Home chat");
    const menu = await openMenu(row("Chats with Atlas", "Home chat"));
    fireEvent.click(menu.getByRole("menuitem", { name: "Rename…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Rename session" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Session title" }), { target: { value: "Atlas desk" } });
    fireEvent.click(dialog.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(calls("rename_session")).toEqual([{ sessionId: "home", title: "Atlas desk" }]));
    await waitFor(() => expect(titles("Chats with Atlas")[0]).toBe("Atlas desk"));
    expect(calls("rename_tab")).toEqual([{ sessionId: "home", tabId: "home-tab", title: "Atlas desk" }]);
  });

  it("does not offer to archive or delete the home chat from its row", async () => {
    render(<Window />);
    // The row's own Archive button is on every chat but the home chat.
    expect(screen.queryByRole("button", { name: "Archive Home chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Archive Check the runner" })).toBeTruthy();
    const menu = await openMenu(row("Chats with Atlas", "Home chat"));
    const items = menu.getAllByRole("menuitem").map((item) => item.textContent?.trim());
    expect(items).toContain("Rename…");
    expect(items).not.toContain("Archive");
    expect(items).not.toContain("Delete session…");
  });

  it("archives a chat as any session is archived: it leaves the list, and Restore brings it back", async () => {
    render(<Window />);
    act(() => store.selectSession("check"));
    expect(screen.getByTestId("session-view").getAttribute("data-session")).toBe("check");
    const menu = await openMenu(row("Chats with Atlas", "Check the runner"));
    fireEvent.click(menu.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(titles("Chats with Atlas")).toEqual(["Home chat"]));
    expect(calls("set_session_archived")).toEqual([{ sessionId: "check", archived: true }]);
    expect(calls("delete_session")).toEqual([]);
    // The open chat was the one archived: not Welcome, the bot's page on its home chat.
    expect(store.getSessionStore()).toMatchObject({ view: "bot", selectedBotId: "b1", selectedSessionId: null });
    expect(screen.getByTestId("session-view").getAttribute("data-session")).toBe("home");
    // The app's own notice, with its undo.
    const notice = within(await screen.findByRole("status"));
    fireEvent.click(notice.getByRole("button", { name: /Restore/ }));
    await waitFor(() => expect(titles("Chats with Atlas")).toEqual(["Home chat", "Check the runner"]));
    expect(calls("set_session_archived")).toEqual([{ sessionId: "check", archived: true }, { sessionId: "check", archived: false }]);
  });

  it("archives from the row's own button, as a sidebar row does", async () => {
    render(<Window />);
    fireEvent.click(screen.getByRole("button", { name: "Archive Morning look around" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Duty runs" })).toBeNull());
    expect(calls("set_session_archived")).toEqual([{ sessionId: "duty", archived: true }]);
  });

  it("deletes a chat only after the app's confirmation, and stays on the bot when it was the open one", async () => {
    render(<Window />);
    act(() => store.selectSession("check"));
    let menu = await openMenu(row("Chats with Atlas", "Check the runner"));
    fireEvent.click(menu.getByRole("menuitem", { name: "Delete session…" }));
    const question = { name: 'Delete "Check the runner"?' };
    let confirm = within(await screen.findByRole("dialog", question));
    // Cancel keeps it.
    fireEvent.click(confirm.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", question)).toBeNull());
    expect(calls("delete_session")).toEqual([]);
    expect(titles("Chats with Atlas")).toEqual(["Home chat", "Check the runner"]);

    menu = await openMenu(row("Chats with Atlas", "Check the runner"));
    fireEvent.click(menu.getByRole("menuitem", { name: "Delete session…" }));
    confirm = within(await screen.findByRole("dialog", question));
    fireEvent.click(confirm.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls("delete_session")).toEqual([{ sessionId: "check" }]));
    await waitFor(() => expect(titles("Chats with Atlas")).toEqual(["Home chat"]));
    // Not Welcome: the bot's page, on its home chat.
    expect(screen.queryByTestId("not-a-bot-view")).toBeNull();
    expect(store.getSessionStore()).toMatchObject({ view: "bot", selectedBotId: "b1", selectedSessionId: null });
    expect(screen.getByTestId("session-view").getAttribute("data-session")).toBe("home");
  });

  it("leaves a reader who left the open chat themselves where they went", async () => {
    render(<Window />);
    act(() => store.selectSession("check"));
    act(() => store.openHome());
    expect(screen.getByTestId("not-a-bot-view").textContent).toBe("home");
  });

  it("goes to Welcome, as for any session, when the bot of the deleted chat is no longer listed", async () => {
    render(<Window />);
    act(() => store.selectSession("check"));
    mocks.bots = { ...mocks.bots, bots: [] };
    act(() => store.removeSessions(["check"]));
    expect(screen.getByTestId("not-a-bot-view").textContent).toBe("welcome");
  });
});
