import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { pty } from "@/lib/api";
import { dataRate, isOnScreen, rendererOf, webglContexts, type DataRate } from "@/lib/terminalCounters";
import { queuedLocalOutputBytes } from "@/lib/terminalFeed";

/**
 * Terminal panes per session, and the live xterm of each one that has been
 * shown.
 *
 * A pane's output comes straight to its xterm over its own channel, attached
 * when the xterm is made (`TerminalView`). A pane that no view has shown yet
 * costs this window nothing: the backend keeps its bounded scrollback and
 * hands it over at attach, so switching to it never loses the tail.
 */
export interface TerminalPane {
  id: string;
  sessionId: string;
  title: string;
  created: string;
  exited: boolean;
  exitCode: number | null;
  /** Owned by an agent tab's terminal view, so it is not a peer shell tab. */
  hidden?: boolean;
  /** Spawned by the backend for an agent tab, so closing it is the backend's. */
  owned?: boolean;
}

export interface OpenTerminalOptions {
  id?: string;
  title?: string;
  /** Run this instead of an interactive shell; the pane exits with it. */
  command?: string;
  hidden?: boolean;
}

export interface TerminalState {
  panes: TerminalPane[];
  /** session id → most recently selected shell pane id */
  active: Record<string, string>;
  /** session id → selected peer tab (agent or shell) */
  selected: Record<string, SelectedSessionTab>;
}

export type SelectedSessionTab = { kind: "agent" | "terminal" | "browser"; id: string };

