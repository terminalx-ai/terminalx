import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { invoke: backend.invoke, Channel: class {} };
});
vi.mock("@tauri-apps/api/event", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { listen: backend.listen };
});
const native = vi.hoisted(() => ({ ask: vi.fn(async () => true), reveal: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: native.ask, message: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: native.reveal, openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async () => undefined, label: "main" }) }));
// The menu's parts drawn in place, submenus open: what is offered is what is in the document.
vi.mock("@/components/ui/menu", () => {
  const Item = ({ children, onSelect, disabled }: { children: ReactNode; onSelect?: () => void; disabled?: boolean }) => (
    <div role="menuitem" aria-disabled={disabled || undefined} onClick={() => !disabled && onSelect?.()}>{children}</div>
  );
  const Pass = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    ContextMenuItem: Item,
    ContextMenuCheckboxItem: ({ children, checked, onCheckedChange, disabled }: { children: ReactNode; checked?: boolean; onCheckedChange?: (on: boolean) => void; disabled?: boolean }) => (
      <div role="menuitemcheckbox" aria-checked={!!checked} aria-disabled={disabled || undefined} onClick={() => !disabled && onCheckedChange?.(!checked)}>{children}</div>
    ),
    ContextMenuSubTrigger: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => <div role="menuitem" aria-haspopup="menu" aria-disabled={disabled || undefined}>{children}</div>,
    ContextMenuLabel: ({ children }: { children: ReactNode }) => <div role="note">{children}</div>,
    ContextMenuSeparator: () => <hr />,
    ContextMenuSub: Pass,
    ContextMenuSubContent: Pass,
    MenuShortcut: () => null,
  };
});

const { backend, FEATURE } = await import("@/test/tabsBackend");
const { bootSessions, refreshSessions, selectSession, useSessionStore, getSessionStore } = await import("@/lib/sessions");
const { bootBrowser, refreshBrowserPages } = await import("@/lib/browser");
const { dropSessionTerminals, openTerminal, setSelectedAgent, getTerminalState } = await import("@/lib/terminal");
const { getTabState, layoutOf, resetTabLayouts } = await import("@/lib/tabLayouts");
const { useTabRow } = await import("@/lib/sessionTabs");
const { useDialogs } = await import("@/lib/dialogs");
const { TabMenuItems } = await import("./TabMenu");

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

/** The menu of one tab of the open session's workspace, and which dialog it asked for. */
function Menu({ tab, readOnlyReason }: { tab: string; readOnlyReason?: string }) {
  const store = useSessionStore();
  const session = store.sessions.find((candidate) => candidate.id === store.selectedSessionId)!;
  const row = useTabRow(session);
  const dialogs = useDialogs();
  const target = row.tabs.find((candidate) => candidate.key === tab);
  const selected = getTerminalState().selected[session.id] ?? null;
  return (
    <>
      {target ? <TabMenuItems row={row} tab={target} selected={selected} readOnlyReason={readOnlyReason} /> : null}
      <output data-testid="asked">{JSON.stringify({ rename: dialogs.renameTab, close: dialogs.closeTabs })}</output>
      <output data-testid="row">{row.tabs.map((item) => item.key).join(",")}</output>
    </>
  );
}

const items = () => screen.getAllByRole("menuitem").map((item) => item.textContent?.trim() ?? "");
const item = (name: string) => screen.getAllByRole("menuitem").find((candidate) => candidate.textContent?.trim() === name)!;
const offered = (name: string) => items().includes(name);
const choose = async (name: string) => {
  fireEvent.click(item(name));
  await flush();
};
const order = () => screen.getByTestId("row").textContent!.split(",");
const asked = () => JSON.parse(screen.getByTestId("asked").textContent!);
const layout = () => layoutOf(getTabState(), FEATURE);

let shell = "";

beforeEach(async () => {
  backend.reset();
  await bootSessions();
  await refreshSessions();
  dropSessionTerminals(["a", "b", "other"]);
  await bootBrowser();
  await refreshBrowserPages();
  resetTabLayouts();
  shell = (await openTerminal("a", FEATURE)).id;
  selectSession("a");
  setSelectedAgent("a", "a1");
  backend.calls = [];
  native.ask.mockClear();
  native.reveal.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});

afterEach(cleanup);

