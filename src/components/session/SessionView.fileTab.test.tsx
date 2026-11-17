import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangedFile } from "@/types/session";

// PRO-402 (screen 06.11): a file a local session opens is a tab in the
// session's tab strip beside the chat tab, never a pane of its own over the
// chat. The real session, tab and editor stores run against the in-memory
// backend of `@/test/tabsBackend`; the files and git's answers are this file's.
const mocks = vi.hoisted(() => ({ changes: [] as ChangedFile[], files: {} as Record<string, string> }));
vi.mock("@tauri-apps/api/core", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return {
    Channel: class {},
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "read_text_file") return { content: mocks.files[String(args.path)] ?? "", binary: false, truncated: false, mtimeMs: 1, size: 1 };
      if (command === "file_mtime") return 1;
      if (command === "working_changes") return ["head", mocks.changes];
      return backend.invoke(command, args);
    },
  };
});
vi.mock("@tauri-apps/api/event", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { listen: backend.listen };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/confirm", () => ({ confirmInApp: vi.fn(async () => true), chooseInApp: vi.fn(async () => "action") }));
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
vi.mock("@/components/chat/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div data-testid="preview">{text}</div> }));

const { backend, MAIN, session: sessionEntry, tab } = await import("@/test/tabsBackend");
const { bootSessions, refreshEverything, getSessionStore, selectSession, useSessionStore } = await import("@/lib/sessions");
const { closePeer, workspaceRow } = await import("@/lib/sessionTabs");
const { reopenClosedTab } = await import("@/lib/tabActions");
const { setPrefs } = await import("@/lib/prefs");
const { resetTabLayouts } = await import("@/lib/tabLayouts");
const { dropEditors, getEditors, openFile, restoreReviewTabs, setEditorDirty } = await import("@/lib/editors");
const { getTerminalState } = await import("@/lib/terminal");
const { runShortcut } = await import("@/lib/hotkeys");
const { SessionView } = await import("./SessionView");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

/** The open session, read from the store on every render as the app shell does. */
function Shown() {
  const session = useSessionStore().sessions.find((entry) => entry.id === "work");
  return session ? <SessionView session={session} sidebarOpen onToggleSidebar={() => undefined} /> : null;
}

async function show() {
  backend.sessions = [sessionEntry("work", MAIN, [tab("chat", 1, { title: "Per-project scripts" })], { title: "Work" })];
  await bootSessions();
  await act(async () => { await refreshEverything(); });
  selectSession("work");
  render(<TooltipProvider><Shown /></TooltipProvider>);
  await flush();
  await flush();
}

const strip = () => screen.getByRole("tablist", { name: "Workspace tabs" });
const tabs = () => within(strip()).getAllByRole("tab");
const names = () => tabs().map((item) => item.getAttribute("aria-label"));
const selected = () => tabs().find((item) => item.getAttribute("aria-selected") === "true")?.getAttribute("aria-label");
const open = async (rel: string) => {
  let id = "";
  act(() => { id = openFile("work", MAIN, rel); });
  await flush();
  return id;
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  backend.reset();
  backend.pages = [];
  resetTabLayouts();
  mocks.changes = [];
  mocks.files = { [`${MAIN}/docs/scripts.md`]: "# Scripts\n", [`${MAIN}/src/app.ts`]: "export {};\n" };
  setPrefs({ tabStrip: true, panelOpen: false, shortcuts: {} });
});

afterEach(() => {
  cleanup();
  dropEditors(() => true);
});

describe("a file opened in a local session", () => {
  it("is a tab in the session's tab strip beside the chat tab, which stays and can be selected", async () => {
    await show();
    expect(names()).toEqual(["Per-project scripts"]);
    const id = await open("docs/scripts.md");
    expect(names()).toEqual(["Per-project scripts", "scripts.md"]);
    expect(selected()).toBe("scripts.md");
    expect(tabs()[1].getAttribute("aria-description")).toContain("File");
    // One strip of tabs: the editor pane and its "Open files" strip are not drawn in a session.
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(document.querySelector('[role="tablist"][aria-label="Open files"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide editor pane" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close all files" })).toBeNull();
    await waitFor(() => expect(screen.getByTestId("preview").textContent).toBe("# Scripts\n"));
    // The chat tab is still there, and selecting it shows the chat with the file left open.
    fireEvent.click(tabs()[0]);
    await flush();
    expect(selected()).toBe("Per-project scripts");
    expect(names()).toEqual(["Per-project scripts", "scripts.md"]);
    expect(document.getElementById(tabs()[0].getAttribute("aria-controls")!)?.getAttribute("aria-hidden")).toBe("false");
    expect(getEditors().editors.map((entry) => entry.id)).toEqual([id]);
    // Opening it again goes back to its tab; it is not opened twice.
    expect(await open("docs/scripts.md")).toBe(id);
    expect(names()).toEqual(["Per-project scripts", "scripts.md"]);
    expect(selected()).toBe("scripts.md");
  });

  it("shows its path as a breadcrumb with the name in mono, and a status badge with line counts only when it changed", async () => {
    mocks.changes = [{ path: "docs/scripts.md", status: "added", additions: 41, deletions: 0 }];
    await show();
    await open("docs/scripts.md");
    const toolbar = await screen.findByTestId("editor-toolbar");
    expect(within(toolbar).getByTestId("file-crumb").getAttribute("aria-label")).toBe("docs/scripts.md");
    expect(within(toolbar).getByTestId("file-crumb-folders").textContent).toBe("docs");
    expect(within(toolbar).getAllByTestId("file-crumb-separator")).toHaveLength(1);
    const name = within(toolbar).getByTestId("file-crumb-name");
    expect(name.textContent).toBe("scripts.md");
    expect(name.closest(".font-mono")).not.toBeNull();
    const badge = await within(toolbar).findByTestId("file-status");
    expect(badge.textContent).toBe("A+41");
    expect(badge.getAttribute("aria-label")).toBe("Added, 41 added");
    // An unchanged file has no badge.
    await open("src/app.ts");
    const other = screen.getAllByTestId("editor-toolbar").find((bar) => within(bar).getByTestId("file-crumb-name").textContent === "app.ts")!;
    await flush();
    expect(within(other).queryByTestId("file-status")).toBeNull();
  });

  it("marks unsaved changes on its tab, closes with a middle click, and Close All Files leaves the chat", async () => {
    await show();
    const first = await open("docs/scripts.md");
    await open("src/app.ts");
    act(() => setEditorDirty(first, true));
    expect(within(tabs()[1]).getByLabelText("Unsaved")).toBeTruthy();
    // Middle click closes the tab it is on; the dirty one asks first (the dialog answers yes here).
    fireEvent(tabs()[2].closest("[data-tab-key]")!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await flush();
    expect(names()).toEqual(["Per-project scripts", "scripts.md"]);
    await open("src/app.ts");
    await act(async () => { runShortcut("files.closeAll"); });
    await flush();
    expect(names()).toEqual(["Per-project scripts"]);
    expect(selected()).toBe("Per-project scripts");
    expect(getTerminalState().selected.work?.kind).not.toBe("review");
  });

  it("is put back where it was by Reopen Closed Tab, and comes back after a restart", async () => {
    await show();
    const id = await open("docs/scripts.md");
    // What a restart reads: the tab's place, not its text.
    expect(restoreReviewTabs(localStorage.getItem("terminalx:review-tabs:v1")).editors.map((entry) => entry.id)).toEqual([id]);
    const row = workspaceRow(getSessionStore().sessions.find((entry) => entry.id === "work")!);
    await act(async () => { await closePeer("work", row.tabs[1], row.tabs, getTerminalState().selected.work); });
    await flush();
    expect(names()).toEqual(["Per-project scripts"]);
    expect(selected()).toBe("Per-project scripts");
    expect(getEditors().editors).toEqual([]);
    await act(async () => { await reopenClosedTab(workspaceRow(getSessionStore().sessions.find((entry) => entry.id === "work")!)); });
    await flush();
    expect(names()).toEqual(["Per-project scripts", "scripts.md"]);
    expect(selected()).toBe("scripts.md");
    expect(getEditors().editors.map((entry) => entry.id)).toEqual([id]);
  });

  it("toggles Preview and Source for the file tab on screen", async () => {
    await show();
    const id = await open("docs/scripts.md");
    expect(getEditors().editors.find((entry) => entry.id === id)?.viewMode).toBe("preview");
    act(() => { runShortcut("files.togglePreview"); });
    expect(getEditors().editors.find((entry) => entry.id === id)?.viewMode).toBe("source");
  });
});
