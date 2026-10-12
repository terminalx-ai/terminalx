import type { SelectedSessionTab } from "@/lib/terminal";
import type { PastConversation, SessionEntry, TabEntry } from "@/types/session";

/**
 * A tab follows what runs in its terminal (#437): the same tab is an agent's
 * while that agent runs there and a plain terminal when it does not. These
 * are the questions the views ask of a tab about that, in one place.
 */

/** No agent is in the tab's terminal: it is a shell. */
export function isTerminalTab(tab: Pick<TabEntry, "front">): boolean {
  return tab.front === "terminal";
}

/** The agent in the tab was started by hand in its terminal; the app follows it and never restarts it. */
export function isByHand(tab: Pick<TabEntry, "front">): boolean {
  return tab.front === "by_hand";
}

/** Which face a tab shows: its transcript, or its terminal. */
export type TabViewMode = "chat" | "terminal";

/**
 * The face a tab shows when the reader has not picked one. A tab whose agent
 * the app runs opens on its chat. One whose agent the reader started by hand
 * opens on the terminal they started it in, and a tab that is a terminal
 * shows the terminal.
 */
export function defaultTabView(tab: Pick<TabEntry, "front">): TabViewMode {
  return isTerminalTab(tab) || isByHand(tab) ? "terminal" : "chat";
}

/** The face a tab shows: the one picked for it, else the one that goes with what is in its terminal. */
export function tabViewIn(views: Record<string, TabViewMode>, tab: Pick<TabEntry, "id" | "front">): TabViewMode {
  return views[tab.id] ?? defaultTabView(tab);
}

/** The terminal pane the tab lives in: its own, unless it took over a shell's. */
export function tabPaneId(tab: Pick<TabEntry, "id" | "pane">): string {
  return tab.pane || `tab:${tab.id}`;
}

/**
 * What a tab is called. A name the reader gave it is its name whatever runs
 * in it. Otherwise an agent's tab goes by its conversation, or the agent; a
 * terminal goes by the name it has as one, or by the agent in front of it
 * when that is one the app has no chat for.
 */
export function tabLabel(tab: TabEntry, agentName: (harness: string) => string, paneAgent?: string | null): string {
  const own = tab.title?.trim();
  if (tab.titlePinned && own) return own;
  if (isTerminalTab(tab)) return paneAgent ? agentName(paneAgent) : tab.terminalTitle?.trim() || "Terminal";
  return own || agentName(tab.harness);
}

/**
 * A selection as it stands now. A shell an agent was started in becomes that
 * agent's tab, under the tab's id: a window that had the shell selected has
 * that tab selected.
 */
export function followedSelection(session: Pick<SessionEntry, "tabs">, selected: SelectedSessionTab | null | undefined): SelectedSessionTab | undefined {
  if (!selected) return undefined;
  if (selected.kind !== "terminal") return selected;
  const tab = session.tabs.find((candidate) => candidate.pane === selected.id);
  return tab ? { kind: "agent", id: tab.id } : selected;
}

/** The agents whose CLI takes a model or an effort only when it is started. */
const RESTARTS_FOR_MODEL = new Set(["codex"]);

/**
 * Why a setting cannot be changed from the chat for an agent that was
 * started by hand, or `null` when it can. The app changes these by starting
 * the CLI again, which it only does for a CLI it launched itself.
 */
export function byHandLock(tab: TabEntry, agentName: string): { model: string | null; mode: string | null } {
  if (!isByHand(tab)) return { model: null, mode: null };
  const why = (what: string) =>
    `${agentName} was started by hand in this tab's terminal, so TerminalX cannot restart it to change ${what}. Change it in the terminal, or exit ${agentName} there and resume the conversation from the chat.`;
  return { model: RESTARTS_FOR_MODEL.has(tab.harness) ? why("the model or effort") : null, mode: why("the permission mode") };
}

/** A conversation of a tab that the app can start again: it has the agent's own id for it. */
export interface Resumable {
  harness: string;
  providerSessionId: string;
}

export function resumable(conversation: Pick<TabEntry | PastConversation, "harness" | "providerSessionId">): Resumable | null {
  return conversation.providerSessionId ? { harness: conversation.harness, providerSessionId: conversation.providerSessionId } : null;
}
