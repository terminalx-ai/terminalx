import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { pty } from "@/lib/api";
import { countTerminalData, dataRate, isOnScreen, rendererOf, webglContexts, type DataRate } from "@/lib/terminalCounters";

/**
 * Terminal panes per session, and one bridge for the PTY events.
 *
 * Output arrives base64-encoded; it is decoded only for panes this window
 * opened, and a pane that has no view mounted keeps a bounded replay buffer
 * (newest bytes win) so switching sessions never loses the tail.
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
 * Live xterm instances outlive their views: a pane's element is re-parented
 * into whichever view is showing it, so a session switch keeps scrollback,
 * cursor and running programs exactly as they were.
 */
export interface TerminalInstance {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
}
const instances = new Map<string, TerminalInstance>();
const REPLAY_MAX = 256 * 1024;
const replay = new Map<string, { chunks: Uint8Array[]; size: number }>();
/**
 * Panes closed a moment ago. The last output of a pane that was just killed
 * is still on its way, and with no pane to show it, it would start a replay
 * buffer that nothing ever reads or drops.
 */
const closing = new Map<string, ReturnType<typeof setTimeout>>();
const CLOSING_MS = 5_000;

/** Let go of everything this window holds for a pane that is gone. */
function forgetPane(id: string) {
  clearTimeout(closing.get(id));
  closing.set(id, setTimeout(() => closing.delete(id), CLOSING_MS));
  replay.delete(id);
  disposeInstance(id);
}

/** A pane with this id is (again) wanted: its output is kept from here on. */
function expectPane(id: string) {
  clearTimeout(closing.get(id));
  closing.delete(id);
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The live instance of a pane, if it has one. Never makes one: a view that is on its way out must not bring a closed terminal back. */
export function peekInstance(id: string): TerminalInstance | undefined {
  return instances.get(id);
}

export function getInstance(id: string, create: () => TerminalInstance): TerminalInstance {
  let inst = instances.get(id);
  if (!inst) {
    inst = create();
    instances.set(id, inst);
    const r = replay.get(id);
    if (r) {
      for (const c of r.chunks) inst.term.write(c);
      replay.delete(id);
    }
  }
  return inst;
}

export interface TerminalCounters {
  /** Live xterm instances, local and cloud, and how many are in the document. */
  instances: number;
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
  /** Output kept for panes that have no instance yet. */
  replayBuffers: number;
  replayBytes: number;
  panes: number;
  data: { local: DataRate; cloud: DataRate };
}

/** What this window's terminals hold right now, for `terminalx status --json`. */
export function terminalCounters(): TerminalCounters {
  const live = [...instances.values()];
  const webgl = live.filter((inst) => rendererOf(inst.term) === "webgl").length;
  let replayBytes = 0;
  for (const r of replay.values()) replayBytes += r.size;
  return {
    instances: live.length,
    attached: live.filter((inst) => inst.el.isConnected).length,
    webgl,
    dom: live.length - webgl,
    onScreen: live.filter((inst) => isOnScreen(inst.term)).length,
    domOnScreen: live.filter((inst) => isOnScreen(inst.term) && rendererOf(inst.term) === "dom").length,
    hiddenInDocument: live.filter((inst) => inst.el.isConnected && !isOnScreen(inst.term)).length,
    webglContexts: { ...webglContexts },
    bufferLines: live.reduce((lines, inst) => lines + inst.term.buffer.normal.length + inst.term.buffer.alternate.length, 0),
    replayBuffers: replay.size,
    replayBytes,
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
  if (inst) {
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
    await listen<{ id: string; data: string }>("pty_data", (e) => {
      const { id, data } = e.payload;
      const bytes = decode(data);
      countTerminalData("local", bytes.length);
      const inst = instances.get(id);
      if (inst) {
        inst.term.write(bytes);
        return;
      }
      if (closing.has(id)) return;
      let r = replay.get(id);
      if (!r) replay.set(id, (r = { chunks: [], size: 0 }));
      r.chunks.push(bytes);
      r.size += bytes.length;
      while (r.size > REPLAY_MAX && r.chunks.length > 1) {
        const dropped = r.chunks.shift()!;
        r.size -= dropped.length;
      }
    });
    await listen<{ id: string; code: number | null }>("pty_exit", (e) => {
      const { id, code } = e.payload;
      set({ panes: state.panes.map((p) => (p.id === id ? { ...p, exited: true, exitCode: code } : p)) });
    });
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
  expectPane(id);
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
    forgetPane(id);
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
  forgetPane(id);
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
    forgetPane(pane.id);
  }
}

/** The pane an agent tab's CLI runs in. */
export function agentPaneId(tabId: string): string {
  return `tab:${tabId}`;
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
  // Also for a pane this window never adopted: its output may be waiting in a replay buffer.
  for (const id of gone) forgetPane(id);
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
 * already have produced output before this window heard about it, which is why
 * the replay buffer is kept for ids no pane claims yet.
 */
export async function adoptPane(pane: Omit<TerminalPane, "created" | "exited" | "exitCode">) {
  expectPane(pane.id);
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
