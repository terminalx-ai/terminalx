import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionChrome } from "@/components/session/SessionView";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  ask: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: vi.fn(async () => undefined), setTheme: vi.fn(async () => undefined) }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn(async () => true), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask, message: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/models", async (original) => ({ ...(await original<typeof import("@/lib/models")>()), loadModels: vi.fn(async () => undefined) }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set() }));
// The session view and the start form are tested on their own; here it is the shell around them.
vi.mock("@/components/session/SessionView", () => ({
  SessionView: ({ session, chrome }: { session: SessionEntry; chrome?: SessionChrome }) => (
    <div data-testid="session-view" data-session={session.id} data-compact={String(!!chrome?.compact)} data-tab-strip={String(!!chrome?.tabStrip)}>
      <header>{chrome?.leading}{chrome?.trailing}</header>
      <textarea data-composer aria-label="Message" />
    </div>
  ),
}));
vi.mock("@/components/session/NewSessionView", () => ({
  NewSessionView: ({ quick, compact, onCreated }: { quick?: boolean; compact?: boolean; onCreated?: (sessionId: string, tabId: string, text: string) => void }) => (
    <div data-testid="start" data-quick={String(!!quick)} data-compact={String(!!compact)}>
      <textarea data-new-session-prompt aria-label="Prompt" />
      <button type="button" onClick={() => onCreated?.("chat-new", "tab-new", "hello")}>Start</button>
    </div>
  ),
}));

function chat(id: string, title: string, patch: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    kind: "quick",
    projectPath: `/home/.raccoon/quick/${id}`,
    cwd: `/home/.raccoon/quick/${id}`,
    worktreeRemoved: false,
    title,
    created: "2026-10-01T00:00:00.000Z",
    modified: "2026-10-01T00:00:00.000Z",
    archived: false,
    pinned: false,
    tabs: [{ id: `${id}-tab`, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "x", modified: "x" }],
    activeTab: `${id}-tab`,
    ...patch,
  };
}

let stored: SessionEntry[];
let visible: boolean;
let pending: { sessionId: string; tabId?: string | null } | null;
let status: { shortcut: string | null; alwaysOnTop: boolean; retentionDays: number; shortcutError: string | null };

async function mount() {
  vi.resetModules();
  (await import("@/lib/appWindow")).setAppWindowForTest("floating");
  const { FloatingShell } = await import("./FloatingShell");
  const sessions = await import("@/lib/sessions");
  const utils = render(
    <TooltipProvider>
      <FloatingShell />
    </TooltipProvider>,
  );
  await waitFor(() => expect(sessions.getSessionStore().loaded).toBe(true));
  return { ...utils, sessions };
}

const called = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

beforeEach(() => {
  localStorage.clear();
  mocks.listeners.clear();
  mocks.ask.mockReset();
  stored = [];
  visible = true;
  pending = null;
  status = { shortcut: "alt+shift+space", alwaysOnTop: true, retentionDays: 30, shortcutError: null };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "list_projects":
        // No project is attached, and none is needed.
        return { projects: [], lastSelected: null };
      case "list_sessions":
        return stored;
      case "list_harnesses":
        return [{ id: "claude", name: "Claude", available: true }];
      case "floating_status":
        return status;
      case "floating_visible":
        return visible;
      case "floating_take_pending":
        return pending;
      case "set_floating_settings":
        status = { ...status, ...(args.patch as object) };
        return status;
      case "send_message":
        return { events: [] };
      case "floating_hide":
      case "floating_open_in_main":
      case "frontend_log":
        return null;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
});

