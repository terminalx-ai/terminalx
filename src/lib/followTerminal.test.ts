import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { PaneAgent, ShellPane, TabPtyEvent } from "@/lib/api";
import type { SessionEntry, TabEntry } from "@/types/session";
import { byHandLock, defaultTabView, followedSelection, tabLabel, tabPaneId, tabViewIn } from "./tabFront";
import { buildTranscript, conversationEvents } from "./transcript";

/**
 * Tabs follow what runs in their terminal (#437), as a window sees it.
 *
 * The backend decides what a tab is: it watches each terminal and tells
 * every window. These tests are the window's half: the same stores the app
 * runs, and a fake backend that says what the real one says when an agent is
 * started in a shell by hand, exits, and another is started there.
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

const at = (second: number) => `2026-10-12T10:00:${String(second).padStart(2, "0")}.000Z`;
const agentTab = (id: string, harness: string, created: string, more: Partial<TabEntry> = {}): TabEntry => ({ id, harness, model: "", permissionMode: "bypassPermissions", status: "idle", created, modified: created, ...more });

/** The backend's own state. */
let session: SessionEntry;
let shells: ShellPane[];
let agents: PaneAgent[];
let clock = 0;

function backend(command: string, args: Record<string, unknown> = {}): unknown {
  switch (command) {
    case "list_projects":
      return { projects: [], lastSelected: null };
    case "list_sessions":
      return [structuredClone(session)];
    case "list_harnesses":
      return [];
    case "pty_detach_all":
    case "frontend_log":
    case "set_active_tab":
      return null;
    case "pty_shells":
      // A shell an agent was started in is that agent's tab, and is not listed as a shell as well.
      return structuredClone(shells.filter((shell) => !session.tabs.some((tab) => tab.pane === shell.id)));
    case "pane_agents":
      return structuredClone(agents);
    case "pty_spawn": {
      const shell: ShellPane = { id: args.id as string, sessionId: session.id, title: (args.title as string | null) ?? null, cwd: args.cwd as string, exited: false, created: at(++clock) };
      shells.push(shell);
      emit("pty_opened", structuredClone(shell));
      return null;
    }
    default:
      throw new Error(`Unexpected command: ${command}`);
  }
}

/** What the backend does when an agent comes to the front of a shell's terminal. */
function agentStartedIn(paneId: string, harness: string, chat: boolean) {
  agents = [...agents.filter((agent) => agent.paneId !== paneId), { paneId, harness }];
  emit("pane_agent", { paneId, harness } satisfies PaneAgent);
  if (!chat) return;
  const shell = shells.find((candidate) => candidate.id === paneId)!;
  const existing = session.tabs.find((tab) => tab.pane === paneId);
  if (existing) Object.assign(existing, { harness, front: "by_hand" });
  else session.tabs.push(agentTab(`tab-of-${paneId}`, harness, shell.created!, { front: "by_hand", pane: paneId, terminalTitle: shell.title, permissionMode: "terminal" }));
  const tab = session.tabs.find((candidate) => candidate.pane === paneId)!;
  emit("tab_pty", { sessionId: session.id, tabId: tab.id, paneId, command: `${harness} (started in this terminal)`, harness, byHand: true } satisfies TabPtyEvent);
  emit("session_updated", structuredClone(session));
}

function agentLeft(paneId: string) {
  agents = agents.filter((agent) => agent.paneId !== paneId);
  emit("pane_agent", { paneId, harness: null } satisfies PaneAgent);
  const tab = session.tabs.find((candidate) => candidate.pane === paneId);
  if (!tab) return;
  tab.front = "terminal";
  emit("session_updated", structuredClone(session));
}

/** One window's own copy of the stores. */
async function openWindow(label: "main" | "floating") {
  vi.resetModules();
  const appWindow = await import("./appWindow");
  appWindow.setAppWindowForTest(label);
  const sessions = await import("./sessions");
  const terminal = await import("./terminal");
  const tabViews = await import("./tabViews");
  const sessionTabs = await import("./sessionTabs");
  await sessions.bootSessions();
  await terminal.subscribeTerminals();
  await tabViews.subscribeTabPty();
  const current = () => sessions.getSessionStore().sessions.find((entry) => entry.id === session.id)!;
  /** The session's tabs as the sidebar lists them: what each is drawn as, and under which name. */
  const rows = () => {
    const state = terminal.getTerminalState();
    return sessionTabs.peerOrder(current(), state.panes).map((peer) =>
      peer.kind === "agent"
        ? `${peer.tab.front === "terminal" ? "terminal" : peer.tab.harness}: ${tabLabel(peer.tab, (harness) => harness, state.agents[tabPaneId(peer.tab)])}`
        : peer.kind === "terminal"
          ? `${state.agents[peer.id] ?? "terminal"}: ${peer.pane.title}`
          : "browser",
    );
  };
  const selected = () => {
    const state = terminal.getTerminalState();
    const peer = sessionTabs.selectedPeer(current(), sessionTabs.peerOrder(current(), state.panes), state.selected[session.id]);
    return peer ? `${peer.kind}:${peer.id}` : null;
  };
  return { sessions, terminal, tabViews, rows, selected, current };
}

