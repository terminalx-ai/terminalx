import { agent, api, type TabLayout } from "@/lib/api";
import type { SessionEntry } from "@/types/session";
import { getBrowserState, navigateBrowserPage, openBrowserTab, refreshBrowserPages } from "@/lib/browser";
import { getDraft } from "@/lib/drafts";
import { MODE_SET_IN_TERMINAL } from "@/lib/models";
import { getPrefs } from "@/lib/prefs";
import { addTab, getSessionStore, reopenTab, selectSession } from "@/lib/sessions";
import { activatePeer, endPeer, isShellPeer, noteClosed, openPeer, peerIsLive, peerPaneId, peerShell, peerStatus, sessionOfPeer, workspaceRow, type PeerTab, type TabRow } from "@/lib/sessionTabs";
import { isByHand } from "@/lib/tabFront";
import { closedTabsOf, dropClosedTab, forgetClosed, getTabState, moveKey, saveTabLayout, settleLayout, tabKey, type ClosedHere, type TabStore } from "@/lib/tabLayouts";
import { startTabAgent } from "@/lib/tabViews";
import { openTerminal, type SelectedSessionTab } from "@/lib/terminal";

export { workspaceRow, type TabRow };

/**
 * What can be done to the tabs of a workspace beyond opening and closing
 * one: moving, pinning, muting, renaming, duplicating, closing several, and
 * bringing a closed one back. The title bar strip, the sidebar's tab rows
 * and the tab shortcuts all act through these, on one row.
 */

/** The row again, after something changed it. */
function fresh(row: TabRow): TabRow {
  return workspaceRow(getSessionStore().sessions.find((session) => session.id === row.session.id) ?? row.session);
}

/**
 * Whether a key names a tab that is closed for good. An agent tab is, once no
 * session has it; a browser page, once the pages are loaded and it is not
 * among them. A shell is taken out when it is closed, and all of them when
 * the app starts: one this window has not listed yet is another window's.
 */
function isGone(key: string): boolean {
  const at = key.indexOf(":");
  const [kind, id] = [key.slice(0, at), key.slice(at + 1)];
  if (kind === "agent") return !getSessionStore().sessions.some((session) => session.tabs.some((tab) => tab.id === id));
  if (kind === "browser") return getBrowserState().loaded && !getBrowserState().pages.some((page) => page.id === id);
  return false;
}

/** Save the row's layout with `patch` applied and its tabs in the order `visible`. */
function arrange(row: TabRow, patch: Partial<TabLayout> = {}, visible: string[] = row.tabs.map((tab) => tab.key)) {
  saveTabLayout(row.workspace, settleLayout({ ...row.layout, ...patch }, visible, isGone));
}

// ---------------------------------------------------------------- order, pins, mutes, titles

/** The first and last places a tab may take: pinned tabs stay together at the left. */
function zone(row: TabRow, tab: PeerTab): { first: number; last: number } {
  const pins = row.tabs.filter((other) => other.pinned).length;
  return tab.pinned ? { first: 0, last: pins - 1 } : { first: pins, last: row.tabs.length - 1 };
}

/** Where `tab` would land if asked to go to `to`: the nearest place it may take. */
export function landingIndex(row: TabRow, tab: PeerTab, to: number): number {
  const { first, last } = zone(row, tab);
  return Math.max(first, Math.min(to, last));
}

/** Move a tab so that it ends up at index `to` of the row (or as near as a pinned boundary allows). */
export function moveTab(row: TabRow, tab: PeerTab, to: number) {
  const keys = row.tabs.map((other) => other.key);
  const from = keys.indexOf(tab.key);
  const target = landingIndex(row, tab, to);
  if (from < 0 || from === target) return;
  arrange(row, {}, moveKey(keys, tab.key, target));
}

export type TabMove = "left" | "right" | "start" | "end";

function moveTarget(row: TabRow, tab: PeerTab, move: TabMove): number {
  const from = row.tabs.findIndex((other) => other.key === tab.key);
  const { first, last } = zone(row, tab);
  return move === "left" ? from - 1 : move === "right" ? from + 1 : move === "start" ? first : last;
}

export function canMoveTab(row: TabRow, tab: PeerTab, move: TabMove): boolean {
  const from = row.tabs.findIndex((other) => other.key === tab.key);
  return from >= 0 && landingIndex(row, tab, moveTarget(row, tab, move)) !== from;
}

export function moveTabBy(row: TabRow, tab: PeerTab, move: TabMove) {
  moveTab(row, tab, moveTarget(row, tab, move));
}

