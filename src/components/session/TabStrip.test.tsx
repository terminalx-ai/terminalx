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
const { setPrefs } = await import("@/lib/prefs");
const { SHORTCUT_ACTIONS, SHORTCUT_GROUPS, bindingProblem, defaultBindings, saveShortcut } = await import("@/lib/shortcuts");

const LONG = "Refactor the authentication middleware to use the new token service";
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const strip = () => screen.getByRole("tablist", { name: "Workspace tabs" });
const names = () => within(strip()).getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"));
const shown = () => within(strip()).getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.getAttribute("aria-label");
const composer = () => screen.getByRole("textbox", { name: "Composer" });
const terminal = () => screen.getByRole("textbox", { name: "Terminal input" });
/** A key pressed where the focus is, with Ctrl: the app's main modifier off macOS, which is what jsdom is. */
const press = (target: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
};
const digit = (n: number): KeyboardEventInit => ({ key: String(n), code: `Digit${n}` });

let shell = "";

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  setPrefs({ shortcuts: {} });
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
});

afterEach(cleanup);

describe("the new-tab button", () => {
  it("ends the row of tabs and opens the same menu as before", async () => {
    render(<TabsHarness />);
    const plus = screen.getByRole("button", { name: "New tab" });
    // After the strip, in the same header.
    expect(strip().compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(plus);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Claude Code", "Codex", "Gemininot installed", "Terminalon this computer", "Browser"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminal on this computer" }));
    await flush();
    expect(backend.callsOf("pty_spawn").at(-1)).toMatchObject({ cwd: FEATURE, title: "Terminal 2" });
    // A tab opened from here goes to the end of the row.
    expect(names().at(-1)).toBe("Terminal 2");
  });
});

describe("the tab shortcuts", () => {
  it("are nine remappable actions for a place in the row, with the browser's keys", () => {
    const places = SHORTCUT_ACTIONS.filter((action) => /^session\.(tab\d|lastTab)$/.test(action.id));
    expect(places.map((action) => action.label)).toEqual([...Array.from({ length: 8 }, (_, i) => `Switch to tab ${i + 1}`), "Switch to last tab"]);
    for (const mac of [true, false]) {
      expect(places.map((action) => defaultBindings(action.id, mac))).toEqual([...Array.from({ length: 8 }, (_, i) => [`mod+${i + 1}`]), ["mod+9"]]);
      // Each default is a key the app may take, and no other action has it.
      const all = SHORTCUT_ACTIONS.flatMap((action) => defaultBindings(action.id, mac));
      for (const action of [...places, ...SHORTCUT_ACTIONS.filter((other) => ["session.moveTabLeft", "session.moveTabRight", "session.reopenTab"].includes(other.id))]) {
        for (const binding of defaultBindings(action.id, mac)) {
          expect(bindingProblem(action.id, binding, mac)).toBeNull();
          expect(all.filter((other) => other === binding)).toHaveLength(1);
        }
      }
    }
    // Listed with the other session shortcuts in Settings.
    expect(places.every((action) => action.group === "Session" && SHORTCUT_GROUPS.includes(action.group))).toBe(true);
  });

  it("switch to a tab by its place while the focus is in the composer and in a terminal", async () => {
    render(<TabsHarness />);
    composer().focus();
    const typed = press(composer(), digit(2));
    expect(shown()).toBe("Fix flaky test");
    // The key is the app's: it is not typed into the composer.
    expect(typed.defaultPrevented).toBe(true);

    terminal().focus();
    expect(press(terminal(), digit(3)).defaultPrevented).toBe(true);
    expect(shown()).toBe("Review");

    // 9 is the last tab, however many there are.
    press(terminal(), digit(9));
    expect(shown()).toBe("Terminal 1");

    // There is no eighth tab: nothing changes, and the key still does not reach the shell.
    expect(press(terminal(), digit(8)).defaultPrevented).toBe(true);
    expect(shown()).toBe("Terminal 1");
  });

  it("count the row as shown, across the workspace's sessions, and never reach another workspace", async () => {
    render(<TabsHarness />);
    press(composer(), digit(4));
    await flush();
    // The fourth tab is the other session's: its session is opened with it.
    expect(getSessionStore().selectedSessionId).toBe("b");
    expect(shown()).toBe("Docs");
    for (let n = 1; n <= 9; n++) {
      press(composer(), digit(n));
      await flush();
      expect(getSessionStore().selectedSessionId).not.toBe("other");
    }
  });

  it("follow the order the reader gave the row", async () => {
    render(<TabsHarness />);
    // Move the open tab right, with its own shortcut: Ctrl+Alt+Shift+].
    press(composer(), { key: "}", code: "BracketRight", altKey: true, shiftKey: true });
    await flush();
    expect(names().slice(0, 2)).toEqual(["Fix flaky test", LONG]);
    press(composer(), digit(1));
    expect(shown()).toBe("Fix flaky test");
    press(composer(), { key: "{", code: "BracketLeft", altKey: true, shiftKey: true });
    await flush();
    // It is already first: nothing moves.
    expect(names().slice(0, 2)).toEqual(["Fix flaky test", LONG]);
    // Next and previous step through the same row.
    press(composer(), { key: "}", code: "BracketRight", shiftKey: true });
    expect(shown()).toBe(LONG);
    press(composer(), { key: "{", code: "BracketLeft", shiftKey: true });
    press(composer(), { key: "{", code: "BracketLeft", shiftKey: true });
    expect(shown()).toBe("Terminal 1");
  });

  it("use the keys the reader gave them", async () => {
    render(<TabsHarness />);
    expect(saveShortcut("session.tab2", ["mod+shift+2"])).toEqual({ ok: true });
    await flush();
    press(composer(), digit(2));
    expect(shown()).toBe(LONG);
    press(composer(), { key: "@", code: "Digit2", shiftKey: true });
    expect(shown()).toBe("Fix flaky test");
    // The others are as they were.
    press(composer(), digit(3));
    expect(shown()).toBe("Review");
  });

  it("close the open tab and bring the last closed one back", async () => {
    render(<TabsHarness />);
    press(composer(), digit(3));
    press(composer(), { key: "w", code: "KeyW" });
    await flush();
    expect(backend.callsOf("remove_tab")).toEqual([{ sessionId: "a", tabId: "a3" }]);
    expect(names()).not.toContain("Review");
    // Its neighbour took the view.
    expect(shown()).toBe("Docs");

    // Ctrl+Alt+Shift+T off macOS: the browser's own keys switch a tab to its terminal view here.
    press(composer(), { key: "T", code: "KeyT", altKey: true, shiftKey: true });
    await flush();
    expect(backend.callsOf("reopen_tab")).toEqual([{ sessionId: "a", tabId: "a3" }]);
    expect(names().indexOf("Review")).toBe(2);
    expect(shown()).toBe("Review");
    void shell;
  });
});