let state: TerminalState = { panes: [], active: {}, selected: {} };
const listeners = new Set<() => void>();
function set(patch: Partial<TerminalState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useTerminals(): TerminalState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

export function getTerminalState(): TerminalState {
  return state;
}

/**
 * Recently used xterms outlive their views: a pane's element is re-parented
 * into whichever view shows it. Local instances beyond the idle budget are
 * restored from backend scrollback; their processes remain alive.
 */
export interface TerminalInstance {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  /** Stops whatever feeds it output; called when the instance is disposed. */
  release?: () => void;
  /** May be rebuilt from the backend's bounded scrollback without ending the process. */
  restorable?: boolean;
}
const instances = new Map<string, TerminalInstance>();
const sizes = new Map<string, { cols: number; rows: number }>();
/** Recently used, hidden local terminals. Visible and remote terminals are not evicted. */
export const IDLE_TERMINAL_LIMIT = 8;
let archivedSessions = new Set<string>();
let evictedInstances = 0;

export function trimTerminalInstances(keep?: string) {
  const archivedPanes = new Set(state.panes.filter((pane) => archivedSessions.has(pane.sessionId)).map((pane) => pane.id));
  const idle = [...instances].filter(([, inst]) => inst.restorable && !isOnScreen(inst.term) && !inst.el.isConnected);
  let remaining = idle.length;
  for (const [id] of idle) {
    if (id === keep) continue;
    if (remaining <= IDLE_TERMINAL_LIMIT && !archivedPanes.has(id)) continue;
    disposeInstance(id);
    evictedInstances++;
    remaining--;
  }
}

/** Archiving releases hidden views, while a terminal still being read stays intact. */
export function setArchivedTerminalSessions(ids: readonly string[]) {
  archivedSessions = new Set(ids);
  trimTerminalInstances();
}
/** The live instance of a pane, if it has one. Never makes one: a view that is on its way out must not bring a closed terminal back. */
export function peekInstance(id: string): TerminalInstance | undefined {
  return instances.get(id);
}

/** Mount before trimming when a view is acquiring a visible terminal. */
export function getInstance(id: string, create: () => TerminalInstance, host?: HTMLElement): TerminalInstance {
  let inst = instances.get(id);
  if (!inst) {
    inst = create();
    const size = sizes.get(id);
    // Replay must use the grid the PTY printed into, before a view refits it.
    if (size) inst.term.resize(size.cols, size.rows);
    instances.set(id, inst);
  }
  // Map order is the last use order, not the order terminals were created in.
  instances.delete(id);
  instances.set(id, inst);
  // The visible instance does not spend an instant in the idle budget. If
  // eight terminals are cached, trimming before mounting the ninth needlessly
  // evicts one of them and forces a scrollback replay on the next switch.
  host?.appendChild(inst.el);
  trimTerminalInstances(id);
  return inst;
}

export interface TerminalCounters {
  /** Live xterm instances, local and cloud, and how many are in the document. */
  instances: number;
  idleInstances: number;
  idleLimit: number;
  evictedInstances: number;
  /** Raw local output received but not yet parsed, including hidden-window output. */
  queuedOutputBytes: number;
  attached: number;
  /** Live instances by the renderer they are on now. A hidden terminal needs none, so `dom` counts those too. */
  webgl: number;
  dom: number;
  /** Terminals a view is showing, and how many of those are on the DOM fallback: should be none. */
  onScreen: number;
  domOnScreen: number;
  /** Terminals in the document that no view is showing. They would draw every frame of output for nobody: should be none. */
  hiddenInDocument: number;
  webglContexts: typeof webglContexts;
  /** Lines held across every live instance's buffers. */
  bufferLines: number;
  panes: number;
  data: { local: DataRate; cloud: DataRate };
}

/** What this window's terminals hold right now, for `terminalx status --json`. */
export function terminalCounters(): TerminalCounters {
  const live = [...instances.values()];
  const webgl = live.filter((inst) => rendererOf(inst.term) === "webgl").length;
  return {
    instances: live.length,
    idleInstances: live.filter((inst) => inst.restorable && !isOnScreen(inst.term) && !inst.el.isConnected).length,
    idleLimit: IDLE_TERMINAL_LIMIT,
    evictedInstances,
    queuedOutputBytes: queuedLocalOutputBytes(),
    attached: live.filter((inst) => inst.el.isConnected).length,
    webgl,
    dom: live.length - webgl,
    onScreen: live.filter((inst) => isOnScreen(inst.term)).length,
    domOnScreen: live.filter((inst) => isOnScreen(inst.term) && rendererOf(inst.term) === "dom").length,
    hiddenInDocument: live.filter((inst) => inst.el.isConnected && !isOnScreen(inst.term)).length,
    webglContexts: { ...webglContexts },
    bufferLines: live.reduce((lines, inst) => lines + inst.term.buffer.normal.length + inst.term.buffer.alternate.length, 0),
    panes: state.panes.length,
    data: { local: dataRate("local"), cloud: dataRate("cloud") },
  };
}

const disposals = new Set<(inst: TerminalInstance) => void>();
/** Call `listener` with each instance right after its xterm is disposed (the renderer releases what it holds). */
export function onInstanceDisposed(listener: (inst: TerminalInstance) => void) {
  disposals.add(listener);
}

/** Drop a live instance and its element; its process is the caller's to end. */
export function disposeInstance(id: string) {
  const inst = instances.get(id);
  const paneExists = state.panes.some((pane) => pane.id === id);
  if (!paneExists) sizes.delete(id);
  if (inst) {
    if (inst.restorable && paneExists) sizes.set(id, { cols: inst.term.cols, rows: inst.term.rows });
    inst.release?.();
    inst.term.dispose();
    for (const listener of disposals) listener(inst);
    inst.el.remove();
    instances.delete(id);
  }
}

// One subscription per window, and callers wait for it: a second caller that
// returned early while the first was still registering would miss the events
// arriving in between.
let subscribed: Promise<void> | null = null;
export function subscribeTerminals(): Promise<void> {
  return (subscribed ??= register());
}

async function register() {
  try {
    await listen<{ id: string; code: number | null }>("pty_exit", (e) => {
      const { id, code } = e.payload;
      set({ panes: state.panes.map((p) => (p.id === id ? { ...p, exited: true, exitCode: code } : p)) });
    });
  } catch {
    /* outside a webview */
  }
  try {
    // A reloaded window: the backend may still be sending to the old page's
    // views. A view attaches only after this (`createInstance` waits for
    // `subscribeTerminals`), or it would be dropped with them.
    await pty.detachAll();
  } catch {
    /* outside a webview */
  }
}

let counter = 0;
const terminalNumbers = new Map<string, number>();
export async function openTerminal(sessionId: string, cwd: string, cols = 100, rows = 24, opts: OpenTerminalOptions = {}): Promise<TerminalPane> {
  await subscribeTerminals();
  counter++;
  const id = opts.id ?? `${sessionId}:${Date.now().toString(36)}${counter}`;
  if (state.panes.some((p) => p.id === id)) await closeTerminal(id);
  const number = (terminalNumbers.get(sessionId) ?? 0) + 1;
  if (!opts.hidden && !opts.title) terminalNumbers.set(sessionId, number);
  const pane: TerminalPane = {
    id,
    sessionId,
    title: opts.title ?? `Terminal ${number}`,
    created: new Date().toISOString(),
    exited: false,
    exitCode: null,
    hidden: opts.hidden,
  };
  set({
    panes: [...state.panes, pane],
    active: opts.hidden ? state.active : { ...state.active, [sessionId]: id },
    selected: opts.hidden ? state.selected : { ...state.selected, [sessionId]: { kind: "terminal", id } },
  });
  try {
    await pty.spawn(id, cwd, cols, rows, opts.command);
  } catch (e) {
    const rest = state.panes.filter((p) => p.id !== id);
    const fallback = rest.filter((p) => p.sessionId === sessionId && !p.hidden).at(-1);
    const selected = { ...state.selected };
    if (selected[sessionId]?.kind === "terminal" && selected[sessionId]?.id === id) {
      if (fallback) selected[sessionId] = { kind: "terminal", id: fallback.id };
      else delete selected[sessionId];
    }
    set({
      panes: rest,
      active: state.active[sessionId] === id ? { ...state.active, [sessionId]: fallback?.id ?? "" } : state.active,
      selected,
    });
    throw e;
  }
  return pane;
}

export async function closeTerminal(id: string) {
  const pane = state.panes.find((p) => p.id === id);
  if (!pane) return;
  await pty.kill(id).catch(() => {});
  if (pane.hidden) {
    set({ panes: state.panes.filter((p) => p.id !== id) });
    disposeInstance(id);
    return;
  }
  const visibleBefore = state.panes.filter((p) => p.sessionId === pane.sessionId && !p.hidden);
  const closedIndex = visibleBefore.findIndex((p) => p.id === id);
  const rest = state.panes.filter((p) => p.id !== id);
  const siblings = rest.filter((p) => p.sessionId === pane.sessionId && !p.hidden);
  const nextTerminal = siblings[Math.min(Math.max(closedIndex, 0), siblings.length - 1)];
  const selected = { ...state.selected };
  if (selected[pane.sessionId]?.kind === "terminal" && selected[pane.sessionId]?.id === id) {
    if (nextTerminal) selected[pane.sessionId] = { kind: "terminal", id: nextTerminal.id };
    else delete selected[pane.sessionId];
  }
  set({
    panes: rest,
    active: { ...state.active, [pane.sessionId]: nextTerminal?.id ?? "" },
    selected,
  });
  disposeInstance(id);
}

/**
 * The sessions are gone (deleted, or their workspace was): close every
 * terminal they had, shells and agent panes alike. Nothing else would: a
 * session that is no longer listed has no tab strip to close them from.
 */
export function dropSessionTerminals(sessionIds: readonly string[]) {
  const gone = new Set(sessionIds);
  const doomed = state.panes.filter((pane) => gone.has(pane.sessionId));
  for (const id of gone) terminalNumbers.delete(id);
  const remembered = (record: Record<string, unknown>) => Object.keys(record).some((id) => gone.has(id));
  if (!doomed.length && !remembered(state.active) && !remembered(state.selected)) return;
  const without = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => !gone.has(id)));
  set({ panes: state.panes.filter((pane) => !gone.has(pane.sessionId)), active: without(state.active), selected: without(state.selected) });
  for (const pane of doomed) {
    void pty.kill(pane.id).catch(() => {});
    disposeInstance(pane.id);
  }
}