/** Pin a tab (it joins the pinned tabs at the left, after the ones already there) or unpin it (it becomes the first of the rest). */
export function setTabPinned(row: TabRow, tab: PeerTab, pinned: boolean) {
  if (tab.pinned === pinned) return;
  const pins = row.tabs.filter((other) => other.pinned).length;
  const keys = moveKey(row.tabs.map((other) => other.key), tab.key, pinned ? pins : pins - 1);
  arrange(row, { pinned: pinned ? [...row.layout.pinned, tab.key] : row.layout.pinned.filter((key) => key !== tab.key) }, keys);
}

export function setTabMuted(row: TabRow, tab: PeerTab, muted: boolean) {
  const without = row.layout.muted.filter((key) => key !== tab.key);
  arrange(row, { muted: muted ? [...without, tab.key] : without });
}

/** Give a tab the reader's own title; `null` or blank takes it away again. */
export async function renamePeer(row: TabRow, tab: PeerTab, title: string | null) {
  const wanted = title?.trim() || null;
  const titles = { ...row.layout.titles };
  if (wanted) titles[tab.key] = wanted;
  else delete titles[tab.key];
  arrange(row, { titles });
  // An agent tab's title is also its own: the dashboard, notifications, the CLI and a phone list tabs by it.
  if (tab.kind === "agent") await api.renameTab(tab.sessionId, tab.id, wanted);
}

// ---------------------------------------------------------------- new tabs

export type NewTabKind = { kind: "agent"; harness: string; model?: string; effort?: string | null; mode: string } | { kind: "terminal" } | { kind: "browser"; url?: string | null };

/**
 * Open a tab in the workspace. With `after`, it is placed directly after
 * that tab and opened in that tab's session; otherwise it goes to the end of
 * the row, in the open session.
 */
export async function newTab(row: TabRow, what: NewTabKind, after?: PeerTab | null): Promise<string> {
  const sessionId = after ? sessionOfPeer(row.session.id, after) : row.session.id;
  const session = row.sessions.find((candidate) => candidate.id === sessionId) ?? row.session;
  // The new tab is the one on screen, so its session is too.
  if (getSessionStore().selectedSessionId !== session.id) selectSession(session.id);
  let key: string;
  if (what.kind === "agent") key = tabKey("agent", (await addTab(session.id, what.harness, what.model ?? "", what.effort ?? null, what.mode)).id);
  else if (what.kind === "terminal") key = tabKey("terminal", (await openTerminal(session.id, session.cwd)).id);
  else key = tabKey("browser", await openPage(session, what.url));
  if (after) {
    const now = fresh(row);
    const keys = now.tabs.map((tab) => tab.key).filter((other) => other !== key);
    const pins = now.tabs.filter((tab) => tab.pinned).length;
    const anchor = keys.indexOf(after.key);
    // After a pinned tab, the new one is the first of the tabs that are not pinned.
    keys.splice(Math.max(anchor + 1, pins), 0, key);
    arrange(now, {}, keys);
  }
  return key;
}

/** Open a page and wait until it is listed: its place in the row is written against the pages that exist. */
async function openPage(session: SessionEntry, url?: string | null): Promise<string> {
  const id = await openBrowserTab(session.id, session.cwd, url);
  if (!getBrowserState().pages.some((page) => page.id === id)) await refreshBrowserPages().catch(() => undefined);
  return id;
}

/**
 * A new tab of the same kind in the same folder, next to this one. An
 * agent's is a fresh conversation with the same provider and model; a tab
 * that is a terminal now (#437) gives a terminal.
 */
export function duplicateTab(row: TabRow, tab: PeerTab): Promise<string> {
  if (tab.kind === "browser") return newTab(row, { kind: "browser", url: tab.page.url }, tab);
  if (isShellPeer(tab) || tab.kind !== "agent") return newTab(row, { kind: "terminal" }, tab);
  // A mode that was set in the terminal is not one the app can start an agent in.
  const mode = tab.tab.permissionMode === MODE_SET_IN_TERMINAL ? getPrefs().lastMode : tab.tab.permissionMode;
  return newTab(row, { kind: "agent", harness: tab.tab.harness, model: tab.tab.model, effort: tab.tab.effort ?? null, mode }, tab);
}

/**
 * Whether the app can restart what runs in the tab: an agent it launched
 * itself. One the reader started by hand in the tab's terminal is theirs to
 * restart, and a tab that is a terminal has no agent (#437).
 */
