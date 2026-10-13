import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { backend, FEATURE } = await import("@/test/tabsBackend");
const { TabsHarness } = await import("@/test/TabsHarness");
const { bootSessions, refreshSessions, selectSession, getSessionStore } = await import("@/lib/sessions");
const { bootBrowser, refreshBrowserPages } = await import("@/lib/browser");
const { dropSessionTerminals, openTerminal, setSelectedAgent } = await import("@/lib/terminal");
const { resetTabLayouts } = await import("@/lib/tabLayouts");
const { dropIndex, stripTabId } = await import("./WorkspaceTabStrip");

const LONG = "Refactor the authentication middleware to use the new token service";
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const strip = () => screen.getByRole("tablist", { name: "Workspace tabs" });
const tabs = () => within(strip()).getAllByRole("tab");
const names = () => tabs().map((tab) => tab.getAttribute("aria-label"));
const tab = (name: string) => within(strip()).getByRole("tab", { name });
const shown = () => tabs().filter((item) => item.getAttribute("aria-selected") === "true").map((item) => item.getAttribute("aria-label"));
/** The sidebar's tab rows under one session, in order. */
const rows = (session: string) => within(within(screen.getByRole("tree", { name: "Sidebar" })).getByRole("treeitem", { name: `Session ${session}` })).getAllByRole("treeitem");
const rowNames = (session: string) => rows(session).map((row) => row.getAttribute("aria-label"));
const savedOrder = () => (backend.callsOf("set_tab_layout").at(-1)?.layout as { order: string[] } | undefined)?.order;

/** jsdom lays nothing out: give each tab a 100 px box in a row, in the order they are in. */
function layOut() {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = this.dataset.tabKey ? [...this.parentElement!.querySelectorAll("[data-tab-key]")].indexOf(this) : 0;
    const left = index * 100;
    return { left, right: left + 100, width: 100, top: 0, bottom: 28, height: 28, x: left, y: 0, toJSON() {} } as DOMRect;
  });
}

