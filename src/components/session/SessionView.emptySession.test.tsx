import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

// #721: opening a session with no tabs shows that session, never another one in the same folder.
// The real session, tab-layout and closed-tab stores run against the in-memory backend of `@/test/tabsBackend`.
vi.mock("@tauri-apps/api/core", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { invoke: backend.invoke, Channel: class {} };
});
vi.mock("@tauri-apps/api/event", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { listen: backend.listen };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), message: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => undefined), openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async () => undefined, label: "main" }) }));
vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-out", identity: null, expiresAt: null, lastError: null, organizations: [] } };
  return { useAccount: () => account, getAccount: () => account, subscribeAccount: () => () => undefined, refreshAccount: vi.fn() };
});
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  useModels: () => [],
  loadModels: vi.fn(),
}));
// A terminal is a box that says which one it is; the xterm is not under test.
vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: ({ id }: { id: string }) => <div data-testid="xterm">{id}</div>,
  createTerminal: () => undefined,
}));
vi.mock("@/components/browser/BrowserView", () => ({ BrowserView: () => <div data-testid="browser-view" /> }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));
vi.mock("@/components/chat/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
// The real sidebar, without what it shows beside the conversations.
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));

const { backend, FEATURE, MAIN, PROJECT, page: browserPage, session: sessionEntry, tab: tabEntry } = await import("@/test/tabsBackend");
const { bootSessions, refreshSessions, getSessionStore, useSessionStore } = await import("@/lib/sessions");
const { bootBrowser, refreshBrowserPages } = await import("@/lib/browser");
const { dropSessionTerminals } = await import("@/lib/terminal");
const { resetTabLayouts, getTabState } = await import("@/lib/tabLayouts");
const { UNDO_OFFERED_MS, resetCloseUndos } = await import("@/lib/closeUndo");
const { setPrefs } = await import("@/lib/prefs");
const { isMac } = await import("@/lib/shortcuts");
const { ProjectRail } = await import("@/components/layout/ProjectRail");
const { SessionView } = await import("./SessionView");
const { CloseUndoNotices } = await import("@/components/ui/CloseUndoNotices");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const QUICK = "/home/me/.raccoon/quick/quick-1";
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const store = () => getSessionStore();
const sessionOf = (id: string) => store().sessions.find((candidate) => candidate.id === id);
const closedAt = (second: number) => new Date(Date.UTC(2026, 10, 1, 19, 8, second)).toISOString();
const strip = () => screen.getByRole("tablist", { name: "Workspace tabs" });
const stripNames = () => within(strip()).getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"));

const sidebar = () => screen.getByRole("navigation", { name: "Sidebar" });
/** A session's own row in the sidebar, by its title (one alone on its branch is named "<branch>, <title>"; others end with when or where). */
const sessionRow = (title: string) => within(sidebar()).getByRole("button", { name: (name) => name.includes(title) && !name.startsWith("Menu for") });

/** The main window: the sidebar, and the slot for the open session as the app shell mounts it, one view per session. */
function Main() {
  const { sessions, selectedSessionId } = useSessionStore();
  const selected = sessions.find((candidate) => candidate.id === selectedSessionId);
  return (
    <TooltipProvider>
      <nav aria-label="Sidebar">
        <ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenStats={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} />
      </nav>
      {selected ? (
        <div key={selected.id} data-testid="main" data-session={selected.id}>
          <SessionView session={selected} sidebarOpen onToggleSidebar={() => undefined} />
        </div>
      ) : (
        <div data-testid="welcome" />
      )}
      <CloseUndoNotices />
    </TooltipProvider>
  );
}

/** A session with no tabs open in the project's own checkout, whose conversations were closed: the one #721 could not open. */
function emptySession(patch: Partial<SessionEntry> = {}): SessionEntry {
  return sessionEntry("empty", MAIN, [], { title: "Github preparation", pinned: true, ...patch });
}

async function load(sessions: SessionEntry[]) {
  backend.sessions = sessions;
  await refreshSessions();
  await flush();
}

/** Click a row of the sidebar, and let the session view open and settle. */
async function click(row: HTMLElement) {
  fireEvent.click(row);
  await flush();
  await flush();
}

