import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const { closeCloseTabs, closeRenameTab, openCloseTabs, openRenameTab } = await import("@/lib/dialogs");
const { setDraft } = await import("@/lib/drafts");
const { setTabPinned, workspaceRow } = await import("@/lib/tabActions");

const LONG = "Refactor the authentication middleware to use the new token service";
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const names = () => within(screen.getByRole("tablist", { name: "Workspace tabs" })).getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"));
const closed = () => [
  ...backend.callsOf("remove_tab").map((args) => `agent:${args.tabId}`),
  ...backend.callsOf("pty_kill").map((args) => `terminal:${args.id}`),
  ...backend.callsOf("browser_close_page").map((args) => `browser:${args.pageId}`),
].sort();
const dialog = () => screen.getByRole("dialog");
const ask = async (action: Parameters<typeof openCloseTabs>[1], tab: string | null) => {
  act(() => openCloseTabs("a", action, tab));
  await flush();
};
const row = () => workspaceRow(getSessionStore().sessions.find((session) => session.id === "a")!);

let shell = "";

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
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
  for (const id of ["a1", "a2", "a3", "b1"]) setDraft(id, "");
  backend.calls = [];
});

afterEach(() => {
  act(() => {
    closeCloseTabs();
    closeRenameTab();
  });
  cleanup();
});

describe("the question before several tabs are closed", () => {
  it("says how many tabs will close, and closes exactly those when agreed to", async () => {
    render(<TabsHarness />);
    await ask("right", "agent:a3");
    expect(within(dialog()).getByRole("heading").textContent).toBe("Close 3 tabs?");
    expect(screen.getByTestId("close-tabs-summary").textContent).toContain("“Close tabs to the right” closes 3 tabs of this workspace, across its sessions.");
    expect(screen.getByTestId("close-tabs-summary").textContent).toContain("Conversations are kept and can be reopened");
    // Nothing is closed by asking.
    expect(closed()).toEqual([]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close 3 tabs" }));
    await flush();
    expect(closed()).toEqual(["agent:b1", "browser:page-feature", `terminal:${shell}`].sort());
    expect(names()).toEqual([LONG, "Fix flaky test", "Review"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes nothing when cancelled", async () => {
    render(<TabsHarness />);
    await ask("all", null);
    expect(within(dialog()).getByRole("heading").textContent).toBe("Close 6 tabs?");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await flush();
    expect(closed()).toEqual([]);
    expect(names()).toHaveLength(6);
  });

  it("lists the tabs with something going on, and offers to close only the idle ones", async () => {
    backend.busy.add(shell);
    setDraft("b1", "not sent yet");
    render(<TabsHarness />);
    await ask("others", "agent:a1");
    expect(within(dialog()).getByRole("heading").textContent).toBe("Close 5 tabs?");
    const busy = within(screen.getByTestId("close-tabs-busy")).getAllByRole("listitem").map((entry) => entry.textContent);
    expect(busy).toEqual([
      "Fix flaky test · Session aworking",
      "Review · Session awaiting for an answer",
      "Docs · Session bunsent draft",
      "Terminal 1 · Session arunning a command",
    ]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close idle ones only (1)" }));
    await flush();
    // Only the page had nothing going on.
    expect(closed()).toEqual(["browser:page-feature"]);
    expect(names()).toEqual([LONG, "Fix flaky test", "Review", "Docs", "Terminal 1"]);
  });

  it("closes them all the same when the reader says so", async () => {
    render(<TabsHarness />);
    await ask("others", "agent:a1");
    // The agents working and waiting are named; the shell at its prompt is not.
    expect(within(screen.getByTestId("close-tabs-busy")).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close 5 tabs" }));
    await flush();
    expect(closed()).toEqual(["agent:a2", "agent:a3", "agent:b1", "browser:page-feature", `terminal:${shell}`].sort());
    expect(names()).toEqual([LONG]);
  });

  it("leaves pinned tabs open unless the reader includes them", async () => {
    setTabPinned(row(), row().tabs.find((tab) => tab.key === "agent:b1")!, true);
    backend.calls = [];
    render(<TabsHarness />);
    await ask("idle", "agent:a1");
    // Idle: a1 and b1. The pinned one is left out.
    expect(within(dialog()).getByRole("heading").textContent).toBe("Close 1 tab?");
    const include = within(dialog()).getByRole("checkbox", { name: "Also close the pinned tab in range" });
    fireEvent.click(include);
    expect(within(dialog()).getByRole("heading").textContent).toBe("Close 2 tabs?");
    fireEvent.click(include);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close 1 tab" }));
    await flush();
    expect(closed()).toEqual(["agent:a1"]);
    expect(names()).toContain("Docs");
  });

  it("says so when only pinned tabs are in range", async () => {
    setTabPinned(row(), row().tabs.find((tab) => tab.key === "agent:a1")!, true);
    render(<TabsHarness />);
    await ask("left", "agent:a2");
    expect(screen.getByTestId("close-tabs-summary").textContent).toBe("Only pinned tabs are in range, and pinned tabs are left open.");
    expect((within(dialog()).getByRole("button", { name: "Close 0 tabs" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("never reaches a tab of another workspace", async () => {
    render(<TabsHarness />);
    await ask("all", null);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close 6 tabs" }));
    await flush();
    expect(closed()).toEqual(["agent:a1", "agent:a2", "agent:a3", "agent:b1", "browser:page-feature", `terminal:${shell}`].sort());
    const other = workspaceRow(getSessionStore().sessions.find((session) => session.id === "other")!);
    expect(other.tabs).toHaveLength(3);
    // Both sessions are still there, with no tabs: nothing was archived or deleted.
    expect(getSessionStore().sessions.filter((session) => ["a", "b"].includes(session.id)).map((session) => [session.archived, session.tabs.length])).toEqual([[false, 0], [false, 0]]);
  });
});

describe("renaming a tab", () => {
  it("gives it the reader's own title, in the strip and in the sidebar", async () => {
    render(<TabsHarness />);
    act(() => openRenameTab("a", "agent:a2"));
    const input = within(dialog()).getByRole("textbox", { name: "Tab title" }) as HTMLInputElement;
    expect(input.value).toBe("Fix flaky test");
    fireEvent.change(input, { target: { value: "Checkout flake" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Rename" }));
    await flush();
    expect(names()[1]).toBe("Checkout flake");
    expect(within(screen.getByRole("tree", { name: "Sidebar" })).getByRole("treeitem", { name: "Checkout flake" })).toBeTruthy();
    expect(backend.callsOf("rename_tab")).toEqual([{ sessionId: "a", tabId: "a2", title: "Checkout flake" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not make the name it already has into a title of the reader's", async () => {
    render(<TabsHarness />);
    act(() => openRenameTab("a", `terminal:${shell}`));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Rename" }));
    await flush();
    expect(backend.callsOf("set_tab_layout")).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
