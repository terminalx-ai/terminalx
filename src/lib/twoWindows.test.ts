import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types/events";
import { buildTranscript } from "./transcript";
import type { SessionEntry } from "@/types/session";

/**
 * Two windows, one backend. The main window and the floating one each load
 * the page, so each has its own copy of every store; what keeps them the same
 * is that mutations go to the backend and the backend tells every window.
 *
 * Here each "window" is a fresh evaluation of the modules, and the backend is
 * one fake both talk to: its events go to every listener, whichever window
 * registered it, exactly as the app's emits do.
 */
const bus = vi.hoisted(() => ({
  listeners: [] as { event: string; handler: (event: { payload: unknown }) => void }[],
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: bus.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const entry = { event, handler };
    bus.listeners.push(entry);
    return () => bus.listeners.splice(bus.listeners.indexOf(entry), 1);
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn(async () => true), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: vi.fn(async () => undefined), setTheme: vi.fn(async () => undefined) }) }));

function emit(event: string, payload: unknown) {
  for (const listener of [...bus.listeners]) if (listener.event === event) listener.handler({ payload });
}

const scratch = "/home/.raccoon/quick";
function quickChat(id: string, title: string): SessionEntry {
  return {
    id,
    kind: "quick",
    projectPath: `${scratch}/${id}`,
    cwd: `${scratch}/${id}`,
    worktreeRemoved: false,
    title,
    created: "2026-10-01T00:00:00.000Z",
    modified: "2026-10-01T00:00:00.000Z",
    archived: false,
    pinned: false,
    tabs: [{ id: `${id}-tab`, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "2026-10-01T00:00:00.000Z", modified: "2026-10-01T00:00:00.000Z" }],
    activeTab: `${id}-tab`,
  };
}

/** The backend's own state: the index and the shells that are open. */
let index: SessionEntry[];
let shells: { id: string; sessionId: string; title: string | null; cwd: string; exited: boolean }[];
let made = 0;

function backend(command: string, args: Record<string, unknown> = {}): unknown {
  const session = () => index.find((entry) => entry.id === args.sessionId)!;
  switch (command) {
    case "list_projects":
      return { projects: [], lastSelected: null };
    case "list_sessions":
      return structuredClone(index);
    case "list_harnesses":
      return [];
    case "create_quick_chat": {
      const created = quickChat(`chat-${++made}`, (args.req as { title?: string }).title || "Quick chat");
      index.push(created);
      emit("session_created", structuredClone(created));
      return structuredClone(created);
    }
    case "rename_session":
      session().title = args.title as string;
      emit("session_updated", structuredClone(session()));
      return null;
    case "set_session_pinned":
      session().pinned = args.pinned as boolean;
      emit("session_updated", structuredClone(session()));
      return null;
    case "delete_session":
      index = index.filter((entry) => entry.id !== args.sessionId);
      emit("session_deleted", args.sessionId);
      return null;
    case "pty_detach_all":
      return null;
    case "pty_shells":
      return structuredClone(shells);
    case "pty_spawn": {
      const id = args.id as string;
      if (id.startsWith("tab:")) return null;
      const shell = { id, sessionId: id.split(":")[0], title: (args.title as string | null) ?? null, cwd: args.cwd as string, exited: false };
      shells.push(shell);
      emit("pty_opened", structuredClone(shell));
      return null;
    }
    case "pty_rename": {
      const shell = shells.find((entry) => entry.id === args.id);
      if (shell) {
        shell.title = args.title as string;
        emit("pty_renamed", structuredClone(shell));
      }
      return null;
    }
    case "pty_kill":
      if (shells.some((entry) => entry.id === args.id)) {
        shells = shells.filter((entry) => entry.id !== args.id);
        emit("pty_closed", args.id);
      }
      return null;
    case "frontend_log":
      return null;
    default:
      throw new Error(`Unexpected command: ${command}`);
  }
}

/** One window's own copy of the stores. */
async function openWindow(label: "main" | "floating") {
  vi.resetModules();
  const appWindow = await import("./appWindow");
  appWindow.setAppWindowForTest(label);
  const sessions = await import("./sessions");
  const terminal = await import("./terminal");
  const agentEvents = await import("./agentEvents");
  await sessions.bootSessions();
  await agentEvents.subscribeAgentEvents();
  await terminal.subscribeTerminals();
  return { sessions, terminal, agentEvents };
}

