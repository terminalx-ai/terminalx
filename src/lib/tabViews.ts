import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { agent, errorMessage, type HandoffInfo, type TabPtyEvent } from "@/lib/api";
import { defaultTabView, tabPaneId, tabViewIn, type TabViewMode } from "@/lib/tabFront";
import { adoptPane, closeTerminal, ensureTerminalAttached, followShellToTab, openTerminal } from "@/lib/terminal";
import { getSessionStore } from "@/lib/sessions";
import type { SessionEntry, TabEntry } from "@/types/session";
import { getTheme } from "@/lib/theme";

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
 * Those agents are no longer offered for new tabs — the decision lives in
 * `HIDDEN_HARNESSES` in src-tauri/src/harness/mod.rs — so this branch serves
 * only the tabs that were made before, which still open and run.
 *
 * A cloud tab (`remote`, PRO-86) only flips the flag: its CLI runs on the VM
 * and its terminal view attaches to it there, so nothing local is started,
 * adopted or closed, and looking never wakes or starts anything.
 *
 * A tab follows what runs in its terminal (#437), and so does the face it
 * shows when the reader has not picked one. A tab whose agent the app runs
 * opens on its chat. One whose agent the reader started by hand opens on the
 * terminal they started it in, with the chat one switch away. A tab that is
 * a terminal shows the terminal; its chat is then the conversation it last
 * held, to read and to resume, not a live one.
 */
export type { TabViewMode };

/** Agents whose tab is the CLI itself. */
export function isPtyFirst(harness: string): boolean {
  return harness === "claude" || harness === "codex";
}

interface State {
  views: Record<string, TabViewMode>;
  info: Record<string, HandoffInfo>;
  errors: Record<string, string | null>;
  switching: Record<string, boolean>;
  waiting: Record<string, boolean>;
}

let state: State = { views: {}, info: {}, errors: {}, switching: {}, waiting: {} };
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

// Only active work/cache entries have a lifetime. Removal deletes the entry,
// rather than keeping an ever-growing set of closed tab IDs. A reopened tab
// receives a different token, so its predecessor cannot overwrite its state.
const lifetimes = new Map<string, object>();
function lifetime(tabId: string) {
  let token = lifetimes.get(tabId);
  if (!token) lifetimes.set(tabId, token = {});
  return token;
}
const current = (tabId: string, token: object) => lifetimes.get(tabId) === token;

// Tabs this window saw leave the session index: a late event or reply for one
// is stale and must not put its metadata back. A tab the window has not seen
// yet is not stale. The backend announces the pane of an agent started by hand
// in a shell before the session update that lists its tab (#437). A reopened
// tab keeps its ID and counts again once the index lists it. Only recent
// removals are kept: stale replies arrive within moments, and a long session
// should not collect the ID of every tab it closed.
const REMEMBERED_REMOVALS = 256;
const removedTabs = new Set<string>();
function removedHere(tabId: string) {
  if (!removedTabs.has(tabId)) return false;
  if (!getSessionStore().sessions.some((session) => session.tabs.some((tab) => tab.id === tabId))) return true;
  removedTabs.delete(tabId);
  return false;
}

/** Active tabs disappeared from the index; their on-disk history is untouched. */
export function forgetClosedTabViews(tabIds: readonly string[]) {
  const views = { ...state.views }, info = { ...state.info };
  const errors = { ...state.errors }, switching = { ...state.switching }, waiting = { ...state.waiting };
  for (const id of tabIds) {
    removedTabs.delete(id);
    removedTabs.add(id);
    cancelTerminalView(id);
    lifetimes.delete(id);
    starting.delete(id);
    delete views[id]; delete info[id]; delete errors[id]; delete switching[id]; delete waiting[id];
  }
  for (const oldest of removedTabs) {
    if (removedTabs.size <= REMEMBERED_REMOVALS) break;
    removedTabs.delete(oldest);
  }
  set({ views, info, errors, switching, waiting });
}

/** The pane a tab's terminal view shows: its own, or the shell's it took over. */
export function terminalPaneId(tab: Pick<TabEntry, "id" | "pane">): string {
  return tabPaneId(tab);
}

export function tabViewOf(tab: Pick<TabEntry, "id" | "front">): TabViewMode {
  return tabViewIn(state.views, tab);
}

/**
 * What is in the tab's terminal changed (an agent started, or exited): the
 * face picked for what was there before no longer stands, and the tab shows
 * the one that goes with what is there now.
 */
export function forgetTabView(tabId: string) {
  if (!(tabId in state.views)) return;
  const views = { ...state.views };
  delete views[tabId];
  set({ views });
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
      const { sessionId, tabId, paneId, command, harness } = e.payload;
      if (removedHere(tabId)) return;
      const token = lifetime(tabId);
      // A shell an agent was started in is that agent's tab from here on, not a shell tab beside it.
      followShellToTab(sessionId, paneId, tabId);
      void adoptPane({ id: paneId, sessionId, title: "Agent", hidden: true, owned: true }, () => current(tabId, token));
      set({ info: { ...state.info, [tabId]: { command, harness } } });
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
const starting = new Map<string, { run: Promise<boolean>; opened: boolean }>();

/**
 * `opened`: the tab is only being shown, in its chat. An agent nobody is about to use is then left for its next message
 * to start (`agent.startOnOpen`, #696); the terminal view, a restart and "New shell" start it whatever it is.
 */
export async function startTabAgent(session: SessionEntry, tab: TabEntry, how: { opened?: boolean } = {}) {
  if (!isPtyFirst(tab.harness) || removedHere(tab.id)) return false;
  const opened = how.opened === true;
  const key = tab.id;
  const token = lifetime(tab.id);
  const inflight = starting.get(key);
  // One under way answers for another like it, and for a mere showing. A start asked for while only a showing is under
  // way goes after it: the showing may have left the agent stopped.
  if (inflight && (opened || !inflight.opened)) return inflight.run;
  const before = inflight?.run;
  const run = (async () => {
    await before;
    await subscribeTabPty();
    if (!current(tab.id, token)) return false;
    try {
      await (opened ? agent.startOnOpen(session.id, tab.id) : agent.ensureStarted(session.id, tab.id));
      if (!current(tab.id, token)) return false;
      await adoptTabPane(session.id, tab.id, token);
      if (current(tab.id, token)) clearTabViewError(tab.id);
      return true;
    } catch (e) {
      if (current(tab.id, token)) set({ errors: { ...state.errors, [tab.id]: errorMessage(e) } });
      return false;
    }
  })().finally(() => { if (starting.get(key)?.run === run) starting.delete(key); });
  starting.set(key, { run, opened });
  return run;
}

/** Take over the pane a tab's CLI is already running in, if there is one. */
async function adoptTabPane(sessionId: string, tabId: string, token: object) {
  const pane = await agent.tabPane(sessionId, tabId);
  if (!pane || !current(tabId, token)) return;
  followShellToTab(sessionId, pane.paneId, tabId);
  await adoptPane({ id: pane.paneId, sessionId, title: "Agent", hidden: true, owned: true }, () => current(tabId, token));
  if (!current(tabId, token)) return;
  set({ info: { ...state.info, [tabId]: { command: pane.command, harness: pane.harness } } });
}

/** Where a tab's terminal view lives: on this computer, or `remote` in a cloud workspace. */
export interface TabViewPlace {
  remote?: boolean;
  /** Remote: what moves a native Codex tab to its terminal there (the backend's `toTerminal`). */
  toTerminal?: (tabId: string, transitionId?: string) => Promise<boolean | void>;
}

// A wait belongs to the window's explicit switch request, not to the agent.
// Cancelling it never interrupts work or replays input. Every retry asks the
// runtime again, so stale UI status cannot stop an active native connection.
const terminalWaits = new Map<string, { cancelled: boolean; wake?: () => void }>();
export function cancelTerminalView(tabId: string) {
  const wait = terminalWaits.get(tabId);
  if (wait) { wait.cancelled = true; wait.wake?.(); }
}

/** Show the tab's CLI. Native Codex waits for its current turn to settle. */
export async function enterTerminalView(session: SessionEntry, tab: TabEntry, place: TabViewPlace = {}) {
  if (state.switching[tab.id] || tabViewOf(tab) === "terminal" || (!place.remote && removedHere(tab.id))) return;
  const token = lifetime(tab.id);
  const wait = { cancelled: false, wake: undefined as (() => void) | undefined };
  const transitionId = crypto.randomUUID();
  const startedAt = performance.now();
  let sequence = 0;
  let reports = Promise.resolve();
  let category: "handoff" | "start" | "attach" = "handoff";
  const note = (stage: Parameters<typeof agent.reportTerminalView>[2]["stage"], errorCategory: typeof category | null = null) => {
    if (place.remote) return; // The workspace records its own handoff evidence.
    const report = { transitionId, sequence: ++sequence, elapsedMs: Math.round(performance.now() - startedAt), surface: "window" as const, stage, errorCategory };
    // Ordered, best effort, and never on the path that opens the terminal.
    reports = reports.then(() => agent.reportTerminalView(session.id, tab.id, report)).catch(() => {});
  };
  note("requested");
  terminalWaits.set(tab.id, wait);
  const valid = () => current(tab.id, token) && !wait.cancelled;
  set({ switching: { ...state.switching, [tab.id]: true }, errors: { ...state.errors, [tab.id]: null } });
  try {
    if (tab.transport === "experimentalCodexStdio") {
      if (place.remote && !place.toTerminal) throw new Error("This workspace cannot open the native Codex terminal. Reconnect to an updated runtime and try again.");
      const move = () => place.remote ? place.toTerminal?.(tab.id, transitionId) : agent.tabToTerminal(session.id, tab.id, transitionId);
      while (valid() && await move() === false) {
        if (!valid()) return;
        if (!state.waiting[tab.id]) {
          note("waiting_for_turn");
          set({ waiting: { ...state.waiting, [tab.id]: true } });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          wait.wake = () => { clearTimeout(timer); resolve(); };
        });
      }
      if (!valid()) return;
      set({ waiting: { ...state.waiting, [tab.id]: false } });
    }
    if (!place.remote) {
      if (isPtyFirst(tab.harness)) {
        // A failed start retains the chat and the precise refusal. Mount-time
        // starts still report errors through the store, without rejecting.
        category = "start";
        note("starting_terminal");
        if (!await startTabAgent(session, tab)) { note("failed", category); return; }
        if (!valid()) return;
        category = "attach";
        note("attaching");
        await adoptTabPane(session.id, tab.id, token);
        if (!valid()) return;
        // The sidebar can switch a session this window has never mounted.
        // Prepare its ordinary cached terminal now; a later view adopts the
        // same instance and stream instead of requiring another handoff.
        const paneId = terminalPaneId(tab);
        const terminalView = await import("@/components/terminal/TerminalView");
        if (!valid()) return;
        await ensureTerminalAttached(paneId, () => terminalView.createInstance(paneId, getTheme().resolvedMode));
      } else {
        const info = await agent.tabHandoff(session.id, tab.id);
        if (!valid()) return;
        await openTerminal(session.id, session.cwd, 100, 24, { id: terminalPaneId(tab), title: tab.title ?? tab.harness, command: info.command, hidden: true });
        if (valid()) set({ info: { ...state.info, [tab.id]: info } });
      }
    }
    if (valid()) {
      set({ views: { ...state.views, [tab.id]: "terminal" }, errors: { ...state.errors, [tab.id]: null } });
      note("opened");
    }
  } catch (e) {
    if (valid()) {
      note("failed", category);
      set({ errors: { ...state.errors, [tab.id]: errorMessage(e) } });
    }
  } finally {
    if (!valid()) note("cancelled");
    if (terminalWaits.get(tab.id) === wait) terminalWaits.delete(tab.id);
    if (current(tab.id, token)) set({ switching: { ...state.switching, [tab.id]: false }, waiting: { ...state.waiting, [tab.id]: false } });
  }
}

/** Show the transcript again. A PTY-first tab leaves its CLI running. */
export async function leaveTerminalView(_session: SessionEntry, tab: TabEntry, place: TabViewPlace = {}) {
  if (tabViewOf(tab) !== "terminal") return;
  // Said, not left unsaid: a tab that opens on its terminal has to be told to show its chat.
  const shown = (): Record<string, TabViewMode> => {
    const views = { ...state.views };
    if (defaultTabView(tab) === "chat") delete views[tab.id];
    else views[tab.id] = "chat";
    return views;
  };
  if (place.remote) {
    set({ views: shown() });
    return;
  }
  const token = lifetime(tab.id);
  set({ switching: { ...state.switching, [tab.id]: true } });
  try {
    if (!isPtyFirst(tab.harness)) await closeTerminal(terminalPaneId(tab));
  } finally {
    if (current(tab.id, token)) {
      const views = shown();
      const info = { ...state.info };
      if (!isPtyFirst(tab.harness)) delete info[tab.id];
      set({ views, info, switching: { ...state.switching, [tab.id]: false } });
    }
  }
}

export async function toggleTabView(session: SessionEntry, tab: TabEntry, place: TabViewPlace = {}) {
  if (tabViewOf(tab) === "terminal") await leaveTerminalView(session, tab, place);
  else await enterTerminalView(session, tab, place);
}

/** Tests only. */
export function resetTabViews() {
  for (const id of terminalWaits.keys()) cancelTerminalView(id);
  terminalWaits.clear();
  lifetimes.clear();
  removedTabs.clear();
  starting.clear();
  set({ views: {}, info: {}, errors: {}, switching: {}, waiting: {} });
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
