import { useMemo } from "react";
import { activateBrowserPage, closeBrowserPage, getBrowserState, pagesFor, useBrowser } from "@/lib/browser";
import type { BrowserPage, TabLayout } from "@/lib/api";
import { getSessionStore, removeTab, selectSession, setActiveTab, useSessionStore } from "@/lib/sessions";
import { followedSelection, isTerminalTab, tabLabel, tabPaneId } from "@/lib/tabFront";
import { closeTerminal, getTerminalState, setActiveTerminal, useTerminals, type SelectedSessionTab, type TerminalPane } from "@/lib/terminal";
import { NO_LAYOUT, followedLayout, getTabState, layoutOf, rememberClosed, saveTabLayout, settleLayout, sortByLayout, tabKey, useTabState, workspaceKey, workspaceSessions } from "@/lib/tabLayouts";
import type { SessionEntry, TabEntry, TabStatus } from "@/types/session";

interface PeerBase {
  id: string;
  created: string;
  /** What a tab layout names the tab by (`tabKey`). */
  key: string;
  /** Kept at the left of its workspace's row. */
  pinned: boolean;
}

/**
 * One tab of a workspace. An agent tab and a shell belong to a session; a
 * browser page belongs to the workspace, and is shown in whichever of its
 * sessions is open.
 *
 * A tab follows what runs in its terminal (#437). `agent` is a tab the
 * session lists, the same tab throughout: an agent's while one runs in it,
 * and a terminal while none does (`isShellPeer`). `terminal` is a shell that
 * no agent with a chat was ever started in. `paneAgent` is the agent in
 * front of the tab's terminal right now, by harness id, and `pane` an agent
 * tab's terminal when this window has it.
 */
export type PeerTab =
  | (PeerBase & { kind: "agent"; sessionId: string; tab: TabEntry; pane: TerminalPane | null; paneAgent: string | null })
  | (PeerBase & { kind: "terminal"; sessionId: string; pane: TerminalPane; paneAgent: string | null })
  | (PeerBase & { kind: "browser"; sessionId: null; page: BrowserPage });

/**
 * Every tab of a workspace in one row: the agent tabs and shells of the
 * sessions open in it and its browser pages, in the order its layout gives
 * (the order they were opened in until the reader moves one). The title bar
 * strip, the sidebar, the tab shortcuts and the bulk closes all list tabs
 * from this, so they cannot disagree, and a tab of another workspace is
 * never in it: only `sessions` are read.
 *
 * A shell an agent was started in is that agent's tab from then on (#437),
 * listed once, where the shell stood: the session's own entry for it carries
 * the time the shell was opened, and `layout` is read as saying of the tab
 * what it said of the shell. `agents` is the agent in front of each pane.
 */
export function workspaceTabs(
  sessions: readonly SessionEntry[],
  panes: readonly TerminalPane[],
  pages: readonly BrowserPage[] = [],
  saved: TabLayout = NO_LAYOUT,
  agents: Readonly<Record<string, string>> = {},
): PeerTab[] {
  const layout = followedLayout(saved, sessions);
  const ids = new Set(sessions.map((session) => session.id));
  const taken = new Set(sessions.flatMap((session) => session.tabs.map((tab) => tab.pane).filter(Boolean)));
  const pinned = new Set(layout.pinned);
  const peer = <T extends { kind: PeerTab["kind"]; id: string }>(tab: T) => {
    const key = tabKey(tab.kind, tab.id);
    return { ...tab, key, pinned: pinned.has(key) };
  };
  const tabs: PeerTab[] = [
    ...sessions.flatMap((session) =>
      session.tabs.map((tab): PeerTab => {
        const paneId = tabPaneId(tab);
        return peer({ kind: "agent", id: tab.id, created: tab.created, sessionId: session.id, tab, pane: panes.find((pane) => pane.id === paneId) ?? null, paneAgent: agents[paneId] ?? null });
      }),
    ),
    ...panes
      .filter((pane) => ids.has(pane.sessionId) && !pane.hidden && !taken.has(pane.id))
      .map((pane): PeerTab => peer({ kind: "terminal", id: pane.id, created: pane.created, sessionId: pane.sessionId, pane, paneAgent: agents[pane.id] ?? null })),
    ...pages.map((page): PeerTab => peer({ kind: "browser", id: page.id, created: page.created, sessionId: null, page })),
  ];
  return sortByLayout(tabs, layout);
}