const titles = (win: Awaited<ReturnType<typeof openWindow>>) => win.sessions.getSessionStore().sessions.map((session) => session.title);
const shellsOf = (win: Awaited<ReturnType<typeof openWindow>>, sessionId: string) =>
  win.terminal.getTerminalState().panes.filter((pane) => pane.sessionId === sessionId).map((pane) => ({ id: pane.id, title: pane.title }));

beforeEach(() => {
  bus.listeners.length = 0;
  bus.invoke.mockReset();
  bus.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => backend(command, args));
  index = [quickChat("chat-0", "First question")];
  shells = [];
  made = 0;
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

describe("one session, two windows", () => {
  it("shows a session renamed or pinned in one window the same way in the other", async () => {
    const main = await openWindow("main");
    const floating = await openWindow("floating");
    expect(titles(main)).toEqual(["First question"]);
    expect(titles(floating)).toEqual(["First question"]);

    await floating.sessions.renameSession("chat-0", "Monads, explained");
    expect(titles(floating)).toEqual(["Monads, explained"]);
    expect(titles(main)).toEqual(["Monads, explained"]);

    await main.sessions.pinSession("chat-0", true);
    expect(floating.sessions.getSessionStore().sessions[0].pinned).toBe(true);
  });

  it("lists a quick chat started in the floating window in the main window at once, and forgets it in both when either deletes it", async () => {
    const main = await openWindow("main");
    const floating = await openWindow("floating");

    const created = await floating.sessions.createQuickChat({ title: "A new chat", tab: { harness: "claude", model: "", permissionMode: "bypassPermissions" } });
    expect(bus.invoke).toHaveBeenCalledWith("create_quick_chat", { req: { title: "A new chat", tab: { harness: "claude", model: "", permissionMode: "bypassPermissions" } } });
    expect(titles(main)).toEqual(["First question", "A new chat"]);
    // Listed once in the window that made it, though it both made it and heard of it.
    expect(titles(floating)).toEqual(["First question", "A new chat"]);

    floating.sessions.selectSession(created.id);
    main.sessions.selectSession(created.id);
    await main.sessions.deleteSession(created.id);
    for (const win of [main, floating]) {
      expect(titles(win)).toEqual(["First question"]);
      expect(win.sessions.getSessionStore().selectedSessionId).toBeNull();
    }
  });

  it("keeps each window's own selection: opening a session in one does not move the other", async () => {
    const main = await openWindow("main");
    const floating = await openWindow("floating");
    floating.sessions.selectSession("chat-0");
    expect(floating.sessions.getSessionStore().selectedSessionId).toBe("chat-0");
    expect(main.sessions.getSessionStore().selectedSessionId).toBeNull();
    // A quick chat has no project, so selecting it focuses none.
    expect(floating.sessions.getSessionStore().selectedProject).toBeNull();
    expect(bus.invoke.mock.calls.some(([command]) => command === "list_workspaces")).toBe(false);
  });

  it("shows the same shell tabs for a session in both windows, under the same names", async () => {
    const main = await openWindow("main");
    const floating = await openWindow("floating");

    const opened = await floating.terminal.openTerminal("chat-0", `${scratch}/chat-0`);
    expect(opened.title).toBe("Terminal 1");
    expect(shellsOf(main, "chat-0")).toEqual([{ id: opened.id, title: "Terminal 1" }]);
    // Listed in the other window, not selected there: its view is its own.
    expect(floating.terminal.getTerminalState().selected["chat-0"]).toEqual({ kind: "terminal", id: opened.id });
    expect(main.terminal.getTerminalState().selected["chat-0"]).toBeUndefined();

    // A second one, opened from the other window, takes the next number rather than the same one.
    const second = await main.terminal.openTerminal("chat-0", `${scratch}/chat-0`);
    expect(second.title).toBe("Terminal 2");
    expect(shellsOf(floating, "chat-0").map((shell) => shell.title)).toEqual(["Terminal 1", "Terminal 2"]);

    main.terminal.renameTerminal(second.id, "dev server");
    await vi.waitFor(() => expect(shellsOf(floating, "chat-0").map((shell) => shell.title)).toEqual(["Terminal 1", "dev server"]));

    // Closed in one, it is gone from both; the other's process call is not repeated.
    await main.terminal.closeTerminal(opened.id);
    expect(shellsOf(main, "chat-0").map((shell) => shell.id)).toEqual([second.id]);
    expect(shellsOf(floating, "chat-0").map((shell) => shell.id)).toEqual([second.id]);
    expect(bus.invoke.mock.calls.filter(([command]) => command === "pty_kill")).toHaveLength(1);
  });

  it("lists the shells that were already open for a window made later", async () => {
    const main = await openWindow("main");
    await main.terminal.openTerminal("chat-0", `${scratch}/chat-0`);
    main.terminal.renameTerminal(main.terminal.getTerminalState().panes[0].id, "build");
    await vi.waitFor(() => expect(shells[0].title).toBe("build"));

    // The floating window is made on demand, after all of that happened.
    const floating = await openWindow("floating");
    await vi.waitFor(() => expect(shellsOf(floating, "chat-0")).toEqual(shellsOf(main, "chat-0")));
    // A session with no agent would open a shell for itself: it takes the one that is there instead.
    const taken = await floating.terminal.activateLatestTerminal("chat-0", `${scratch}/chat-0`);
    expect(taken.id).toBe(shells[0].id);
    expect(bus.invoke.mock.calls.filter(([command]) => command === "pty_spawn")).toHaveLength(1);
  });

  it("draws the same transcript and status in both, from one stream of events", async () => {
    const main = await openWindow("main");
    const floating = await openWindow("floating");
    const event = (seq: number, payload: Record<string, unknown>): AgentEvent =>
      ({ id: `e${seq}`, seq, ts: "2026-10-01T00:00:00.000Z", sessionId: "chat-0", tabId: "chat-0-tab", harness: "claude", payload }) as unknown as AgentEvent;

    emit("agent_event", event(1, { type: "user_message", text: "What is a monad?", images: [], queued: false }));
    emit("tab_status", { sessionId: "chat-0", tabId: "chat-0-tab", status: "in_progress" });
    emit("agent_event", event(2, { type: "permission_requested", requestId: "p1", toolUseId: "tool-1", toolName: "Bash", input: { command: "ls" }, options: [] }));
    emit("tab_status", { sessionId: "chat-0", tabId: "chat-0-tab", status: "waiting" });
    const pending = (win: Awaited<ReturnType<typeof openWindow>>) => buildTranscript(win.agentEvents.getTabLog("chat-0", "chat-0-tab").events, true).pendingAsks.map((ask) => ask.requestId);
    for (const win of [main, floating]) {
      expect(win.agentEvents.getTabLog("chat-0", "chat-0-tab").events.map((item) => item.id)).toEqual(["e1", "e2"]);
      expect(win.sessions.getSessionStore().sessions[0].tabs[0].status).toBe("waiting");
      // The permission card is on screen in both.
      expect(pending(win)).toEqual(["p1"]);
    }

    // The window that sent a prompt also gets it back in the reply; it is not drawn twice there.
    floating.agentEvents.applyEvent(event(1, { type: "user_message", text: "What is a monad?", images: [], queued: false }));
    expect(floating.agentEvents.getTabLog("chat-0", "chat-0-tab").events).toHaveLength(2);

    // Answered in one window: the decision is an event like any other, so the card goes from both.
    emit("agent_event", event(3, { type: "permission_decided", requestId: "p1", toolUseId: "tool-1", allowed: true, label: "Allow", automatic: false }));
    emit("tab_status", { sessionId: "chat-0", tabId: "chat-0-tab", status: "in_progress" });
    for (const win of [main, floating]) {
      expect(pending(win)).toEqual([]);
      expect(win.sessions.getSessionStore().sessions[0].tabs[0].status).toBe("in_progress");
    }
  });

  it("does not let a backend that never lists its shells hold up a terminal", async () => {
    bus.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => (command === "pty_shells" ? new Promise(() => undefined) : backend(command, args)));
    vi.useFakeTimers();
    try {
      const main = await openWindow("main");
      // Subscribed, so a view can attach, although the list never came.
      const opening = main.terminal.activateLatestTerminal("chat-0", `${scratch}/chat-0`);
      await vi.advanceTimersByTimeAsync(2000);
      expect((await opening).title).toBe("Terminal 1");
    } finally {
      vi.useRealTimers();
    }
  });
});