beforeEach(() => {
  bus.listeners.length = 0;
  bus.invoke.mockReset();
  bus.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => backend(command, args));
  clock = 0;
  session = {
    id: "s1",
    projectPath: "/work/app",
    cwd: "/work/app",
    worktreeRemoved: false,
    title: "Follow",
    created: at(0),
    modified: at(0),
    archived: false,
    pinned: false,
    tabs: [agentTab("first", "codex", at(0), { title: "Fix the build" })],
    activeTab: "first",
  };
  shells = [];
  agents = [];
  localStorage.clear();
});

describe("a tab follows what runs in its terminal", () => {
  it("turns a shell into the tab of the agent started in it, in place, selected as it was, and back when the agent exits", async () => {
    const main = await openWindow("main");
    const floating = await openWindow("floating");
    const shell = await main.terminal.openTerminal(session.id, session.cwd);
    // A tab made after the shell, to show the shell keeps its place among them.
    session.tabs.push(agentTab("later", "claude", at(30), { title: "Write the docs" }));
    emit("session_updated", structuredClone(session));
    expect(main.rows()).toEqual(["codex: Fix the build", "terminal: Terminal 1", "claude: Write the docs"]);
    expect(main.selected()).toBe(`terminal:${shell.id}`);

    // `claude` is typed into the shell.
    agentStartedIn(shell.id, "claude", true);
    for (const win of [main, floating]) {
      // One row where there was one, now Claude Code's; the shell is not listed beside it.
      expect(win.rows()).toEqual(["codex: Fix the build", "claude: claude", "claude: Write the docs"]);
    }
    const tab = main.current().tabs.find((candidate) => candidate.pane === shell.id)!;
    // The window that was on the shell is on the tab it became; the other window stays where it was.
    expect(main.selected()).toBe(`agent:${tab.id}`);
    expect(floating.selected()).toBe("agent:first");
    // It opens on the terminal the reader started it in; the chat is one switch away.
    expect(main.tabViews.tabViewOf(tab)).toBe("terminal");
    await main.tabViews.toggleTabView(main.current(), tab);
    expect(main.tabViews.tabViewOf(tab)).toBe("chat");

    // It exits: the same row, a terminal again under the name it had as one.
    agentLeft(shell.id);
    for (const win of [main, floating]) expect(win.rows()).toEqual(["codex: Fix the build", "terminal: Terminal 1", "claude: Write the docs"]);
    expect(main.selected()).toBe(`agent:${tab.id}`);

    // Codex next, in the same terminal: the same tab, now Codex's.
    agentStartedIn(shell.id, "codex", true);
    for (const win of [main, floating]) expect(win.rows()).toEqual(["codex: Fix the build", "codex: codex", "claude: Write the docs"]);
    expect(main.selected()).toBe(`agent:${tab.id}`);

    // A window made afterwards lists it the same way, once.
    const late = await openWindow("floating");
    await vi.waitFor(() => expect(late.terminal.getTerminalState().agents).toEqual({ [shell.id]: "codex" }));
    expect(late.rows()).toEqual(["codex: Fix the build", "codex: codex", "claude: Write the docs"]);
  });

  it("draws a terminal as the agent in front of it when that is one the app has no chat for, and as a terminal again after", async () => {
    const main = await openWindow("main");
    const shell = await main.terminal.openTerminal(session.id, session.cwd);
    agentStartedIn(shell.id, "opencode", false);
    // Still the shell's tab, with no entry of its own: only what it is drawn as changes.
    expect(main.rows()).toEqual(["codex: Fix the build", "opencode: Terminal 1"]);
    expect(main.current().tabs).toHaveLength(1);
    expect(main.selected()).toBe(`terminal:${shell.id}`);
    agentLeft(shell.id);
    expect(main.rows()).toEqual(["codex: Fix the build", "terminal: Terminal 1"]);
  });
});