/** A workspace's row of tabs, and the session of it that is open. */
export interface TabRow {
  /** The open session: where a browser page is shown, and whose workspace this is. */
  session: SessionEntry;
  /** The sessions whose tabs are in the row. */
  sessions: SessionEntry[];
  workspace: string;
  /** The workspace's layout, saying of a tab what it said of the shell the tab was (`followedLayout`). */
  layout: TabLayout;
  tabs: PeerTab[];
}

function rowOf(session: SessionEntry, all: readonly SessionEntry[], saved: TabLayout, panes: readonly TerminalPane[], agents: Readonly<Record<string, string>>, pages: BrowserPage[]): TabRow {
  const sessions = workspaceSessions(all, session);
  const layout = followedLayout(saved, sessions);
  return { session, sessions, workspace: workspaceKey(session), layout, tabs: workspaceTabs(sessions, panes, pagesFor(pages, session.cwd), layout, agents) };
}

/** A session's workspace row as the stores have it now, outside React. */
export function workspaceRow(session: SessionEntry): TabRow {
  const { panes, agents } = getTerminalState();
  return rowOf(session, getSessionStore().sessions, layoutOf(getTabState(), workspaceKey(session)), panes, agents, getBrowserState().pages);
}

/** A session's workspace row, kept up to date: what the strip, the tab shortcuts and the tab menus all act on. */
export function useTabRow(session: SessionEntry): TabRow {
  const sessions = useSessionStore().sessions;
  const { panes, agents } = useTerminals();
  // The store's state, not its list of pages: a new state is what says the pages changed.
  const browser = useBrowser();
  const saved = useTabState();
  return useMemo(() => rowOf(session, sessions, layoutOf(saved, workspaceKey(session)), panes, agents, browser.pages), [session, sessions, panes, agents, browser, saved]);
}

/** One session's tabs, in the order its workspace's layout gives them. */
export function peerOrder(session: SessionEntry, panes: readonly TerminalPane[], pages: readonly BrowserPage[] = [], layout: TabLayout = NO_LAYOUT, agents: Readonly<Record<string, string>> = {}): PeerTab[] {
  return workspaceTabs([session], panes, pages, layout, agents);
}

export function selectedPeer(session: SessionEntry, tabs: PeerTab[], asked?: SelectedSessionTab): PeerTab | undefined {
  const requested = followedSelection(session, asked);
  return tabs.find((tab) => tab.kind === requested?.kind && tab.id === requested.id)
    ?? tabs.find((tab) => tab.kind === "agent" && tab.id === session.activeTab)
    ?? tabs.find((tab) => tab.kind === "agent")
    ?? tabs[0];
}

export function tabNodeId(tab: SelectedSessionTab) {
  return `session-${tab.kind}-tab-${encodeURIComponent(tab.id)}`;
}

export function tabPanelId(tab: SelectedSessionTab) {
  return `session-${tab.kind}-panel-${encodeURIComponent(tab.id)}`;
}

export function activatePeer(sessionId: string, tab: SelectedSessionTab) {
  if (tab.kind === "agent") void setActiveTab(sessionId, tab.id);
  else if (tab.kind === "browser") void activateBrowserPage(sessionId, tab.id);
  else setActiveTerminal(sessionId, tab.id);
}

/** The session a tab is shown in: its own, or the open one (`sessionId`) for a workspace's browser page. */
export function sessionOfPeer(sessionId: string, tab: PeerTab): string {
  return tab.sessionId ?? sessionId;
}

