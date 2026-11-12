import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PRO-291: a chat tab that would not open or close says so in the toast area,
 * with Try again, instead of only in the console.
 */

// The shared fake backend, with one command at a time made to fail.
const failing = vi.hoisted(() => ({ commands: new Map<string, () => unknown>() }));
vi.mock("@tauri-apps/api/core", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      const fail = failing.commands.get(command);
      if (fail) {
        backend.calls.push({ command, args: args ?? {} });
        return fail();
      }
      return backend.invoke(command, args);
    },
    Channel: class {},
  };
});
vi.mock("@tauri-apps/api/event", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { listen: backend.listen };
});
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/ada/" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), message: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn(), openPath: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async () => undefined, label: "main" }) }));
vi.mock("@/lib/terminalWebgl", () => ({ showWebgl: vi.fn(), hideWebgl: vi.fn(), recoverWebgl: vi.fn() }));
vi.mock("@/components/ui/menu", () => {
  const Item = ({ children, onSelect, disabled }: { children: ReactNode; onSelect?: () => void; disabled?: boolean }) => (
    <div role="menuitem" aria-disabled={disabled || undefined} onClick={() => !disabled && onSelect?.()}>{children}</div>
  );
  const Pass = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    ContextMenuItem: Item,
    ContextMenuCheckboxItem: ({ children }: { children: ReactNode }) => <div role="menuitemcheckbox">{children}</div>,
    ContextMenuSubTrigger: ({ children }: { children: ReactNode }) => <div role="menuitem" aria-haspopup="menu">{children}</div>,
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
const { dropSessionTerminals, setSelectedAgent, getTerminalState } = await import("@/lib/terminal");
const { resetTabLayouts } = await import("@/lib/tabLayouts");
const { useTabRow } = await import("@/lib/sessionTabs");
const { TabMenuItems, settingsFileIn, openAgentTabTelling } = await import("./TabMenu");
const { Toasts } = await import("@/components/ui/Toasts");
const { dismissError, getErrorToasts } = await import("@/lib/errorToasts");
const { resetTabViews } = await import("@/lib/tabViews");

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });

function Menu({ tab }: { tab: string }) {
  const store = useSessionStore();
  const session = store.sessions.find((candidate) => candidate.id === store.selectedSessionId)!;
  const row = useTabRow(session);
  const target = row.tabs.find((candidate) => candidate.key === tab);
  const selected = getTerminalState().selected[session.id] ?? null;
  return (
    <>
      {target ? <TabMenuItems row={row} tab={target} selected={selected} /> : null}
      <output data-testid="row">{row.tabs.map((item) => item.key).join(",")}</output>
      <Toasts />
    </>
  );
}

const item = (name: string) => screen.getAllByRole("menuitem").find((candidate) => candidate.textContent?.trim() === name)!;
const choose = async (name: string) => {
  fireEvent.click(item(name));
  await flush();
};
const row = () => screen.getByTestId("row").textContent!.split(",");
const tabsOf = (id: string) => getSessionStore().sessions.find((session) => session.id === id)!.tabs.map((tab) => tab.id);

const EXITED = "claude exited while starting\n~/.claude/settings.json line 14: Unexpected token }";

beforeEach(async () => {
  failing.commands.clear();
  backend.reset();
  await bootSessions();
  await refreshSessions();
  dropSessionTerminals(["a", "b", "other"]);
  await bootBrowser();
  await refreshBrowserPages();
  resetTabLayouts();
  selectSession("a");
  setSelectedAgent("a", "a1");
  backend.calls = [];
});

afterEach(() => {
  cleanup();
  for (const toast of getErrorToasts()) dismissError(toast.id);
  resetTabViews();
});