/** ⌘⌥T, remapped to keys jsdom can press the same way on every platform. */
function pressReopen() {
  fireEvent.keyDown(document.body, { key: "y", code: "KeyY", shiftKey: true, metaKey: isMac, ctrlKey: !isMac });
}

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  backend.reset();
  await bootSessions();
  await refreshSessions();
  dropSessionTerminals(["a", "b", "other", "empty", "quick-1", "elsewhere"]);
  await bootBrowser();
  backend.pages = [];
  await refreshBrowserPages();
  resetTabLayouts();
  resetCloseUndos();
  // The defaults: the row of tabs on, a branch's sessions as its tabs.
  setPrefs({ tabStrip: true, branchSessions: "tabs", panelOpen: false, sidebarLayout: "simple", sidebarSections: {}, shortcuts: { "session.reopenTab": ["mod+shift+y"] } });
  backend.calls = [];
});

afterEach(() => {
  cleanup();
  resetCloseUndos();
});

describe("clicking a session with no tabs (#721)", () => {
  it("keeps it selected and shows its own page, beside a session in the same checkout that has tabs", async () => {
    await load([sessionEntry("other", MAIN, [tabEntry("o1", 4, { title: "Release GPU test" })]), emptySession()]);
    render(<Main />);
    await click(sessionRow("Github preparation"));
    expect(store().selectedSessionId).toBe("empty");
    expect(screen.getByTestId("main").dataset.session).toBe("empty");
    expect(screen.getByRole("heading", { name: "No tabs open" })).toBeTruthy();
    // Nothing was opened in it that nobody asked for.
    expect(backend.callsOf("pty_spawn")).toHaveLength(0);
    // And it stays: no later render takes it elsewhere.
    await flush();
    expect(store().selectedSessionId).toBe("empty");
    expect(sessionRow("Github preparation").getAttribute("aria-current")).toBe("true");
  });

  it("keeps it selected when the other session in the folder is a quick chat", async () => {
    const quick = sessionEntry("quick-1", MAIN, [tabEntry("q1", 4, { title: "I accidentally stopped session" })], { kind: "quick", projectPath: QUICK });
    await load([quick, emptySession()]);
    render(<Main />);
    await click(sessionRow("Github preparation"));
    expect(store().selectedSessionId).toBe("empty");
    expect(screen.getByRole("heading", { name: "No tabs open" })).toBeTruthy();
    // The quick chat is not this session's sibling: its tab is not in this session's row.
    expect(screen.queryByRole("tab", { name: "I accidentally stopped session" })).toBeNull();
  });

  it("keeps it selected when the other session in the folder belongs to another project", async () => {
    const elsewhere = sessionEntry("elsewhere", MAIN, [tabEntry("e1", 4, { title: "Another project's work" })], { projectPath: "/another-project" });
    await load([elsewhere, emptySession()]);
    render(<Main />);
    await click(sessionRow("Github preparation"));
    expect(store().selectedSessionId).toBe("empty");
    expect(screen.getByRole("heading", { name: "No tabs open" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Another project's work" })).toBeNull();
  });

  it("keeps it selected with a branch's sessions in the sidebar rather than as tabs", async () => {
    setPrefs({ tabStrip: false, branchSessions: "sidebar" });
    await load([sessionEntry("other", MAIN, [tabEntry("o1", 4)]), emptySession()]);
    render(<Main />);
    // The branch lists its sessions under it.
    await click(within(sidebar()).getByRole("button", { name: /^No branch/, expanded: false }));
    await click(sessionRow("Github preparation"));
    expect(store().selectedSessionId).toBe("empty");
    expect(screen.getByRole("heading", { name: "No tabs open" })).toBeTruthy();
  });

  it("keeps its own page when another session opened a browser page in the same folder, until that page is picked", async () => {
    const quick = sessionEntry("quick-1", MAIN, [tabEntry("q1", 4, { title: "Quick question" })], { kind: "quick", projectPath: QUICK });
    await load([quick, emptySession()]);
    // A page belongs to its folder: the quick chat's is listed with every session there.
    backend.pages = [browserPage("quick-page", MAIN, 9, { title: "The quick chat's page" })];
    await refreshBrowserPages();
    render(<Main />);
    await click(sessionRow("Github preparation"));
    expect(screen.getByRole("heading", { name: "No tabs open" })).toBeTruthy();
    const pageTab = within(strip()).getByRole("tab", { name: "The quick chat's page" });
    expect(pageTab.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTestId("browser-view").closest('[role="tabpanel"]')!.getAttribute("aria-hidden")).toBe("true");
    // Picked, it is shown in this session.
    await click(pageTab);
    expect(store().selectedSessionId).toBe("empty");
    expect(screen.queryByRole("heading", { name: "No tabs open" })).toBeNull();
    expect(screen.getByTestId("browser-view").closest('[role="tabpanel"]')!.getAttribute("aria-hidden")).toBe("false");
  });
});

describe("the page of a session with no tabs", () => {
  beforeEach(async () => {
    await load([sessionEntry("other", MAIN, [tabEntry("o1", 4)]), emptySession()]);
    const closed = (id: string, title: string, second: number, conversation: string) => ({
      sessionId: "empty",
      tab: tabEntry(id, second, { title, providerSessionId: conversation }),
      closedAt: closedAt(second),
    });
    backend.closed = [
      closed("old", "Draft the release notes", 1, "conversation-old"),
      closed("latest", "Continue work from the prior TerminalX", 54, "conversation-latest"),
      closed("middle", "Review the hook", 30, "conversation-middle"),
      // A sibling's, closed after all of them: not this page's to list or to reopen.
      { sessionId: "other", tab: tabEntry("other-closed", 2, { title: "Not this session's" }), closedAt: closedAt(59) },
    ];
    backend.emit("tab_state_changed", { workspaces: {}, closed: structuredClone(backend.closed) });
    await flush();
  });

  it("lists its closed tabs, newest first, and none of another session's", async () => {
    render(<Main />);
    await click(sessionRow("Github preparation"));
    const list = screen.getByRole("region", { name: "Closed tabs" });
    const reopen = within(list).getAllByRole("button", { name: /^Reopen / }).map((button) => button.getAttribute("aria-label"));
    expect(reopen).toEqual(["Reopen Continue work from the prior TerminalX", "Reopen Review the hook", "Reopen Draft the release notes"]);
    expect(within(list).queryByText("Not this session's")).toBeNull();
    // New tab and Reopen closed tab, as welcome offers after the last tab closes.
    const page = screen.getByTestId("empty-session");
    expect(within(page).getByRole("button", { name: "New tab" })).toBeTruthy();
    expect(within(page).getByRole("button", { name: /Reopen closed tab/ })).toBeTruthy();
  });

  it("opens a new tab in this session from its New tab", async () => {
    render(<Main />);
    await click(sessionRow("Github preparation"));
    const page = screen.getByTestId("empty-session");
    fireEvent.pointerDown(within(page).getByRole("button", { name: "New tab" }), { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Terminal on this computer" }));
    await waitFor(() => expect(backend.callsOf("pty_spawn")).toHaveLength(1));
    expect(String(backend.callsOf("pty_spawn")[0].id).startsWith("empty:")).toBe(true);
    expect(store().selectedSessionId).toBe("empty");
  });

  it("reopens this session's last closed tab from Reopen closed tab, never a sibling's closed since", async () => {
    render(<Main />);
    await click(sessionRow("Github preparation"));
    // `other` shares this row of tabs, and its tab was closed last.
    expect(stripNames()).toContain("Claude Code");
    fireEvent.click(within(screen.getByTestId("empty-session")).getByRole("button", { name: /Reopen closed tab/ }));
    await waitFor(() => expect(backend.callsOf("reopen_tab")).toEqual([{ sessionId: "empty", tabId: "latest" }]));
    await flush();
    expect(store().selectedSessionId).toBe("empty");
  });

  it("reopens this session's last closed tab on ⌘⌥T while the page is shown", async () => {
    render(<Main />);
    await click(sessionRow("Github preparation"));
    act(pressReopen);
    await waitFor(() => expect(backend.callsOf("reopen_tab")).toEqual([{ sessionId: "empty", tabId: "latest" }]));
    await flush();
    expect(store().selectedSessionId).toBe("empty");
  });

  it("offers no Reopen closed tab when nothing of this session's was closed", async () => {
    backend.closed = backend.closed.filter((closed) => closed.sessionId !== "empty");
    backend.emit("tab_state_changed", { workspaces: {}, closed: structuredClone(backend.closed) });
    render(<Main />);
    await click(sessionRow("Github preparation"));
    expect((within(screen.getByTestId("empty-session")).getByRole("button", { name: /Reopen closed tab/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("region", { name: "Closed tabs" })).toBeNull();
  });

  it("reopens a closed tab on its conversation, in this session, and shows it", async () => {
    render(<Main />);
    await click(sessionRow("Github preparation"));
    fireEvent.click(screen.getByRole("button", { name: "Reopen Review the hook" }));
    await waitFor(() => expect(backend.callsOf("reopen_tab")).toEqual([{ sessionId: "empty", tabId: "middle" }]));
    await flush();
    // In this session, not another: the same tab, with the same conversation, on screen.
    expect(store().selectedSessionId).toBe("empty");
    expect(sessionOf("empty")!.tabs.map((tab) => [tab.id, tab.providerSessionId])).toEqual([["middle", "conversation-middle"]]);
    expect(sessionOf("other")!.tabs.map((tab) => tab.id)).toEqual(["o1"]);
    expect(screen.getByRole("tab", { name: "Review the hook" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: "No tabs open" })).toBeNull();
    // Shown, its agent is asked for on that conversation.
    await waitFor(() => expect(backend.callsOf("ensure_tab_started")).toContainEqual({ sessionId: "empty", tabId: "middle", opened: true }));
    // It is no longer a closed tab.
    expect(getTabState().closed.map((closed) => closed.tab.id)).not.toContain("middle");
  });

  it("says why when a closed tab cannot be reopened, and lists what the backend still has", async () => {
    render(<Main />);
    await click(sessionRow("Github preparation"));
    // Gone from the backend behind this window's back.
    backend.closed = backend.closed.filter((closed) => closed.tab.id !== "old");
    fireEvent.click(screen.getByRole("button", { name: "Reopen Draft the release notes" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await flush();
    expect(store().selectedSessionId).toBe("empty");
    expect(within(screen.getByRole("region", { name: "Closed tabs" })).queryByText("Draft the release notes")).toBeNull();
  });
});

describe("a branch's sessions as tabs", () => {
  it("still share one row, and clicking either keeps that session selected, the one with no tabs included", async () => {
    // `a` and `b` are on the same worktree and branch, with tabs; `c`, there too, had its last tab closed.
    const c = sessionEntry("c", FEATURE, [], { worktreeName: "feature", branch: "feature", title: "Session c" });
    await load([...backend.sessions.filter((entry) => entry.id !== "other"), c]);
    render(<Main />);
    // In the sidebar the branch is one row for `a` and `b`, whose tabs share the row of tabs; `c` has a row of its own.
    await click(within(sidebar()).getByRole("button", { name: "feature, 2 sessions" }));
    const opened = store().selectedSessionId;
    expect(["a", "b"]).toContain(opened);
    expect(stripNames()).toEqual(expect.arrayContaining(["Docs", "Review"]));

    // Clicking a tab of either in the row opens that tab's own session, on that tab.
    await click(within(strip()).getByRole("tab", { name: "Docs" }));
    expect(store().selectedSessionId).toBe("b");
    expect(within(strip()).getByRole("tab", { name: "Docs" }).getAttribute("aria-selected")).toBe("true");
    await click(within(strip()).getByRole("tab", { name: "Review" }));
    expect(store().selectedSessionId).toBe("a");
    expect(within(strip()).getByRole("tab", { name: "Review" }).getAttribute("aria-selected")).toBe("true");

    // The empty sibling is opened as itself from its own row: its page under the branch's row of tabs, no tab of another session picked.
    await click(sessionRow("Session c"));
    expect(store().selectedSessionId).toBe("c");
    expect(screen.getByRole("heading", { name: "No tabs open" })).toBeTruthy();
    expect(stripNames()).toEqual(expect.arrayContaining(["Docs", "Review"]));
    expect(within(strip()).queryAllByRole("tab").filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(0);
  });

  it("does not join sessions of the project's own checkout that work on different branches", async () => {
    await load([
      sessionEntry("on-main", MAIN, [tabEntry("m1", 1, { title: "On main" })], { branch: "main" }),
      sessionEntry("on-fix", MAIN, [tabEntry("f1", 2, { title: "On the fix" })], { branch: "fix/login" }),
    ]);
    render(<Main />);
    await click(within(sidebar()).getByRole("button", { name: /^main, / }));
    expect(store().selectedSessionId).toBe("on-main");
    expect(stripNames()).toEqual(["On main"]);
    expect(PROJECT).toBe(MAIN);
  });
});

describe("closing a session's last running tab", () => {
  beforeEach(async () => {
    await load([
      sessionEntry("other", MAIN, [tabEntry("o1", 4, { title: "Continue work from the prior TerminalX", providerSessionId: "conversation-o1" })], { title: "Github preparation" }),
      ...backend.sessions.filter((entry) => entry.id !== "other"),
    ]);
  });

  it("offers Undo, which reopens it on the same conversation", async () => {
    render(<Main />);
    await click(within(sidebar()).getByRole("button", { name: /^No branch, / }));
    expect(store().selectedSessionId).toBe("other");
    fireEvent.click(within(strip()).getByRole("button", { name: "Close Continue work from the prior TerminalX" }));
    await waitFor(() => expect(backend.callsOf("remove_tab")).toEqual([{ sessionId: "other", tabId: "o1" }]));
    // The last tab closed: the window is at welcome, and the notice says the agent stopped.
    const notice = await screen.findByTestId("close-undo");
    expect(notice.textContent).toContain("Closed “Continue work from the prior TerminalX”");
    expect(notice.textContent).toContain("stopped its agent");

    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(backend.callsOf("reopen_tab")).toEqual([{ sessionId: "other", tabId: "o1" }]));
    await flush();
    expect(store().selectedSessionId).toBe("other");
    expect(sessionOf("other")!.tabs.map((tab) => [tab.id, tab.providerSessionId])).toEqual([["o1", "conversation-o1"]]);
    expect(screen.getByRole("tab", { name: "Continue work from the prior TerminalX" }).getAttribute("aria-selected")).toBe("true");
    // Done: nothing is offered twice.
    expect(screen.queryByTestId("close-undo")).toBeNull();
  });

  it("keeps the notice, with why, when Undo fails, past the time it is offered for", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Main />);
      await click(within(sidebar()).getByRole("button", { name: /^No branch, / }));
      fireEvent.click(within(strip()).getByRole("button", { name: "Close Continue work from the prior TerminalX" }));
      const notice = await screen.findByTestId("close-undo");
      // The backend let go of the closed tab behind this window's back.
      backend.closed = [];
      fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(within(screen.getByTestId("close-undo")).getByRole("alert").textContent).toContain("is not a closed tab"));
      // Long past the time Undo is offered for: what went wrong stays to be read.
      await act(async () => void vi.advanceTimersByTime(UNDO_OFFERED_MS * 2));
      const kept = screen.getByTestId("close-undo");
      expect(within(kept).getByRole("alert").textContent).toContain("is not a closed tab");
      // Nothing is left to undo: it waits to be dismissed.
      expect(within(kept).queryByRole("button", { name: "Undo" })).toBeNull();
      fireEvent.click(within(kept).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByTestId("close-undo")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is withdrawn when its time is up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Main />);
      await click(within(sidebar()).getByRole("button", { name: /^No branch, / }));
      fireEvent.click(within(strip()).getByRole("button", { name: "Close Continue work from the prior TerminalX" }));
      await screen.findByTestId("close-undo");
      await act(async () => void vi.advanceTimersByTime(UNDO_OFFERED_MS));
      expect(screen.queryByTestId("close-undo")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers nothing when the session keeps an agent tab open", async () => {
    render(<Main />);
    await click(within(sidebar()).getByRole("button", { name: "feature, 2 sessions" }));
    // `a` has three agent tabs: closing one leaves two running.
    await click(within(strip()).getByRole("tab", { name: "Review" }));
    expect(store().selectedSessionId).toBe("a");
    fireEvent.click(within(strip()).getByRole("button", { name: "Close Review" }));
    await waitFor(() => expect(backend.callsOf("remove_tab")).toEqual([{ sessionId: "a", tabId: "a3" }]));
    await flush();
    expect(screen.queryByTestId("close-undo")).toBeNull();
  });
});