describe("the floating chat window", () => {
  it("starts on a quick-chat prompt with no project attached, and sends the first prompt once the chat exists", async () => {
    await mount();
    const start = await screen.findByTestId("start");
    // The same new-session form as the main window, asked for a quick chat in a small window.
    expect(start.getAttribute("data-quick")).toBe("true");
    expect(start.getAttribute("data-compact")).toBe("true");
    expect(screen.getByTestId("quick-chat-switcher").textContent).toContain("New quick chat");
    // Ready to type.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Prompt")));

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(called("send_message")).toEqual([{ sessionId: "chat-new", tabId: "tab-new", text: "hello", images: null, confirmDelivery: false }]));
  });

  it("shows a session in compact chrome with its tabs in a strip, and remembers it for the next time the window opens", async () => {
    stored = [chat("chat-1", "What is a monad?"), chat("chat-2", "Regex help")];
    const first = await mount();
    act(() => first.sessions.selectSession("chat-2"));
    const view = await screen.findByTestId("session-view");
    expect(view.getAttribute("data-session")).toBe("chat-2");
    expect(view.getAttribute("data-compact")).toBe("true");
    expect(view.getAttribute("data-tab-strip")).toBe("true");
    expect(screen.getByTestId("quick-chat-switcher").textContent).toContain("Regex help");
    await waitFor(() => expect(localStorage.getItem("raccoon.floating.session")).toBe("chat-2"));
    cleanup();

    // The page is loaded afresh (the app restarted): it opens on the chat it showed last.
    await mount();
    expect((await screen.findByTestId("session-view")).getAttribute("data-session")).toBe("chat-2");
  });

  it("opens on the session it was asked to show before its page had loaded, and on later requests", async () => {
    stored = [chat("chat-1", "What is a monad?"), chat("chat-2", "Regex help")];
    localStorage.setItem("raccoon.floating.session", "chat-1");
    pending = { sessionId: "chat-2", tabId: "chat-2-tab" };
    const { sessions } = await mount();
    await waitFor(() => expect(sessions.getSessionStore().selectedSessionId).toBe("chat-2"));

    // A notification, or "Open in floating window" from the main window.
    act(() => mocks.listeners.get("floating_open")?.({ payload: { sessionId: "chat-1", tabId: null } }));
    await waitFor(() => expect(sessions.getSessionStore().selectedSessionId).toBe("chat-1"));
    // An empty id asks for a new chat.
    act(() => mocks.listeners.get("floating_open")?.({ payload: { sessionId: "" } }));
    await waitFor(() => expect(sessions.getSessionStore().selectedSessionId).toBeNull());
    expect(await screen.findByTestId("start")).toBeTruthy();
  });

  it("switches between recent quick chats and starts a new one, without listing project sessions", async () => {
    stored = [
      chat("chat-1", "What is a monad?", { modified: "2026-10-01T00:00:00.000Z" }),
      chat("chat-2", "Regex help", { modified: "2026-10-03T00:00:00.000Z" }),
      chat("chat-old", "Archived chat", { archived: true }),
      { ...chat("project-1", "Fix login"), kind: undefined, projectPath: "/repos/api", cwd: "/repos/api" },
    ];
    const { sessions } = await mount();
    fireEvent.click(await screen.findByTestId("quick-chat-switcher"));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim());
    expect(items).toEqual(["New quick chat", "Regex help", "What is a monad?"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Regex help" }));
    await waitFor(() => expect(sessions.getSessionStore().selectedSessionId).toBe("chat-2"));
    fireEvent.click(await screen.findByTestId("quick-chat-switcher"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New quick chat" }));
    await waitFor(() => expect(sessions.getSessionStore().selectedSessionId).toBeNull());
  });

  it("hands its session to the main window and pins or unpins itself", async () => {
    stored = [chat("chat-1", "What is a monad?")];
    const { sessions } = await mount();
    act(() => sessions.selectSession("chat-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Open in main window" }));
    await waitFor(() => expect(called("floating_open_in_main")).toEqual([{ sessionId: "chat-1", tabId: "chat-1-tab" }]));

    const pin = screen.getByRole("button", { name: "Keep on top" });
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pin);
    await waitFor(() => expect(called("set_floating_settings")).toEqual([{ patch: { alwaysOnTop: false } }]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep on top" }).getAttribute("aria-pressed")).toBe("false"));
  });

  it("offers rename, a working directory, move to project and delete for the chat on screen", async () => {
    stored = [chat("chat-1", "What is a monad?")];
    const { sessions } = await mount();
    act(() => sessions.selectSession("chat-1"));
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["Rename…", "Set working directory…", "Move to project…", "Delete quick chat…"]);
  });

  it("hides on Escape when nothing else wanted the key, and stops nothing", async () => {
    stored = [chat("chat-1", "What is a monad?", { tabs: [{ id: "chat-1-tab", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "in_progress", created: "x", modified: "x" }] })];
    const { sessions } = await mount();
    act(() => sessions.selectSession("chat-1"));
    const composer = await screen.findByLabelText("Message");

    // A menu is open: Escape closes the menu, not the window.
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await screen.findAllByRole("menuitem");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(called("floating_hide")).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // Something else took the key (the composer closing its own popup).
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    composer.dispatchEvent(taken);
    // A terminal keeps its Escape.
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    document.body.appendChild(terminal);
    fireEvent.keyDown(terminal, { key: "Escape" });
    terminal.remove();
    expect(called("floating_hide")).toEqual([]);

    fireEvent.keyDown(composer, { key: "Escape" });
    await waitFor(() => expect(called("floating_hide")).toHaveLength(1));
    // Hiding is all it did: no tab was stopped, no session closed.
    expect(mocks.invoke.mock.calls.map(([command]) => command).filter((command) => /stop|interrupt|delete|kill|remove/.test(command))).toEqual([]);
    expect(sessions.getSessionStore().sessions[0].tabs[0].status).toBe("in_progress");
  });

  it("draws no session while it is hidden, so nothing is read behind the reader's back, and is ready to type when shown", async () => {
    stored = [chat("chat-1", "What is a monad?")];
    visible = false;
    const { sessions } = await mount();
    act(() => sessions.selectSession("chat-1"));
    await waitFor(() => expect(mocks.listeners.has("floating_visible")).toBe(true));
    expect(screen.queryByTestId("session-view")).toBeNull();

    act(() => mocks.listeners.get("floating_visible")?.({ payload: true }));
    const composer = await screen.findByLabelText("Message");
    await waitFor(() => expect(document.activeElement).toBe(composer));
    // The chat it shows was kept while it was away.
    expect(screen.getByTestId("session-view").getAttribute("data-session")).toBe("chat-1");

    act(() => mocks.listeners.get("floating_visible")?.({ payload: false }));
    await waitFor(() => expect(screen.queryByTestId("session-view")).toBeNull());
  });

  it("goes back to the start screen when its chat is deleted from the main window", async () => {
    stored = [chat("chat-1", "What is a monad?")];
    const { sessions } = await mount();
    act(() => sessions.selectSession("chat-1"));
    await screen.findByTestId("session-view");
    act(() => mocks.listeners.get("session_deleted")?.({ payload: "chat-1" }));
    expect(await screen.findByTestId("start")).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem("raccoon.floating.session")).toBeNull());
  });

  it("keeps a prompt half typed on the start screen when the window is hidden and shown again", async () => {
    await mount();
    const prompt = (await screen.findByLabelText("Prompt")) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "half a thought" } });
    act(() => mocks.listeners.get("floating_visible")?.({ payload: false }));
    act(() => mocks.listeners.get("floating_visible")?.({ payload: true }));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("half a thought");
  });
});