describe("a tab's right-click menu", () => {
  it("offers an agent tab everything that applies to one, and nothing that does not", () => {
    render(<Menu tab="agent:a3" />);
    expect(items()).toEqual([
      "Rename…",
      "Switch to terminal view",
      "Duplicate tab",
      "Fork conversation",
      "Open in floating window",
      "Restart agent",
      "Copy",
      "Tab title",
      "Working directory",
      "Conversation id",
      "Reveal working directory in the file manager",
      "Skills for this agent…",
      "Pin tab",
      "Mute notifications for this tab",
      "Session “Session a”",
      "Archive",
      "Share…",
      "Link to issue…",
      "Delete…",
      "Move tab",
      "Move tab left",
      "Move tab right",
      "Move to start",
      "Move to end",
      "Close tab",
      "Close other tabs…",
      "Close tabs to the right…",
      "Close tabs to the left…",
      "Close idle tabs…",
      "Close all tabs…",
      "New agent tab",
      "Claude Code",
      "Codex",
      "Gemininot installed",
      "New terminal",
      "New browser tab",
    ]);
    // An agent that is not installed cannot be opened.
    expect(item("Gemininot installed").getAttribute("aria-disabled")).toBe("true");
  });

  it("offers a terminal and a browser page their own actions", () => {
    const { unmount } = render(<Menu tab={`terminal:${shell}`} />);
    for (const absent of ["Switch to terminal view", "Fork conversation", "Open in floating window", "Restart agent", "Restart shell", "Reload", "Conversation id", "Page address", "Skills for this agent…", "Mute notifications for this tab"]) {
      expect(offered(absent)).toBe(false);
    }
    for (const present of ["Rename…", "Duplicate tab", "Working directory", "Reveal working directory in the file manager", "Session “Session a”", "Pin tab", "Close tab"]) expect(offered(present)).toBe(true);
    // An exited shell can be started again.
    act(() => backend.emit("pty_exit", { id: shell, code: 1 }));
    expect(offered("Restart shell")).toBe(true);
    unmount();

    render(<Menu tab="browser:page-feature" />);
    for (const present of ["Reload", "Page address", "Tab title", "Duplicate tab", "Pin tab"]) expect(offered(present)).toBe(true);
    // A page belongs to the workspace, not to a session or a folder of its own.
    for (const absent of ["Working directory", "Reveal working directory in the file manager", "Session “Session a”", "Restart agent", "Mute notifications for this tab", "Fork conversation"]) {
      expect(offered(absent)).toBe(false);
    }
  });

  it("offers a tab what applies to what runs in its terminal now", async () => {
    const entry = (id: string) => backend.sessions.find((session) => session.id === "a")!.tabs.find((candidate) => candidate.id === id)!;
    // a2's agent left its terminal: the tab is a terminal. a3's agent was started by hand in its terminal.
    Object.assign(entry("a2"), { front: "terminal", terminalTitle: "Terminal 4" });
    Object.assign(entry("a3"), { front: "by_hand" });
    await refreshSessions();
    const terminal = render(<Menu tab="agent:a2" />);
    // There is no agent in it to fork from, restart or give skills to.
    for (const absent of ["Fork conversation", "Restart agent", "Skills for this agent…", "Switch to terminal view"]) expect(offered(absent)).toBe(false);
    // It is the session's tab all the same: its last conversation is one switch away, and it floats and mutes like one.
    for (const present of ["Rename…", "Switch to chat view", "Duplicate tab", "Open in floating window", "Mute notifications for this tab", "Pin tab", "Close tab"]) expect(offered(present)).toBe(true);
    terminal.unmount();

    render(<Menu tab="agent:a3" />);
    // The reader started it, so the reader restarts it; everything else of an agent's applies.
    expect(offered("Restart agent")).toBe(false);
    for (const present of ["Switch to chat view", "Fork conversation", "Conversation id", "Skills for this agent…"]) expect(offered(present)).toBe(true);
  });

  it("leaves out what does not apply at the ends of the row, and turns off a move that goes nowhere", () => {
    const first = render(<Menu tab="agent:a1" />);
    expect(offered("Close tabs to the left…")).toBe(false);
    expect(offered("Close tabs to the right…")).toBe(true);
    expect(item("Move tab left").getAttribute("aria-disabled")).toBe("true");
    expect(item("Move to start").getAttribute("aria-disabled")).toBe("true");
    expect(item("Move tab right").getAttribute("aria-disabled")).toBeNull();
    // Nothing has been closed, so there is nothing to reopen; no title of the reader's to reset.
    expect(offered("Reopen closed tab")).toBe(false);
    expect(offered("Reset title")).toBe(false);
    first.unmount();
    render(<Menu tab={`terminal:${shell}`} />);
    expect(offered("Close tabs to the right…")).toBe(false);
    expect(item("Move to end").getAttribute("aria-disabled")).toBe("true");
  });

  it("names the session a tab belongs to, and acts on that session", async () => {
    render(<Menu tab="agent:b1" />);
    expect(offered("Session “Session b”")).toBe(true);
    await choose("Archive");
    expect(backend.calls.find((call) => call.command === "set_session_archived")?.args).toEqual({ sessionId: "b", archived: true });
  });

  it("acts on the tab that was clicked, not the one on screen", async () => {
    render(<Menu tab="agent:a2" />);
    await choose("Pin tab");
    expect(layout().pinned).toEqual(["agent:a2"]);
    expect(order()[0]).toBe("agent:a2");
    expect(offered("Unpin tab")).toBe(true);
    await choose("Mute notifications for this tab");
    expect(layout().muted).toEqual(["agent:a2"]);
    expect(offered("Unmute notifications for this tab")).toBe(true);
    await choose("Unpin tab");
    expect(layout().pinned).toEqual([]);

    await choose("Move to end");
    expect(order().at(-1)).toBe("agent:a2");
    await choose("Move tab left");
    expect(order().at(-2)).toBe("agent:a2");

    await choose("Tab title");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("Fix flaky test");
    await choose("Working directory");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(FEATURE);
    await choose("Reveal working directory in the file manager");
    expect(native.reveal).toHaveBeenCalledWith(FEATURE);

    await choose("Fork conversation");
    expect(backend.calls.find((call) => call.command === "fork_session")?.args).toEqual({ sessionId: "a", tabId: "a2" });
    // The open tab was never touched.
    expect(getTerminalState().selected.a).toEqual({ kind: "agent", id: "a1" });
  });

  it("opens the rename dialog, and offers to reset a title the reader gave", async () => {
    render(<Menu tab="browser:page-feature" />);
    await choose("Rename…");
    expect(asked().rename).toEqual({ sessionId: "a", tab: "browser:page-feature" });
    const { renamePeer, workspaceRow } = await import("@/lib/tabActions");
    const row = workspaceRow(getSessionStore().sessions.find((session) => session.id === "a")!);
    await act(async () => void (await renamePeer(row, row.tabs.find((tab) => tab.key === "browser:page-feature")!, "Preview")));
    expect(offered("Reset title")).toBe(true);
    await choose("Reset title");
    expect(layout().titles).toEqual({});
    expect(offered("Reset title")).toBe(false);
  });

  it("asks before a bulk close rather than closing", async () => {
    render(<Menu tab="agent:a2" />);
    await choose("Close other tabs…");
    expect(asked().close).toEqual({ sessionId: "a", action: "others", tab: "agent:a2" });
    expect(backend.callsOf("remove_tab")).toEqual([]);
  });

  it("closes the tab, then offers to reopen it", async () => {
    render(<Menu tab="agent:a3" />);
    await choose("Close tab");
    expect(backend.callsOf("remove_tab")).toEqual([{ sessionId: "a", tabId: "a3" }]);
    cleanup();
    render(<Menu tab="agent:a1" />);
    expect(offered("Reopen closed tab")).toBe(true);
    await choose("Reopen closed tab");
    expect(backend.callsOf("reopen_tab")).toEqual([{ sessionId: "a", tabId: "a3" }]);
    expect(order()).toContain("agent:a3");
  });

  it("opens a new tab directly after the one clicked", async () => {
    render(<Menu tab="agent:a1" />);
    await choose("New terminal");
    expect(order()[1]).toMatch(/^terminal:a:/);
    await choose("Codex");
    expect(order()[1]).toMatch(/^agent:new-/);
    expect(backend.callsOf("add_tab").at(-1)).toMatchObject({ sessionId: "a", tab: { harness: "codex" } });
    await choose("New browser tab");
    expect(order()[1]).toMatch(/^browser:page-new-/);
    // A duplicate sits next to its original.
    cleanup();
    render(<Menu tab="agent:a2" />);
    const at = order().indexOf("agent:a2");
    await choose("Duplicate tab");
    expect(order()[at + 1]).toMatch(/^agent:new-/);
  });

  it("asks before restarting an agent that is working", async () => {
    render(<Menu tab="agent:a2" />);
    native.ask.mockResolvedValueOnce(false);
    await choose("Restart agent");
    expect(native.ask).toHaveBeenCalledTimes(1);
    expect(backend.callsOf("stop_tab")).toEqual([]);
    await choose("Restart agent");
    expect(backend.callsOf("stop_tab")).toEqual([{ sessionId: "a", tabId: "a2" }]);
    // An idle one is restarted without a question.
    cleanup();
    native.ask.mockClear();
    render(<Menu tab="agent:a1" />);
    await choose("Restart agent");
    expect(native.ask).not.toHaveBeenCalled();
    expect(backend.callsOf("stop_tab").at(-1)).toEqual({ sessionId: "a", tabId: "a1" });
  });

  it("shows what a viewer may not use, off, with the reason", async () => {
    const reason = "View only: this session is shared with you to watch.";
    render(<Menu tab="agent:a2" readOnlyReason={reason} />);
    expect(screen.getByRole("note").textContent).toBe(reason);
    const off = ["Rename…", "Duplicate tab", "Fork conversation", "Restart agent", "Pin tab", "Mute notifications for this tab", "Archive", "Delete…", "Move tab right", "Close tab", "Close other tabs…", "Close all tabs…", "New agent tab", "New terminal", "New browser tab"];
    for (const name of off) expect(item(name).getAttribute("aria-disabled")).toBe("true");
    // Looking is still allowed.
    for (const name of ["Tab title", "Working directory", "Reveal working directory in the file manager", "Skills for this agent…"]) expect(item(name).getAttribute("aria-disabled")).toBeNull();
    for (const name of ["Close tab", "Pin tab", "New terminal", "Duplicate tab"]) await choose(name);
    expect(backend.calls.filter((call) => ["remove_tab", "set_tab_layout", "pty_spawn", "add_tab"].includes(call.command))).toEqual([]);
  });
});