export function canRestartAgent(tab: PeerTab): boolean {
  return tab.kind === "agent" && !isShellPeer(tab) && !isByHand(tab.tab);
}

/** Reload a page, restart an agent's CLI (its conversation resumes), or start an exited shell again in its tab. */
export async function restartTab(row: TabRow, tab: PeerTab) {
  if (tab.kind === "browser") {
    await navigateBrowserPage(tab.id, "reload");
    return;
  }
  const session = row.sessions.find((candidate) => candidate.id === tab.sessionId) ?? row.session;
  if (tab.kind === "agent") {
    if (!canRestartAgent(tab)) return;
    await agent.stop(session.id, tab.id);
    await startTabAgent(session, tab.tab);
    return;
  }
  // The pane is opened again under its own id: its place in the row is written down first, so it keeps it.
  arrange(row);
  await openTerminal(session.id, session.cwd, 100, 24, { id: tab.id, title: tab.pane.title });
}

// ---------------------------------------------------------------- closing several

export type BulkClose = "others" | "right" | "left" | "idle" | "all";

export const BULK_CLOSE_LABEL: Record<BulkClose, string> = {
  others: "Close other tabs",
  right: "Close tabs to the right",
  left: "Close tabs to the left",
  idle: "Close idle tabs",
  all: "Close all tabs",
};

/** Why closing a tab now would lose something. */
export interface BusyTab {
  tab: PeerTab;
  reasons: string[];
}

export interface ClosePlan {
  /** The tabs the action closes, in the row's order. Pinned tabs are not among them. */
  targets: PeerTab[];
  /** Pinned tabs the action would reach but leaves open, unless the reader includes them. */
  pinned: PeerTab[];
}

/**
 * The tabs a bulk close acts on, in the row as shown: every tab is a tab of
 * this workspace, so nothing else can be closed by it. `anchor` is the tab
 * the menu was opened on. "Idle" is a terminal that has exited or an agent
 * with nothing running; a tab is one or the other by what is in its terminal
 * now (#437).
 */
export function planBulkClose(action: BulkClose, tabs: readonly PeerTab[], anchor: PeerTab | null): ClosePlan {
  const at = anchor ? tabs.findIndex((tab) => tab.key === anchor.key) : -1;
  const reached = tabs.filter((tab, index) => {
    if (action === "all") return true;
    if (action === "idle") return isShellPeer(tab) ? !!peerShell(tab)?.exited : tab.kind === "agent" && !peerIsLive(tab);
    if (at < 0) return false;
    return action === "others" ? index !== at : action === "right" ? index > at : index < at;
  });
  return { targets: reached.filter((tab) => !tab.pinned), pinned: reached.filter((tab) => tab.pinned) };
}

/**
 * What these tabs have going on that closing them would end or lose: an
 * agent working or waiting for an answer, a shell running a command
 * (`running`: the pane ids the backend says are), a draft not sent.
 */
export function busyTabs(tabs: readonly PeerTab[], running: ReadonlySet<string> = new Set()): BusyTab[] {
  return tabs.flatMap((tab) => {
    const reasons: string[] = [];
    const status = peerStatus(tab);
    if (status === "in_progress") reasons.push("working");
    else if (status === "waiting") reasons.push("waiting for an answer");
    // A tab that is a terminal now is asked about like any shell, by its pane.
    if (isShellPeer(tab) && !peerShell(tab)?.exited && running.has(peerPaneId(tab) ?? "")) reasons.push("running a command");
    if (tab.kind === "agent" && getDraft(tab.id).trim()) reasons.push("unsent draft");
    return reasons.length ? [{ tab, reasons }] : [];
  });
}

/**
 * Close these tabs of the row through the same path as closing one. When the
 * tab on screen is among them, the nearest tab that stays takes its place.
 */
export async function closeTabs(row: TabRow, closing: readonly PeerTab[], selected: SelectedSessionTab | null) {
  if (!closing.length) return;
  const gone = new Set(closing.map((tab) => tab.key));
  const shown = row.tabs.findIndex((tab) => tab.kind === selected?.kind && tab.id === selected.id);
  const stays = (tab: PeerTab | undefined) => !!tab && !gone.has(tab.key);
  let next: PeerTab | undefined;
  if (shown >= 0 && gone.has(row.tabs[shown].key)) {
    next = row.tabs.slice(shown + 1).find(stays) ?? row.tabs.slice(0, shown).reverse().find(stays);
  }
  noteClosed(row.session.id, closing);
  // What takes the view is chosen before anything closes, so no tab that is about to go is shown on the way.
  if (next) openPeer(row.session.id, next);
  // Shells and pages first: a session whose last agent tab closes is given a tab to show, and must not be given one that is about to close.
  const ordered = [...closing].sort((a, b) => Number(a.kind === "agent") - Number(b.kind === "agent"));
  for (const tab of ordered) {
    await endPeer(row.session.id, tab).catch((error) => console.error("closing a tab failed", error));
  }
}