/** The pane an agent tab's CLI runs in. */
export function agentPaneId(tabId: string): string {
  return `tab:${tabId}`;
}

export function isAgentPane(id: string): boolean {
  return id.startsWith("tab:");
}

/**
 * The agent tabs are gone (closed here, or removed by the backend): let go of
 * their panes and xterms. The backend stops the CLI when it removes a tab, but
 * nothing told this window, so every closed tab kept its terminal and its
 * scrollback until its session was deleted.
 */
export function dropTabTerminals(tabIds: readonly string[]) {
  const gone = new Set(tabIds.map(agentPaneId));
  if (state.panes.some((pane) => gone.has(pane.id))) set({ panes: state.panes.filter((pane) => !gone.has(pane.id)) });
  for (const id of gone) disposeInstance(id);
}

/** Close a session's shells and leave its agent panes: its checkout was removed, so a shell there has nowhere to be. */
export async function closeSessionShells(sessionId: string) {
  for (const pane of state.panes.filter((item) => item.sessionId === sessionId && !item.hidden)) await closeTerminal(pane.id);
}

export function setActiveTerminal(sessionId: string, id: string) {
  const pane = state.panes.find((item) => item.id === id && item.sessionId === sessionId && !item.hidden);
  if (!pane) return;
  set({
    active: { ...state.active, [sessionId]: id },
    selected: { ...state.selected, [sessionId]: { kind: "terminal", id } },
  });
}