describe("a new chat tab whose agent fails to start", () => {
  it("is closed again and the toast says why, with the agent's own line", async () => {
    failing.commands.set("ensure_tab_started", () => Promise.reject(EXITED));
    render(<Menu tab="agent:a1" />);
    await choose("Claude Code");

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Couldn't open a new Claude Code tab: claude exited while starting")).toBeTruthy();
    expect(within(alert).getByText("~/.claude/settings.json line 14: Unexpected token }")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Open settings.json" })).toBeTruthy();
    // No empty tab is left behind: the one added was closed again.
    const [added] = backend.callsOf("remove_tab");
    expect(added).toMatchObject({ sessionId: "a" });
    expect(tabsOf("a")).toEqual(["a1", "a2", "a3"]);
    expect(row().filter((key) => key.startsWith("agent:new-"))).toEqual([]);
    // The tab that was on screen is again.
    expect(getTerminalState().selected.a).toEqual({ kind: "agent", id: "a1" });
  });

  it("opens the settings file it names, and the toast stays", async () => {
    failing.commands.set("ensure_tab_started", () => Promise.reject(EXITED));
    failing.commands.set("inspect_local_path", () => ({ kind: "file", path: "/Users/ada/.claude/settings.json", root: "/Users/ada/.claude", rel: "settings.json", text: true }));
    render(<Menu tab="agent:a1" />);
    await choose("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: "Open settings.json" }));
    await flush();
    expect(backend.callsOf("inspect_local_path")).toEqual([{ base: FEATURE, path: "/Users/ada/.claude/settings.json" }]);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("tries again, and the toast goes once the tab opens", async () => {
    failing.commands.set("ensure_tab_started", () => Promise.reject(EXITED));
    render(<Menu tab="agent:a1" />);
    await choose("Claude Code");
    // Failing again keeps one toast, counted, not a second one.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByLabelText("2 times")).toBeTruthy();

    failing.commands.delete("ensure_tab_started");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(tabsOf("a").filter((id) => id.startsWith("new-"))).toHaveLength(1);
  });

  it("says why a tab could not even be added, without a settings button", async () => {
    failing.commands.set("add_tab", () => Promise.reject("New tabs in a shared session must use a permission mode other than Bypass."));
    render(<Menu tab="agent:a1" />);
    await choose("Codex");
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Couldn't open a new Codex tab: New tabs in a shared session must use a permission mode other than Bypass")).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: /Open/ })).toBeNull();
    expect(backend.callsOf("remove_tab")).toEqual([]);
  });

  it("finds the settings file an error line names", () => {
    expect(settingsFileIn("~/.claude/settings.json line 14: Unexpected token }")).toBe("~/.claude/settings.json");
    expect(settingsFileIn("invalid /repo/.claude/settings.local.json: bad")).toBe("/repo/.claude/settings.local.json");
    expect(settingsFileIn("unauthorized (401)")).toBeNull();
    expect(settingsFileIn("mysettings.json is fine")).toBeNull();
  });

  it("resolves whether the tab opened", async () => {
    const add = vi.fn(async () => { throw new Error("no"); });
    await expect(openAgentTabTelling({ id: "a", cwd: FEATURE }, "claude", add)).resolves.toBe(false);
    expect(getErrorToasts()).toHaveLength(1);
  });
});

describe("a chat tab that would not close", () => {
  it("stays open and on screen, and the toast names it", async () => {
    failing.commands.set("remove_tab", () => Promise.reject("Codex didn't stop within 10 seconds"));
    setSelectedAgent("a", "a2");
    render(<Menu tab="agent:a2" />);
    await choose("Close tab");

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Couldn't close the chat. Try again.")).toBeTruthy();
    expect(within(alert).getByText("Codex didn't stop within 10 seconds, so “Fix flaky test” is still open.")).toBeTruthy();
    expect(tabsOf("a")).toContain("a2");
    expect(getTerminalState().selected.a).toEqual({ kind: "agent", id: "a2" });
  });

  it("closes on Try again, and the toast goes", async () => {
    failing.commands.set("remove_tab", () => Promise.reject("Codex didn't stop within 10 seconds"));
    render(<Menu tab="agent:a2" />);
    await choose("Close tab");
    failing.commands.delete("remove_tab");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(tabsOf("a")).not.toContain("a2");
  });

  it("gives any other reason as the error", async () => {
    failing.commands.set("remove_tab", () => Promise.reject("Stop is already in progress."));
    render(<Menu tab="agent:a2" />);
    await choose("Close tab");
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("“Fix flaky test” is still open.")).toBeTruthy();
    expect(within(alert).getByText("Stop is already in progress")).toBeTruthy();
  });
});
