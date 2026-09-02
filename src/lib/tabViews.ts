import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { agent, errorMessage, type HandoffInfo, type TabPtyEvent } from "@/lib/api";
import { adoptPane, closeTerminal, openTerminal } from "@/lib/terminal";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * Which face a tab shows: the transcript, or the agent's own CLI in a terminal.
 *
 * For a PTY-first agent the two are the same process — the CLI *is* the tab —
 * so switching is a view flag and nothing is stopped, resumed or reconciled.
 * The terminal pane stays mounted underneath the chat, which is why coming
 * back is instant and keeps the scrollback.
 *
 * The agents still driven headless keep the old hand-off: their child is
 * stopped and a second command resumes the same conversation in a terminal.
 */
export type TabViewMode = "chat" | "terminal";

/** Agents whose tab is the CLI itself. */
export function isPtyFirst(harness: string): boolean {
  return harness === "claude";
}

interface State {
  views: Record<string, TabViewMode>;
  info: Record<string, HandoffInfo>;
  errors: Record<string, string | null>;
  switching: Record<string, boolean>;
}

let state: State = { views: {}, info: {}, errors: {}, switching: {} };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useTabViews(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

export function terminalPaneId(tabId: string): string {
  return `tab:${tabId}`;
}

export function tabViewOf(tabId: string): TabViewMode {
  return state.views[tabId] ?? "chat";
}

export function clearTabViewError(tabId: string) {
  set({ errors: { ...state.errors, [tabId]: null } });
}

/**
 * A PTY-first tab's CLI is spawned by the backend, which then names the pane
 * it landed in. Adopting it here is what routes the pane's output to this
 * window's xterm instance.
 */
let subscribed: Promise<void> | null = null;
export function subscribeTabPty(): Promise<void> {
  return (subscribed ??= registerTabPty());
}

async function registerTabPty() {
  try {
    await listen<TabPtyEvent>("tab_pty", (e) => {
      const { sessionId, tabId, paneId, command } = e.payload;
      void adoptPane({ id: paneId, sessionId, title: "Agent", hidden: true, owned: true });
      set({ info: { ...state.info, [tabId]: { command, harness: "claude" } } });
    });
  } catch {
    /* outside a webview */
  }
}

/**
 * Start a PTY-first tab's CLI and take over its pane. Opening the tab is what
 * starts the agent.
 *
 * Asking for the pane afterwards is what makes this work across an app
 * restart: the backend announces a pane when it opens one, but a window that
 * mounts later — or twice, as a development build does — was not listening
 * then. In-flight calls are shared, because two starts racing is exactly how a
 * tab ended up with two CLIs fighting over one conversation.
 */
const starting = new Map<string, Promise<void>>();

export async function startTabAgent(session: SessionEntry, tab: TabEntry) {
  if (!isPtyFirst(tab.harness)) return;
  const key = `${session.id}/${tab.id}`;
  const inflight = starting.get(key);
  if (inflight) return inflight;
  const run = (async () => {
    await subscribeTabPty();
    try {
      await agent.ensureStarted(session.id, tab.id);
      await adoptTabPane(session.id, tab.id);
      clearTabViewError(tab.id);
    } catch (e) {
      set({ errors: { ...state.errors, [tab.id]: errorMessage(e) } });
    }
  })().finally(() => starting.delete(key));
  starting.set(key, run);
  return run;
}

/** Take over the pane a tab's CLI is already running in, if there is one. */
async function adoptTabPane(sessionId: string, tabId: string) {
  const pane = await agent.tabPane(sessionId, tabId);
  if (!pane) return;
  await adoptPane({ id: pane.paneId, sessionId, title: "Agent", hidden: true, owned: true });
  set({ info: { ...state.info, [tabId]: { command: pane.command, harness: "claude" } } });
}

/** Show the tab's CLI. For a headless agent this stops it and resumes it there. */
export async function enterTerminalView(session: SessionEntry, tab: TabEntry) {
  if (state.switching[tab.id] || tabViewOf(tab.id) === "terminal") return;
  set({ switching: { ...state.switching, [tab.id]: true }, errors: { ...state.errors, [tab.id]: null } });
  try {
    if (isPtyFirst(tab.harness)) {
      await startTabAgent(session, tab);
      // The toggle can be the first thing that happens to a tab in this
      // window, so the pane may still need claiming.
      await adoptTabPane(session.id, tab.id);
    } else {
      const info = await agent.tabHandoff(session.id, tab.id);
      await openTerminal(session.id, session.cwd, 100, 24, { id: terminalPaneId(tab.id), title: tab.title ?? tab.harness, command: info.command, hidden: true });
      set({ info: { ...state.info, [tab.id]: info } });
    }
    set({ views: { ...state.views, [tab.id]: "terminal" } });
  } catch (e) {
    set({ errors: { ...state.errors, [tab.id]: errorMessage(e) } });
  } finally {
    set({ switching: { ...state.switching, [tab.id]: false } });
  }
}

/** Show the transcript again. A PTY-first tab leaves its CLI running. */
export async function leaveTerminalView(_session: SessionEntry, tab: TabEntry) {
  if (tabViewOf(tab.id) !== "terminal") return;
  set({ switching: { ...state.switching, [tab.id]: true } });
  try {
    if (!isPtyFirst(tab.harness)) await closeTerminal(terminalPaneId(tab.id));
  } finally {
    const views = { ...state.views };
    delete views[tab.id];
    const info = { ...state.info };
    if (!isPtyFirst(tab.harness)) delete info[tab.id];
    set({ views, info, switching: { ...state.switching, [tab.id]: false } });
  }
}

export async function toggleTabView(session: SessionEntry, tab: TabEntry) {
  if (tabViewOf(tab.id) === "terminal") await leaveTerminalView(session, tab);
  else await enterTerminalView(session, tab);
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