/**
 * Select a tab of a session by kind and id, with no pane lookup: a cloud
 * session's terminals live in the cloud terminal store, not in `panes`.
 */
export function selectSessionTab(sessionId: string, tab: SelectedSessionTab) {
  set({ selected: { ...state.selected, [sessionId]: tab } });
}

/** Forget the tab asked for in every session whose id starts with `prefix` (a cloud workspace whose content is gone for this person). */
export function clearSessionTabsUnder(prefix: string) {
  const stale = Object.keys(state.selected).filter((sessionId) => sessionId.startsWith(prefix));
  if (!stale.length) return;
  const selected = { ...state.selected };
  for (const sessionId of stale) delete selected[sessionId];
  set({ selected });
}

export function setSelectedAgent(sessionId: string, id: string) {
  set({ selected: { ...state.selected, [sessionId]: { kind: "agent", id } } });
}

/** A browser page is a peer tab too; the page itself lives in the browser store. */
export function setSelectedBrowser(sessionId: string, id: string) {
  set({ selected: { ...state.selected, [sessionId]: { kind: "browser", id } } });
}

/** Drop a browser selection whose page is gone so the session falls back cleanly. */
export function clearSelectedBrowser(sessionId: string, id: string) {
  const current = state.selected[sessionId];
  if (current?.kind !== "browser" || current.id !== id) return;
  const selected = { ...state.selected };
  delete selected[sessionId];
  set({ selected });
}

/**
 * Take over a pane the backend opened — an agent tab's own CLI. The pane may
 * already have produced output before this window heard about it; the view
 * gets that from the backend's scrollback when it attaches.
 */
export async function adoptPane(pane: Omit<TerminalPane, "created" | "exited" | "exitCode">) {
  await subscribeTerminals();
  const live = { ...pane, created: new Date().toISOString(), exited: false, exitCode: null };
  // The same pane can be adopted twice: a tab whose CLI is replaced in place
  // keeps its pane, so the exit the old process reported is stale news.
  const existing = state.panes.some((p) => p.id === pane.id);
  set({
    panes: existing
      ? state.panes.map((p) => (p.id === pane.id ? { ...p, ...live, created: p.created } : p))
      : [...state.panes, live],
  });
}

const terminalActivations = new Map<string, Promise<TerminalPane>>();

/** ⌘J and the header action select the latest shell, creating one when absent. */
export function activateLatestTerminal(sessionId: string, cwd: string): Promise<TerminalPane> {
  const panes = state.panes.filter((p) => p.sessionId === sessionId && !p.hidden);
  const latest = panes.find((p) => p.id === state.active[sessionId]) ?? panes[panes.length - 1];
  if (latest) {
    setActiveTerminal(sessionId, latest.id);
    return Promise.resolve(latest);
  }
  const pending = terminalActivations.get(sessionId);
  if (pending) return pending;
  const request = openTerminal(sessionId, cwd)
    .finally(() => terminalActivations.delete(sessionId));
  terminalActivations.set(sessionId, request);
  return request;
}

export function renameTerminal(id: string, title: string) {
  set({ panes: state.panes.map((p) => (p.id === id ? { ...p, title } : p)) });
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