/**
 * Show a tab of the workspace, from the session `sessionId` that is open.
 * Selecting a tab selects its session too, so the breadcrumb, the right
 * panel and the session's actions always describe the tab on screen.
 */
export function openPeer(sessionId: string, tab: PeerTab) {
  const target = sessionOfPeer(sessionId, tab);
  if (getSessionStore().selectedSessionId !== target) selectSession(target);
  activatePeer(target, tab);
}

/** Stop a tab and take it out of its session. An agent tab's conversation stays and can be reopened. */
export async function endPeer(sessionId: string, tab: PeerTab) {
  if (tab.kind === "agent") await removeTab(tab.sessionId, tab.id);
  else if (tab.kind === "browser") await closeBrowserPage(sessionId, tab.id);
  else await closeTerminal(tab.id);
}

/**
 * What closing these tabs leaves behind for "Reopen closed tab" (where each
 * stood in its workspace's row, and a page's address), and their traces
 * taken out of the layout. `sessionId` is a session of that workspace.
 */
export function noteClosed(sessionId: string, closing: readonly PeerTab[]) {
  const session = getSessionStore().sessions.find((candidate) => candidate.id === sessionId);
  if (!session || !closing.length) return;
  const { workspace, layout, tabs } = workspaceRow(session);
  const gone = new Set(closing.map((tab) => tab.key));
  const at = Date.now();
  closing.forEach((tab, order) => {
    // A shell's process ends with its tab: there is nothing of it to bring back.
    if (tab.kind === "terminal") return;
    rememberClosed({
      workspace,
      key: tab.key,
      // Closed together, the later one in the row is reopened first.
      at: at + order,
      index: Math.max(0, tabs.findIndex((candidate) => candidate.key === tab.key)),
      pinned: layout.pinned.includes(tab.key),
      muted: layout.muted.includes(tab.key),
      title: layout.titles[tab.key],
      page: tab.kind === "browser" ? { url: tab.page.url, cwd: session.cwd } : undefined,
    });
  });
  const mentions = (key: string) => layout.order.includes(key) || layout.pinned.includes(key) || layout.muted.includes(key) || key in layout.titles;
  if (![...gone].some(mentions)) return;
  saveTabLayout(workspace, settleLayout(layout, tabs.filter((tab) => !gone.has(tab.key)).map((tab) => tab.key), (key) => gone.has(key)));
}

/**
 * Close one tab of `tabs`, the row it is listed in, from the session
 * `sessionId` that row belongs to (the open session, for a workspace's row).
 * When it was the tab on screen (`selected`), its neighbour takes its place:
 * before the tab goes, so the view never falls back to a tab nobody chose.
 */
export async function closePeer(sessionId: string, tab: PeerTab, tabs: PeerTab[], selected?: SelectedSessionTab | null) {
  const index = tabs.findIndex((candidate) => candidate.kind === tab.kind && candidate.id === tab.id);
  const remaining = tabs.filter((_, i) => i !== index);
  const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
  noteClosed(sessionId, [tab]);
  if (selected?.kind === tab.kind && selected.id === tab.id && next) {
    const target = sessionOfPeer(sessionId, next);
    // The neighbour may be another session's tab: the view follows it there, but only when this session is the one on screen.
    if (target !== sessionId && getSessionStore().selectedSessionId === sessionId) selectSession(target);
    activatePeer(target, next);
  }
  await endPeer(sessionId, tab);
}

/** A page's label for the sidebar and tab strip: its title, else its host. */
export function browserPageLabel(page: Pick<BrowserPage, "title" | "url">): string {
  const title = page.title.trim();
  if (title && title !== "about:blank") return title;
  if (!page.url || page.url === "about:blank") return "New tab";
  try {
    const parsed = new URL(page.url);
    return parsed.protocol === "file:" ? parsed.pathname.split("/").pop() || page.url : parsed.host || page.url;
  } catch {
    return page.url;
  }
}