// ---------------------------------------------------------------- reopening

type Reopenable = { at: number; agent: { sessionId: string; tabId: string } } | { at: number; page: ClosedHere };

/** The tab "Reopen closed tab" brings back in this row: the last one closed, an agent tab or a browser page. */
function lastClosed(row: Pick<TabRow, "workspace" | "sessions">, tabs: TabStore): Reopenable | null {
  const sessionIds = row.sessions.map((session) => session.id);
  const candidates: Reopenable[] = [
    ...closedTabsOf(tabs, sessionIds).map((closed) => ({ at: Date.parse(closed.closedAt) || 0, agent: { sessionId: closed.sessionId, tabId: closed.tab.id } })),
    ...tabs.closedHere.filter((record) => record.workspace === row.workspace && record.page).map((record) => ({ at: record.at, page: record })),
  ];
  return candidates.reduce<Reopenable | null>((latest, candidate) => (!latest || candidate.at >= latest.at ? candidate : latest), null);
}

export function canReopenTab(row: Pick<TabRow, "workspace" | "sessions">, tabs: TabStore): boolean {
  return lastClosed(row, tabs) != null;
}

/** Put a reopened tab back where it stood, with its pin, mute and title, when this window is the one that closed it. */
function restorePlace(row: TabRow, key: string, was: ClosedHere | undefined) {
  if (!was) return;
  const now = fresh(row);
  const keys = now.tabs.map((tab) => tab.key).filter((other) => other !== key);
  const pins = now.tabs.filter((tab) => tab.pinned && tab.key !== key).length;
  const index = was.pinned ? Math.min(was.index, pins) : Math.max(was.index, pins);
  keys.splice(Math.min(index, keys.length), 0, key);
  const titles = { ...now.layout.titles };
  if (was.title) titles[key] = was.title;
  arrange(
    now,
    {
      pinned: was.pinned ? [...now.layout.pinned.filter((other) => other !== key), key] : now.layout.pinned,
      muted: was.muted ? [...now.layout.muted.filter((other) => other !== key), key] : now.layout.muted,
      titles,
    },
    keys,
  );
}

/** Reopen the last closed tab of the row: an agent tab with its conversation, or a page at its address. False when there is none. */
export async function reopenClosedTab(row: TabRow): Promise<boolean> {
  const tabs = getTabState();
  const last = lastClosed(row, tabs);
  if (!last) return false;
  if ("agent" in last) {
    const { sessionId, tabId } = last.agent;
    const key = tabKey("agent", tabId);
    const was = tabs.closedHere.find((record) => record.key === key);
    // Not offered again while the backend brings it back.
    dropClosedTab(sessionId, tabId);
    forgetClosed(key);
    await reopenTab(sessionId, tabId);
    if (getSessionStore().selectedSessionId !== sessionId) selectSession(sessionId);
    restorePlace(row, key, was);
    return true;
  }
  const was = last.page;
  forgetClosed(was.key);
  const key = tabKey("browser", await openPage(row.session, was.page!.url));
  restorePlace(row, key, { ...was, key });
  return true;
}

/** Show the tab at `position` of the row (1 is the first); nothing when there is no tab there. */
export function openTabAt(row: TabRow, position: number): boolean {
  const tab = row.tabs[position - 1];
  if (!tab) return false;
  openPeer(row.session.id, tab);
  return true;
}

/** Show the next or previous tab of the row, wrapping round. */
export function stepTab(row: TabRow, selected: SelectedSessionTab | null, direction: 1 | -1) {
  const { tabs } = row;
  if (tabs.length < 2) return;
  const current = tabs.findIndex((tab) => tab.kind === selected?.kind && tab.id === selected.id);
  const next = current < 0 ? (direction === 1 ? 0 : tabs.length - 1) : (current + direction + tabs.length) % tabs.length;
  const tab = tabs[next];
  // Inside one session this is what it always was; across sessions the session is selected with the tab.
  if (sessionOfPeer(row.session.id, tab) === row.session.id) activatePeer(row.session.id, tab);
  else openPeer(row.session.id, tab);
}
