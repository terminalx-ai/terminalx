import { useSyncExternalStore } from "react";
import { agent, errorMessage, type HandoffInfo } from "@/lib/api";
import { closeTerminal, openTerminal } from "@/lib/terminal";
import { reloadTab } from "@/lib/agentEvents";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * Which face a tab shows: the transcript, or the agent's own CLI in a
 * terminal running the same conversation. Only one of the two runs at a time,
 * so switching is a hand-off, not a mirror. The terminal pane id is derived
 * from the tab id so both sides can find it.
 */
export type TabViewMode = "chat" | "terminal";

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

/** Stop the headless agent and open its CLI in a terminal for this tab. */
export async function enterTerminalView(session: SessionEntry, tab: TabEntry) {
  if (state.switching[tab.id] || tabViewOf(tab.id) === "terminal") return;
  set({ switching: { ...state.switching, [tab.id]: true }, errors: { ...state.errors, [tab.id]: null } });
  try {
    const info = await agent.tabHandoff(session.id, tab.id);
    await openTerminal(session.id, session.cwd, 100, 24, { id: terminalPaneId(tab.id), title: tab.title ?? tab.harness, command: info.command, hidden: true });
    set({ views: { ...state.views, [tab.id]: "terminal" }, info: { ...state.info, [tab.id]: info } });
  } catch (e) {
    set({ errors: { ...state.errors, [tab.id]: errorMessage(e) } });
  } finally {
    set({ switching: { ...state.switching, [tab.id]: false } });
  }
}

/** Close the terminal, fold what was said there into the log, show the chat. */
export async function leaveTerminalView(session: SessionEntry, tab: TabEntry) {
  if (tabViewOf(tab.id) !== "terminal") return;
  set({ switching: { ...state.switching, [tab.id]: true } });
  try {
    await closeTerminal(terminalPaneId(tab.id));
    await agent.tabReconcile(session.id, tab.id).catch(() => 0);
    await reloadTab(session.id, tab.id);
  } finally {
    const views = { ...state.views };
    delete views[tab.id];
    const info = { ...state.info };
    delete info[tab.id];
    set({ views, info, switching: { ...state.switching, [tab.id]: false } });
  }
}

export async function toggleTabView(session: SessionEntry, tab: TabEntry) {
  if (tabViewOf(tab.id) === "terminal") await leaveTerminalView(session, tab);
  else await enterTerminalView(session, tab);
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
