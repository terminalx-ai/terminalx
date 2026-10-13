import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ClosedTab, type TabLayout, type TabState } from "@/lib/api";
import type { SessionEntry } from "@/types/session";

/**
 * How each workspace's tabs are arranged: their order, which are pinned or
 * muted, and the reader's own titles. One layout per workspace (a checkout),
 * across the sessions that run in it, kept by the backend in the session
 * index so every window and device has the same one.
 *
 * The backend is the source of truth. A change made here is shown at once
 * and sent; every window then hears the saved state back.
 */
export type TabKind = "agent" | "terminal" | "browser";

/** What a layout names a tab by. */
export function tabKey(kind: TabKind, id: string): string {
  return `${kind}:${id}`;
}

const canon = (path: string) => path.replace(/\/+$/, "");

/**
 * The workspace a session's tabs are listed with: its checkout, shared by
 * every session that runs there. A quick chat has no checkout of its own to
 * share, and a session whose worktree was removed is listed apart from the
 * sessions of the checkout it fell back to, as in the sidebar.
 */
export function workspaceKey(session: Pick<SessionEntry, "id" | "kind" | "cwd" | "worktreeRemoved" | "removedWorkspace">): string {
  if (session.kind === "quick") return `quick:${session.id}`;
  if (session.worktreeRemoved) return `removed:${canon(session.removedWorkspace?.path ?? session.cwd)}`;
  return canon(session.cwd);
}

/**
 * The sessions whose tabs are listed with `session`'s: the ones open in the
 * same workspace. `session` is always one of them, known to `sessions` or not:
 * a row never lacks the tabs of the session it is shown for.
 */
export function workspaceSessions(sessions: readonly SessionEntry[], session: SessionEntry): SessionEntry[] {
  const key = workspaceKey(session);
  const members = sessions.filter((other) => other.id === session.id || (!other.archived && workspaceKey(other) === key));
  return members.some((member) => member.id === session.id) ? members : [session, ...members];
}

export const NO_LAYOUT: TabLayout = { order: [], pinned: [], muted: [], titles: {} };

/**
 * A tab closed in this window, with where it was: enough to put it back in
 * its place. An agent tab's conversation is the backend's to keep
 * (`ClosedTab`); a browser page is reopened at its address.
 */
export interface ClosedHere {
  workspace: string;
  key: string;
  at: number;
  /** Where it stood in the workspace's row. */
  index: number;
  pinned: boolean;
  muted: boolean;
  title?: string;
  /** A browser page's address; a page belongs to its workspace, not to a session. */
  page?: { url: string; cwd: string };
}

/** The saved state, and what this window closed in this run of the app. */
export interface TabStore extends TabState {
  closedHere: ClosedHere[];
}

let state: TabStore = { workspaces: {}, closed: [], closedHere: [] };
const listeners = new Set<() => void>();
function set(patch: Partial<TabStore>) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTabState(): TabStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function getTabState(): TabStore {
  return state;
}

/** A workspace's layout; one nobody arranged is empty. */
export function layoutOf(tabs: TabState, workspace: string): TabLayout {
  const saved = tabs.workspaces[workspace];
  if (!saved) return NO_LAYOUT;
  return { order: saved.order ?? [], pinned: saved.pinned ?? [], muted: saved.muted ?? [], titles: saved.titles ?? {} };
}

const names = (layout: TabLayout, key: string) => layout.order.includes(key) || layout.pinned.includes(key) || layout.muted.includes(key) || key in layout.titles;

/**
 * A layout as it stands for these sessions. A shell an agent was started in
 * is that agent's tab from then on, under the tab's id (#437): what the
 * layout says of the shell (its place, a pin, a mute, the reader's title) is
 * said of the tab. The backend rewrites the saved layout the same way; this
 * is for the moment before a window hears of it, so the tab never leaves its
 * place on the way.
 */
export function followedLayout(layout: TabLayout, sessions: readonly Pick<SessionEntry, "tabs">[]): TabLayout {
  const became = new Map<string, string>();
  for (const session of sessions) {
    for (const tab of session.tabs) {
      const shell = tab.pane ? tabKey("terminal", tab.pane) : null;
      if (shell && names(layout, shell)) became.set(shell, tabKey("agent", tab.id));
    }
  }
  if (!became.size) return layout;
  // A layout that already names the tab keeps what it says of it.
  const renamed = (keys: readonly string[]) => keys.flatMap((key) => (!became.has(key) ? [key] : keys.includes(became.get(key)!) ? [] : [became.get(key)!]));
  const titles: Record<string, string> = {};
  for (const [key, title] of Object.entries(layout.titles)) if (!became.has(key)) titles[key] = title;
  for (const [key, title] of Object.entries(layout.titles)) if (became.has(key)) titles[became.get(key)!] ??= title;
  return { order: renamed(layout.order), pinned: renamed(layout.pinned), muted: renamed(layout.muted), titles };
}

function receive(next: TabState | null | undefined) {
  set({ workspaces: next?.workspaces ?? {}, closed: next?.closed ?? [] });
}

