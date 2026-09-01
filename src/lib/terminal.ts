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
  exited: boolean;
  exitCode: number | null;
}

interface State {
  panes: TerminalPane[];
  /** session id → active pane id */
  active: Record<string, string>;
  /** session id → dock open */
  open: Record<string, boolean>;
}

let state: State = { panes: [], active: {}, open: {} };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useTerminals(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
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

let subscribed = false;
export async function subscribeTerminals() {
  if (subscribed) return;
  subscribed = true;
  try {
    await listen<{ id: string; data: string }>("pty_data", (e) => {
      const { id, data } = e.payload;
      if (!state.panes.some((p) => p.id === id)) return;
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
export async function openTerminal(sessionId: string, cwd: string, cols = 100, rows = 24): Promise<TerminalPane> {
  await subscribeTerminals();
  counter++;
  const id = `${sessionId}:${Date.now().toString(36)}${counter}`;
  const pane: TerminalPane = { id, sessionId, title: `Terminal ${state.panes.filter((p) => p.sessionId === sessionId).length + 1}`, exited: false, exitCode: null };
  set({ panes: [...state.panes, pane], active: { ...state.active, [sessionId]: id }, open: { ...state.open, [sessionId]: true } });
  try {
    await pty.spawn(id, cwd, cols, rows);
  } catch (e) {
    set({ panes: state.panes.filter((p) => p.id !== id) });
    throw e;
  }
  return pane;
}

export async function closeTerminal(id: string) {
  const pane = state.panes.find((p) => p.id === id);
  if (!pane) return;
  await pty.kill(id).catch(() => {});
  const rest = state.panes.filter((p) => p.id !== id);
  const siblings = rest.filter((p) => p.sessionId === pane.sessionId);
  set({
    panes: rest,
    active: { ...state.active, [pane.sessionId]: siblings[siblings.length - 1]?.id ?? "" },
  });
  replay.delete(id);
  disposeInstance(id);
}

export function setActiveTerminal(sessionId: string, id: string) {
  set({ active: { ...state.active, [sessionId]: id } });
}

/** ⌘J and the header button: show the dock (spawning a first shell), or hide it. */
export async function toggleDock(sessionId: string, cwd: string) {
  if (state.open[sessionId]) {
    setDockOpen(sessionId, false);
    return;
  }
  setDockOpen(sessionId, true);
  if (!state.panes.some((p) => p.sessionId === sessionId)) await openTerminal(sessionId, cwd);
}

export function setDockOpen(sessionId: string, open: boolean) {
  set({ open: { ...state.open, [sessionId]: open } });
}

export function renameTerminal(id: string, title: string) {
  set({ panes: state.panes.map((p) => (p.id === id ? { ...p, title } : p)) });
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