describe("what a tab is called and shows", () => {
  const name = (harness: string) => ({ claude: "Claude Code", codex: "Codex", opencode: "OpenCode" })[harness] ?? harness;

  it("goes by the reader's name whatever runs in it, else by its conversation, its agent, or the name it has as a terminal", () => {
    const tab = agentTab("t", "claude", at(0));
    expect(tabLabel(tab, name)).toBe("Claude Code");
    expect(tabLabel({ ...tab, title: "Fix login" }, name)).toBe("Fix login");
    // As a terminal it is not called by the conversation it last held.
    expect(tabLabel({ ...tab, title: "Fix login", front: "terminal", terminalTitle: "Terminal 2" }, name)).toBe("Terminal 2");
    expect(tabLabel({ ...tab, title: "Fix login", front: "terminal" }, name)).toBe("Terminal");
    expect(tabLabel({ ...tab, front: "terminal", terminalTitle: "Terminal 2" }, name, "opencode")).toBe("OpenCode");
    // A name the reader gave is never replaced.
    for (const front of ["agent", "by_hand", "terminal"] as const) {
      expect(tabLabel({ ...tab, title: "dev server", titlePinned: true, front, terminalTitle: "Terminal 2" }, name, "opencode")).toBe("dev server");
    }
  });

  it("opens on the chat when the app runs the agent, and on the terminal when the reader started it or nothing runs", () => {
    const tab = agentTab("t", "claude", at(0));
    expect(defaultTabView(tab)).toBe("chat");
    expect(defaultTabView({ front: "agent" })).toBe("chat");
    expect(defaultTabView({ front: "by_hand" })).toBe("terminal");
    expect(defaultTabView({ front: "terminal" })).toBe("terminal");
    // A face the reader picked stands until what is in the terminal changes.
    expect(tabViewIn({ t: "chat" }, { id: "t", front: "by_hand" })).toBe("chat");
    expect(tabViewIn({}, { id: "t", front: "by_hand" })).toBe("terminal");
    expect(tabPaneId(tab)).toBe("tab:t");
    expect(tabPaneId({ id: "t", pane: "s1:abc" })).toBe("s1:abc");
  });

  it("follows a selected shell to the tab it became, and leaves every other selection alone", () => {
    const tabs = [agentTab("a", "claude", at(0)), agentTab("b", "codex", at(1), { pane: "s1:shell" })];
    expect(followedSelection({ tabs }, { kind: "terminal", id: "s1:shell" })).toEqual({ kind: "agent", id: "b" });
    expect(followedSelection({ tabs }, { kind: "terminal", id: "s1:other" })).toEqual({ kind: "terminal", id: "s1:other" });
    expect(followedSelection({ tabs }, { kind: "agent", id: "a" })).toEqual({ kind: "agent", id: "a" });
    expect(followedSelection({ tabs }, { kind: "browser", id: "s1:shell" })).toEqual({ kind: "browser", id: "s1:shell" });
    expect(followedSelection({ tabs }, undefined)).toBeUndefined();
  });

  it("locks only what needs the hand-started CLI restarted, and says why", () => {
    const claude = byHandLock(agentTab("t", "claude", at(0), { front: "by_hand" }), "Claude Code");
    // Claude Code takes a model or an effort while it runs; its permission mode it reads at startup.
    expect(claude.model).toBeNull();
    expect(claude.mode).toMatch(/Claude Code was started by hand in this tab's terminal.*cannot restart it to change the permission mode/);
    const codex = byHandLock(agentTab("t", "codex", at(0), { front: "by_hand" }), "Codex");
    expect(codex.model).toMatch(/cannot restart it to change the model or effort/);
    expect(codex.mode).toMatch(/permission mode/);
    // An agent the app runs is the app's to restart: nothing is locked.
    expect(byHandLock(agentTab("t", "codex", at(0)), "Codex")).toEqual({ model: null, mode: null });
    expect(byHandLock(agentTab("t", "codex", at(0), { front: "terminal" }), "Codex")).toEqual({ model: null, mode: null });
  });
});

describe("the conversations of one tab", () => {
  let seq = 0;
  const event = (harness: string, payload: Payload): AgentEvent => ({ id: `e${++seq}`, sessionId: "s1", tabId: "t", harness, seq, ts: at(seq), payload });
  const prompts = (events: AgentEvent[]) => buildTranscript(events, false).turns.flatMap((turn) => (turn.prompt ? [turn.prompt.text] : []));

  it("are kept apart in the one log: each is its own chat, and one picked up again is all of its stretches", () => {
    const log = [
      event("claude", { type: "user_message", text: "first, with Claude", queued: false }),
      event("claude", { type: "turn_completed", status: "ok", authFailed: false }),
      event("claude", { type: "status", text: "Claude Code exited." }),
      event("codex", { type: "conversation", id: "c2", harness: "codex" }),
      event("codex", { type: "user_message", text: "then, with Codex", queued: false }),
      event("codex", { type: "turn_completed", status: "ok", authFailed: false }),
      event("claude", { type: "conversation", harness: "claude", resumed: true }),
      event("claude", { type: "user_message", text: "back with Claude", queued: false }),
    ];
    expect(prompts(conversationEvents(log, "c2"))).toEqual(["then, with Codex"]);
    expect(prompts(conversationEvents(log, null))).toEqual(["first, with Claude", "back with Claude"]);
    // Nothing is lost between them, and the markers themselves draw nothing.
    expect(conversationEvents(log, null).length + conversationEvents(log, "c2").length).toBe(log.length - 2);
    expect(prompts(log)).toEqual(["first, with Claude", "then, with Codex", "back with Claude"]);
    expect(conversationEvents(log, "never")).toEqual([]);
  });

  it("a tab that never changed hands is one conversation, returned as it is", () => {
    const log = [event("claude", { type: "user_message", text: "only one", queued: false })];
    expect(conversationEvents(log, null)).toBe(log);
    expect(conversationEvents(log, "c2")).toEqual([]);
  });
});