let booted: Promise<void> | null = null;
export function bootTabLayouts(): Promise<void> {
  return (booted ??= boot());
}

async function boot() {
  try {
    await listen<TabState>("tab_state_changed", (event) => receive(event.payload));
  } catch {
    /* outside a webview */
  }
  try {
    receive(await api.tabState());
  } catch {
    /* outside a webview, or a backend that keeps no layouts: tabs stay in the order they were opened */
  }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, i) => value === b[i]);

function sameLayout(a: TabLayout, b: TabLayout): boolean {
  const titles = Object.keys(a.titles);
  return sameList(a.order, b.order) && sameList(a.pinned, b.pinned) && sameList(a.muted, b.muted) && titles.length === Object.keys(b.titles).length && titles.every((key) => a.titles[key] === b.titles[key]);
}

/** Save a workspace's layout: shown at once here, then kept for every window and device. */
export function saveTabLayout(workspace: string, layout: TabLayout) {
  if (sameLayout(layoutOf(state, workspace), layout)) return;
  set({ workspaces: { ...state.workspaces, [workspace]: layout } });
  void api.setTabLayout(workspace, layout).catch((error) => {
    console.error("saving the tab layout failed", error);
    // What is shown must be what is saved.
    void api.tabState().then(receive, () => undefined);
  });
}

// ---------------------------------------------------------------- order

/**
 * Tabs in the order a layout gives them: pinned ones first, then the saved
 * order, then tabs the layout has not seen (opened since) in the order they
 * were opened.
 */
export function sortByLayout<T extends { key: string; created: string }>(tabs: readonly T[], layout: TabLayout): T[] {
  const rank = new Map(layout.order.map((key, at) => [key, at]));
  const pinned = new Set(layout.pinned);
  const place = (tab: T) => rank.get(tab.key) ?? Number.MAX_SAFE_INTEGER;
  return tabs
    .map((tab, at) => ({ tab, at }))
    .sort((a, b) => Number(pinned.has(b.tab.key)) - Number(pinned.has(a.tab.key)) || place(a.tab) - place(b.tab) || a.tab.created.localeCompare(b.tab.created) || a.at - b.at)
    .map((entry) => entry.tab);
}

/** `keys` with `key` moved so that it ends up at index `to`. */
export function moveKey(keys: readonly string[], key: string, to: number): string[] {
  const rest = keys.filter((other) => other !== key);
  if (rest.length === keys.length) return [...keys];
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, key);
  return rest;
}

/**
 * The order to save when the tabs on screen are now `visible`. A key the
 * saved order has that is not on screen (a tab this window has not listed
 * yet) keeps its place after the tab it followed, so it is where it was when
 * it shows up.
 */
export function mergeOrder(saved: readonly string[], visible: readonly string[]): string[] {
  const out = [...visible];
  const shown = new Set(visible);
  let after: string | null = null;
  for (const key of saved) {
    if (!shown.has(key)) {
      out.splice(after == null ? 0 : out.indexOf(after) + 1, 0, key);
      shown.add(key);
    }
    after = key;
  }
  return out;
}

/** A layout with every trace of the keys `gone` says are closed for good taken out, in the order `visible` gives. */
export function settleLayout(layout: TabLayout, visible: readonly string[], gone: (key: string) => boolean): TabLayout {
  const kept = (key: string) => !gone(key);
  return {
    order: mergeOrder(layout.order.filter(kept), visible),
    pinned: layout.pinned.filter(kept),
    muted: layout.muted.filter(kept),
    titles: Object.fromEntries(Object.entries(layout.titles).filter(([key]) => kept(key))),
  };
}

/** True when this agent tab raises nothing: the reader muted it. */
export function isTabMuted(session: SessionEntry, tabId: string): boolean {
  return followedLayout(layoutOf(state, workspaceKey(session)), [session]).muted.includes(tabKey("agent", tabId));
}

// ---------------------------------------------------------------- closed tabs

const CLOSED_HERE_KEPT = 25;

export function rememberClosed(record: ClosedHere) {
  set({ closedHere: [...state.closedHere.filter((other) => other.key !== record.key), record].slice(-CLOSED_HERE_KEPT) });
}

export function forgetClosed(key: string) {
  if (state.closedHere.some((record) => record.key === key)) set({ closedHere: state.closedHere.filter((record) => record.key !== key) });
}

/** A closed tab is on its way back: it is not offered again while the backend restores it. */
export function dropClosedTab(sessionId: string, tabId: string) {
  set({ closed: state.closed.filter((closed) => !(closed.sessionId === sessionId && closed.tab.id === tabId)) });
}

/** The closed agent tabs of these sessions, as the backend keeps them. */
export function closedTabsOf(tabs: TabState, sessionIds: readonly string[]): ClosedTab[] {
  return tabs.closed.filter((closed) => sessionIds.includes(closed.sessionId));
}

/** Tests only. */
export function resetTabLayouts(next: TabState = { workspaces: {}, closed: [] }) {
  set({ ...next, closedHere: [] });
}

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