let shell = "";

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  backend.reset();
  await bootSessions();
  await refreshSessions();
  dropSessionTerminals(["a", "b", "other"]);
  await bootBrowser();
  await refreshBrowserPages();
  resetTabLayouts();
  shell = (await openTerminal("a", FEATURE)).id;
  await openTerminal("other", "/repo");
  selectSession("a");
  setSelectedAgent("a", "a1");
  backend.calls = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the tab strip", () => {
  it("shows every tab of the open workspace, in the sidebar's order, each with its icon, a shortened title and its state", () => {
    render(<TabsHarness />);
    expect(names()).toEqual([LONG, "Fix flaky test", "Review", "Docs", "Page page-feature", "Terminal 1"]);
    for (const item of tabs()) {
      expect(item.querySelector("svg")).toBeTruthy();
      // The title is one line, cut with an ellipsis when it does not fit.
      expect(item.querySelector("span.truncate")?.textContent).toBe(item.getAttribute("aria-label"));
    }
    // Kind and state in words, for a screen reader as on the hover.
    expect(tab("Fix flaky test").getAttribute("aria-description")).toBe("Codex, working");
    expect(tab("Review").getAttribute("aria-description")).toBe("Claude Code, waiting for an answer");
    expect(tab("Docs").getAttribute("aria-description")).toBe("Codex, unread reply");
    expect(tab("Terminal 1").getAttribute("aria-description")).toBe("Terminal");
    // The same indicator as the sidebar row: a stripe in the state's colour.
    expect(tab("Fix flaky test").querySelector("span[aria-hidden].bg-info")).toBeTruthy();
    expect(tab("Review").querySelector("span[aria-hidden].bg-warning")).toBeTruthy();
    // One row for the workspace: both sessions' tabs, and nothing of the other workspace.
    expect(screen.queryByRole("tab", { name: "A tab of another workspace" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Page page-main" })).toBeNull();
    // The sidebar lists each session's part of the same row.
    expect(rowNames("a")).toEqual([LONG, "Fix flaky test", "Review", "Page page-feature browser page", "Terminal 1"]);
    expect(rowNames("b")).toEqual(["Docs", "Page page-feature browser page"]);
  });

  it("draws a tab as what runs in its terminal now, in the place it has always had", async () => {
    const a2 = backend.sessions.find((session) => session.id === "a")!.tabs.find((candidate) => candidate.id === "a2")!;
    // Its agent left the terminal in the middle of a turn: the tab is a terminal.
    Object.assign(a2, { front: "terminal", terminalTitle: "Terminal 4" });
    await refreshSessions();
    render(<TabsHarness />);
    expect(names()).toEqual([LONG, "Terminal 4", "Review", "Docs", "Page page-feature", "Terminal 1"]);
    expect(tab("Terminal 4").getAttribute("aria-description")).toBe("Terminal");
    // A terminal's icon, and nothing of the state its agent was last in.
    expect(tab("Terminal 4").querySelector("svg")?.getAttribute("class")).toBe(tab("Terminal 1").querySelector("svg")?.getAttribute("class"));
    expect(tab("Terminal 4").querySelector("span[aria-hidden].bg-info")).toBeNull();
    expect(rowNames("a")).toEqual([LONG, "Terminal 4", "Review", "Page page-feature browser page", "Terminal 1"]);
    // An agent is started in it again: the same tab, where it was, as that agent's.
    Object.assign(a2, { front: "by_hand" });
    await act(async () => void (await refreshSessions()));
    expect(names()).toEqual([LONG, "Fix flaky test", "Review", "Docs", "Page page-feature", "Terminal 1"]);
    expect(tab("Fix flaky test").getAttribute("aria-description")).toBe("Codex, working");
    expect(tab("Fix flaky test").querySelector("span[aria-hidden].bg-info")).toBeTruthy();
  });

  it("marks the open tab, and a tab's panel is named by its tab in the strip", () => {
    render(<TabsHarness />);
    expect(shown()).toEqual([LONG]);
    expect(tab(LONG).id).toBe(stripTabId({ kind: "agent", id: "a1" }));
    expect(tab(LONG).getAttribute("aria-controls")).toBe("session-agent-panel-a1");
    // The strip's ids are its own: none is used twice, and none is a sidebar row's.
    const ids = tabs().map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sidebar = new Set([...screen.getByRole("tree", { name: "Sidebar" }).querySelectorAll("[id]")].map((element) => element.id));
    expect(ids.filter((id) => sidebar.has(id))).toEqual([]);
  });

  it("switches on a click, and the sidebar's selection follows; a click in the sidebar moves the strip's", async () => {
    render(<TabsHarness />);
    fireEvent.click(tab("Fix flaky test"));
    expect(shown()).toEqual(["Fix flaky test"]);
    expect(rows("a").find((row) => row.getAttribute("aria-selected") === "true")?.getAttribute("aria-label")).toBe("Fix flaky test");
    expect(backend.callsOf("set_active_tab").at(-1)).toEqual({ sessionId: "a", tabId: "a2" });

    fireEvent.click(rows("a").find((row) => row.getAttribute("aria-label") === "Terminal 1")!);
    expect(shown()).toEqual(["Terminal 1"]);

    // A tab of the workspace's other session: its session is opened with it.
    fireEvent.click(tab("Docs"));
    await flush();
    expect(getSessionStore().selectedSessionId).toBe("b");
    expect(shown()).toEqual(["Docs"]);
    expect(rows("b").find((row) => row.getAttribute("aria-selected") === "true")?.getAttribute("aria-label")).toBe("Docs");
    // The row is the workspace's, so it is the same row.
    expect(names()).toEqual([LONG, "Fix flaky test", "Review", "Docs", "Page page-feature", "Terminal 1"]);
  });

  it("shows the full title, the agent and the state on keyboard focus and on hover", async () => {
    render(<TabsHarness />);
    fireEvent.focus(tab("Review"));
    const focused = await screen.findByRole("tooltip");
    expect(focused.textContent).toContain("Review");
    expect(focused.textContent).toContain("Claude Code · waiting for an answer");
    // The workspace has two sessions: which one a tab belongs to is on its hover, and nowhere in the row.
    expect(focused.textContent).toContain("Session: Session a");
    fireEvent.blur(tab("Review"));

    fireEvent.pointerMove(tab(LONG), { pointerType: "mouse" });
    await waitFor(() => expect(screen.getAllByTestId("tab-tooltip-title").some((title) => title.textContent === LONG)).toBe(true), { timeout: 2000 });
  });

  it("closes a tab from its close button and on a middle click, through the usual close", async () => {
    render(<TabsHarness />);
    fireEvent.click(within(strip().parentElement!).getByRole("button", { name: "Close Fix flaky test" }));
    await flush();
    expect(backend.callsOf("remove_tab")).toEqual([{ sessionId: "a", tabId: "a2" }]);
    expect(names()).not.toContain("Fix flaky test");
    fireEvent(tab("Terminal 1").parentElement!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await flush();
    expect(backend.callsOf("pty_kill")).toEqual([{ id: shell }]);
    expect(names()).toEqual([LONG, "Review", "Docs", "Page page-feature"]);
    // Every close button says what it closes.
    const closers = [...strip().querySelectorAll("[data-tab-close]")];
    expect(closers.map((button) => button.getAttribute("aria-label"))).toEqual([`Close ${LONG}`, "Close Review", "Close Docs", "Close Page page-feature"]);
  });

  it("moves the focus along the row with the arrows, Home and End", () => {
    render(<TabsHarness />);
    // One tab stop for the row: the open tab.
    expect(tabs().filter((item) => item.tabIndex === 0).map((item) => item.getAttribute("aria-label"))).toEqual([LONG]);
    tab(LONG).focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Fix flaky test"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(tab("Terminal 1"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab(LONG));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Terminal 1"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(tab(LONG));
    // Moving the focus opens nothing; Return on the button does (a click).
    expect(shown()).toEqual([LONG]);
  });

  it("opens the tab's menu on a right-click", async () => {
    render(<TabsHarness />);
    fireEvent.contextMenu(tab("Review").parentElement!);
    expect(await screen.findByRole("menuitem", { name: "Rename…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Close other tabs…" })).toBeTruthy();
  });

  it("draws nothing for a single tab where a strip would only repeat it", () => {
    selectSession("other");
    const { container } = render(<TabsHarness hideSingle />);
    expect(container.querySelector('[data-testid="workspace-tab-strip"]')).toBeTruthy();
    cleanup();
    backend.pages = backend.pages.filter((page) => page.id !== "page-main");
    dropSessionTerminals(["other"]);
    return act(async () => {
      await refreshBrowserPages();
      const again = render(<TabsHarness hideSingle />);
      expect(again.container.querySelector('[data-testid="workspace-tab-strip"]')).toBeNull();
    });
  });

  it("still shows the tabs to someone who may not change them, with nothing to close or drag", () => {
    const rects = layOut();
    render(<TabsHarness readOnlyReason="View only: this session is shared with you to watch." />);
    expect(names()).toHaveLength(6);
    expect(strip().querySelector("[data-tab-close]")).toBeNull();
    fireEvent.pointerDown(tab("Terminal 1").parentElement!, { button: 0, clientX: 550 });
    fireEvent.pointerMove(window, { clientX: 20 });
    fireEvent.pointerUp(window);
    expect(backend.callsOf("set_tab_layout")).toEqual([]);
    rects.mockRestore();
  });
});

describe("a crowded strip", () => {
  it("scrolls, lists every tab by its full title in a menu, and keeps the open tab in view", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tablist" ? 900 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tablist" ? 300 : 0;
    });
    render(<TabsHarness />);
    const all = screen.getByRole("button", { name: "All tabs (6)" });
    fireEvent.click(all);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `${LONG}Claude Code`,
      "Fix flaky testCodex · working",
      "ReviewClaude Code · waiting for an answer",
      "DocsCodex · unread reply",
      "Page page-featureBrowser page",
      "Terminal 1Terminal",
    ]);
    expect(items[0].getAttribute("aria-current")).toBe("true");
    fireEvent.click(items[5]);
    await flush();
    expect(shown()).toEqual(["Terminal 1"]);
    // The tab that is opened is scrolled into view.
    const scrolled = vi.mocked(Element.prototype.scrollIntoView).mock.contexts.at(-1) as HTMLElement;
    expect(scrolled.dataset.tabKey).toBe(`terminal:${shell}`);
  });

  it("has no menu while the tabs fit", () => {
    render(<TabsHarness />);
    expect(screen.queryByRole("button", { name: /^All tabs/ })).toBeNull();
  });
});

