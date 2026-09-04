import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { pty } from "@/lib/api";

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

export type SelectedSessionTab = { kind: "agent" | "terminal"; id: string };

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

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

function disposeInstance(id: string) {
  const inst = instances.get(id);
  if (inst) {
    inst.term.dispose();
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
      const inst = instances.get(id);
      if (inst) {
        inst.term.write(bytes);
        return;
      }
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
    replay.delete(id);
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
  replay.delete(id);
  disposeInstance(id);
}

export function setActiveTerminal(sessionId: string, id: string) {
  const pane = state.panes.find((item) => item.id === id && item.sessionId === sessionId && !item.hidden);
  if (!pane) return;
  set({
    active: { ...state.active, [sessionId]: id },
    selected: { ...state.selected, [sessionId]: { kind: "terminal", id } },
  });
}

export function setSelectedAgent(sessionId: string, id: string) {
  set({ selected: { ...state.selected, [sessionId]: { kind: "agent", id } } });
}

/**
 * Take over a pane the backend opened — an agent tab's own CLI. The pane may
 * already have produced output before this window heard about it, which is why
 * the replay buffer is kept for ids no pane claims yet.
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
