import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PRO-397: the title bar's '…' menu in a local session (design 02.12). The real
// session stores run against the in-memory backend of `@/test/tabsBackend`.
vi.mock("@tauri-apps/api/core", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return {
    Channel: class {},
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "repo_mirror_status") return { source: null, root: "/repo", active: false, error: null };
      if (command === "work_status") return { isRepo: true, dirty: false, branch: "raccoon/Quiet-Fox", upstream: null, ahead: 0, behind: 0, defaultBranch: "origin/Main", aheadOfBase: 0, head: "abc" };
      return backend.invoke(command, args);
    },
  };
});
vi.mock("@tauri-apps/api/event", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { listen: backend.listen };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), message: vi.fn(async () => undefined), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => undefined), openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async () => undefined, label: "main" }) }));
vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-out", identity: null, expiresAt: null, lastError: null, organizations: [] } };
  return { useAccount: () => account, getAccount: () => account, subscribeAccount: () => () => undefined, refreshAccount: vi.fn() };
});
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/models", async (original) => ({ ...(await original<typeof import("@/lib/models")>()), useModels: () => [], loadModels: vi.fn() }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="xterm">{id}</div>, createTerminal: () => undefined }));
vi.mock("@/components/browser/BrowserView", () => ({ BrowserView: () => <div data-testid="browser-view" /> }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));
vi.mock("@/lib/dialogs", async (original) => ({ ...(await original<typeof import("@/lib/dialogs")>()), openRenameSession: vi.fn(), openLinkIssue: vi.fn() }));
vi.mock("@/components/chat/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));

const { backend, FEATURE, session: sessionEntry, tab } = await import("@/test/tabsBackend");
const { bootSessions, refreshEverything, getSessionStore } = await import("@/lib/sessions");
const { setPrefs } = await import("@/lib/prefs");
const { SHORTCUT_ACTIONS, bindingsOf, keycaps, saveShortcut } = await import("@/lib/shortcuts");
const { openLinkIssue, openRenameSession } = await import("@/lib/dialogs");
const { SessionView } = await import("./SessionView");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const openMenu = (element: HTMLElement) => fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });

/** The design's rows, top to bottom (02.12 Session more menu · target branch). */
const DESIGNED = ["target", "rename-session", "rename-branch", "link-issue", "copy-link", "share", "mirror", "terminal-view", "archive"];

async function show() {
  backend.sessions = [sessionEntry("menu", FEATURE, [tab("t1", 1)], { title: "Fix login", branch: "raccoon/Quiet-Fox", worktreeName: "Quiet-Fox" })];
  await bootSessions();
  await act(async () => { await refreshEverything(); });
  const session = getSessionStore().sessions.find((entry) => entry.id === "menu")!;
  render(<TooltipProvider><SessionView session={session} sidebarOpen onToggleSidebar={() => undefined} /></TooltipProvider>);
  await flush();
  await flush();
  openMenu(screen.getByTestId("session-menu-trigger"));
  await flush();
  return screen.getByTestId("session-menu");
}

beforeEach(() => {
  localStorage.clear();
  backend.reset();
  vi.mocked(openRenameSession).mockClear();
  vi.mocked(openLinkIssue).mockClear();
  setPrefs({ tabStrip: false, panelOpen: false, shortcuts: {} });
});

afterEach(() => cleanup());