describe("dragging a tab", () => {
  it("works out where a tab lands from where the pointer is", () => {
    const rects = [0, 100, 200, 300].map((left) => ({ left, width: 100 }));
    // Dragged left over the first tab's first half: it becomes the first.
    expect(dropIndex(rects, 3, 20)).toBe(0);
    expect(dropIndex(rects, 3, 160)).toBe(2);
    // Over its own place, or just beside it, it stays.
    expect(dropIndex(rects, 1, 150)).toBe(1);
    expect(dropIndex(rects, 1, 90)).toBe(1);
    // Dragged right past everything: it becomes the last.
    expect(dropIndex(rects, 0, 999)).toBe(3);
    expect(dropIndex(rects, 0, 260)).toBe(2);
  });

  it("shows where it will land, moves it there on release, saves the order, and the sidebar follows", async () => {
    layOut();
    render(<TabsHarness />);
    fireEvent.pointerDown(tab("Review").parentElement!, { button: 0, clientX: 250 });
    // A small movement is still a click.
    fireEvent.pointerMove(window, { clientX: 248 });
    expect(screen.queryByTestId("tab-drop-indicator")).toBeNull();
    fireEvent.pointerMove(window, { clientX: 30 });
    const line = screen.getByTestId("tab-drop-indicator");
    expect(line.style.left).toBe("0px");
    expect(tab("Review").parentElement!.dataset.dragging).toBe("true");
    fireEvent.pointerUp(window);
    // The click that ends the press is not a click on the tab under the pointer.
    fireEvent.click(tab("Review"));
    expect(shown()).toEqual([LONG]);
    await flush();
    expect(screen.queryByTestId("tab-drop-indicator")).toBeNull();
    expect(names()).toEqual(["Review", LONG, "Fix flaky test", "Docs", "Page page-feature", "Terminal 1"]);
    expect(savedOrder()).toEqual(["agent:a3", "agent:a1", "agent:a2", "agent:b1", "browser:page-feature", `terminal:${shell}`]);
    expect(rowNames("a").slice(0, 3)).toEqual(["Review", LONG, "Fix flaky test"]);
    // The next click is an ordinary one.
    fireEvent.click(tab("Review"));
    expect(shown()).toEqual(["Review"]);
  });

  it("moves a tab next to another session's without changing whose it is", async () => {
    layOut();
    render(<TabsHarness />);
    fireEvent.pointerDown(tab("Docs").parentElement!, { button: 0, clientX: 350 });
    fireEvent.pointerMove(window, { clientX: 110 });
    fireEvent.pointerUp(window);
    await flush();
    expect(names().slice(0, 3)).toEqual([LONG, "Docs", "Fix flaky test"]);
    expect(rowNames("b")[0]).toBe("Docs");
    expect(getSessionStore().sessions.find((session) => session.id === "b")!.tabs.map((item) => item.id)).toEqual(["b1"]);
  });

  it("is put back by Escape, and Escape does nothing else while a tab is held", async () => {
    layOut();
    render(<TabsHarness />);
    fireEvent.pointerDown(tab("Terminal 1").parentElement!, { button: 0, clientX: 550 });
    fireEvent.pointerMove(window, { clientX: 30 });
    expect(screen.getByTestId("tab-drop-indicator")).toBeTruthy();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(screen.queryByTestId("tab-drop-indicator")).toBeNull();
    fireEvent.pointerUp(window);
    await flush();
    expect(names()).toEqual([LONG, "Fix flaky test", "Review", "Docs", "Page page-feature", "Terminal 1"]);
    expect(backend.callsOf("set_tab_layout")).toEqual([]);
  });

  it("does not start from the close button, nor with another mouse button", () => {
    layOut();
    render(<TabsHarness />);
    fireEvent.pointerDown(strip().querySelector("[data-tab-close]")!, { button: 0, clientX: 80 });
    fireEvent.pointerMove(window, { clientX: 500 });
    expect(screen.queryByTestId("tab-drop-indicator")).toBeNull();
    fireEvent.pointerUp(window);
    fireEvent.pointerDown(tab("Review").parentElement!, { button: 2, clientX: 250 });
    fireEvent.pointerMove(window, { clientX: 20 });
    expect(screen.queryByTestId("tab-drop-indicator")).toBeNull();
    // A tab is never a place the window is dragged from.
    for (const item of tabs()) expect(item.parentElement!.getAttribute("data-tauri-drag-region")).toBe("false");
  });
});