/** True for a tab that is a terminal now: a shell, or a session's tab with no agent in it (#437). */
export function isShellPeer(tab: PeerTab): boolean {
  return tab.kind === "terminal" || (tab.kind === "agent" && isTerminalTab(tab.tab));
}

/**
 * The agent a tab is drawn as, by harness id: the tab's own while it runs
 * there, else the one in front of its terminal (one the app has no chat
 * for). None for a plain terminal and for a page.
 */
export function peerAgent(tab: PeerTab): string | null {
  if (tab.kind === "browser") return null;
  return tab.kind === "agent" && !isTerminalTab(tab.tab) ? tab.tab.harness : tab.paneAgent;
}

/** The pane of the tab's terminal; none for a page. */
export function peerPaneId(tab: PeerTab): string | null {
  return tab.kind === "agent" ? tabPaneId(tab.tab) : tab.kind === "terminal" ? tab.id : null;
}

/** The shell of a tab that is a terminal now, when this window has it. */
export function peerShell(tab: PeerTab): TerminalPane | null {
  return isShellPeer(tab) && tab.kind !== "browser" ? tab.pane : null;
}

/** True when the reader gave the tab a title of their own. */
export function hasOwnTitle(tab: PeerTab, layout: TabLayout): boolean {
  return !!layout.titles[tab.key]?.trim() || (tab.kind === "agent" && !!tab.tab.titlePinned && !!tab.tab.title?.trim());
}

/**
 * The name a tab goes by wherever it is listed: the reader's own title when
 * they gave it one; else what it is called for what runs in it (`tabLabel`):
 * an agent tab's conversation title or its agent's name, a terminal's name,
 * a page's title.
 */
export function peerLabel(tab: PeerTab, layout: TabLayout, harnessName: (id: string) => string | undefined): string {
  const own = layout.titles[tab.key]?.trim();
  if (own) return own;
  if (tab.kind === "agent") return tabLabel(tab.tab, (id) => harnessName(id) || id, tab.paneAgent);
  if (tab.kind === "terminal") return tab.pane.title;
  return browserPageLabel(tab.page);
}

/** What kind of tab it is now: its agent's name, "Terminal" (with the agent running in it, if one is) or "Browser page". */
export function peerKind(tab: PeerTab, harnessName: (id: string) => string | undefined): string {
  if (tab.kind === "browser") return "Browser page";
  const agent = peerAgent(tab);
  const name = agent ? harnessName(agent) || agent : null;
  if (!isShellPeer(tab)) return name ?? "Agent";
  return name ? `${name}, running in a terminal` : "Terminal";
}

const STATUS_WORDS: Record<TabStatus, string | null> = {
  idle: null,
  in_progress: "working",
  waiting: "waiting for an answer",
  completed: "unread reply",
};

/** An agent tab's status while an agent is in it; a tab that is a terminal has none. */
export function peerStatus(tab: PeerTab): TabStatus | null {
  return tab.kind === "agent" && !isTerminalTab(tab.tab) ? tab.tab.status : null;
}

/**
 * A tab's state in words, for its tooltip: "working", "waiting for an
 * answer", "needs attention" (`attention`: it stopped on a problem, not on a
 * question), "unread reply", "exited". Null when there is nothing to say.
 */
export function peerStateWords(tab: PeerTab, attention = false): string | null {
  const status = peerStatus(tab);
  if (status) return status === "waiting" && attention ? "needs attention" : STATUS_WORDS[status];
  const shell = peerShell(tab);
  return shell?.exited ? (shell.exitCode != null ? `exited (${shell.exitCode})` : "exited") : null;
}

/** True for a tab with something going on that a close would end: a turn in flight, or a question waiting. */
export function peerIsLive(tab: PeerTab): boolean {
  const status = peerStatus(tab);
  return status === "in_progress" || status === "waiting";
}