describe("the title bar's session menu", () => {
  it("holds the designed rows in the designed order", async () => {
    const menu = await show();
    const rows = [...menu.querySelectorAll<HTMLElement>("[data-row]")];
    expect(rows.map((row) => row.dataset.row)).toEqual(DESIGNED);
    expect(rows.map((row) => row.textContent?.trim())).toEqual([
      expect.stringMatching(/^Target branch/),
      "Rename session…",
      "Rename branch…",
      "Link issue",
      "Copy link",
      "Share session…",
      expect.stringMatching(/^Mirror into repo rootTest these changes from the main checkout$/),
      expect.stringMatching(/^Open in terminal view/),
      expect.stringMatching(/^Archive session/),
    ]);
    for (const kept of ["Copy branch name", "Reveal in Finder", "Continue in New Session…", "Pair a phone…"]) expect(within(menu).getByText(kept)).toBeTruthy();
  });

  it("shows only shortcuts the keymap has, with the keys it has for them", async () => {
    const menu = await show();
    const shown = [...menu.querySelectorAll<HTMLElement>("[data-shortcut]")];
    expect(shown.length).toBeGreaterThan(0);
    for (const element of shown) {
      const id = element.dataset.shortcut as Parameters<typeof bindingsOf>[0];
      const bindings = bindingsOf(id);
      expect(bindings.length, id).toBeGreaterThan(0);
      expect(element.textContent).toBe(keycaps(bindings[0]).join(""));
    }
    expect(menu.querySelector('[data-row="terminal-view"] [data-shortcut="session.toggleTerminalView"]')).not.toBeNull();
  });

  // Optional bindings appear in the menu and work with the menu closed.
  it("shows the keys the reader gave the rows, each a registered action, and the keys work with the menu closed", async () => {
    const rows = { "link-issue": "session.linkIssue", "copy-link": "session.copyLink", "terminal-view": "session.toggleTerminalView", archive: "session.archive" } as const;
    const chords = { "session.linkIssue": "mod+alt+i", "session.copyLink": "mod+alt+shift+c", "session.archive": "mod+alt+shift+a" } as const;
    for (const [id, chord] of Object.entries(chords)) expect(saveShortcut(id as keyof typeof chords, [chord]), id).toEqual({ ok: true });
    const menu = await show();
    const registered = new Set(SHORTCUT_ACTIONS.map((action) => action.id));
    for (const [row, id] of Object.entries(rows)) {
      expect(registered.has(id), id).toBe(true);
      const shown = menu.querySelector<HTMLElement>(`[data-row="${row}"] [data-shortcut]`);
      expect(shown?.dataset.shortcut, row).toBe(id);
      expect(shown?.textContent, row).toBe(keycaps(bindingsOf(id)[0]).join(""));
    }
    // Nothing else in the menu shows keys.
    expect([...menu.querySelectorAll<HTMLElement>("[data-shortcut]")].map((element) => element.dataset.shortcut)).toEqual(Object.values(rows));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await flush();
    fireEvent.keyDown(window, { key: "i", code: "KeyI", ctrlKey: true, altKey: true });
    expect(openLinkIssue).toHaveBeenCalledWith("menu");
    // Archive's keys are the app shell's (AppShell), as before this menu had the row.
  });

  it("names the target branch in mono and in its own case, with no uppercase label", async () => {
    const menu = await show();
    const target = within(menu).getByTestId("session-menu-target");
    expect(target.textContent).toBe("origin/Main");
    expect(target.className).toContain("font-mono");
    expect(menu.querySelector(".uppercase")).toBeNull();
  });

  it("names the target Changes compares against when one is chosen there", async () => {
    localStorage.setItem(`changes-scope:local:${FEATURE}`, JSON.stringify({ scope: "all", target: "release/Next", commit: null }));
    const menu = await show();
    expect(within(menu).getByTestId("session-menu-target").textContent).toBe("release/Next");
  });

  it("opens the session's rename and issue dialogs", async () => {
    let menu = await show();
    fireEvent.click(menu.querySelector('[data-row="rename-session"]')!);
    expect(openRenameSession).toHaveBeenCalledWith("menu");
    openMenu(screen.getByTestId("session-menu-trigger"));
    await flush();
    menu = screen.getByTestId("session-menu");
    fireEvent.click(menu.querySelector('[data-row="link-issue"]')!);
    expect(openLinkIssue).toHaveBeenCalledWith("menu");
  });

  it("renames the branch in the sidebar's dialog", async () => {
    const menu = await show();
    fireEvent.click(menu.querySelector('[data-row="rename-branch"]')!);
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("raccoon/Quiet-Fox");
  });

  it("archives the session", async () => {
    const menu = await show();
    fireEvent.click(menu.querySelector('[data-row="archive"]')!);
    await flush();
    expect(backend.callsOf("set_session_archived")).toEqual([{ sessionId: "menu", archived: true }]);
  });
});
