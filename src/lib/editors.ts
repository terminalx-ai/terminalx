import { useSyncExternalStore } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { fileName } from "@/lib/paths";

/**
 * Open files per session. An editor tab sits beside the agent tabs; when one
 * is active the transcript hides behind it. Nothing here is persisted: the
 * files come back from disk, and an unsaved buffer is guarded on close.
 */
export interface EditorEntry {
  id: string;
  sessionId: string;
  /** Absolute project root the relative path hangs off. */
  root: string;
  rel: string;
  name: string;
  dirty: boolean;
  /** Set to scroll to a place; bumped `nonce` re-fires it on a re-open. */
  jump?: { line: number; col?: number; nonce: number };
}

interface State {
  editors: EditorEntry[];
  /** session id → active editor id, or null when an agent tab is showing */
  active: Record<string, string | null>;
}

let state: State = { editors: [], active: {} };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useEditors(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

export function getEditors(): State {
  return state;
}

let nonce = 0;
export function openFile(sessionId: string, root: string, rel: string, at?: { line: number; col?: number }) {
  const existing = state.editors.find((e) => e.sessionId === sessionId && e.root === root && e.rel === rel);
  const jump = at ? { ...at, nonce: ++nonce } : undefined;
  if (existing) {
    set({
      editors: state.editors.map((e) => (e.id === existing.id && jump ? { ...e, jump } : e)),
      active: { ...state.active, [sessionId]: existing.id },
    });
    return existing.id;
  }
  const id = `${sessionId}:${rel}`;
  const entry: EditorEntry = { id, sessionId, root, rel, name: fileName(rel), dirty: false, jump };
  set({ editors: [...state.editors, entry], active: { ...state.active, [sessionId]: id } });
  return id;
}

export async function closeEditor(id: string) {
  const e = state.editors.find((x) => x.id === id);
  if (!e) return;
  if (e.dirty) {
    const discard = await ask(`${e.name} has unsaved changes. Close it and lose them?`, { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep editing" }).catch(() => false);
    if (!discard) return;
  }
  const rest = state.editors.filter((x) => x.id !== id);
  const siblings = rest.filter((x) => x.sessionId === e.sessionId);
  const wasActive = state.active[e.sessionId] === id;
  set({
    editors: rest,
    active: wasActive ? { ...state.active, [e.sessionId]: siblings[siblings.length - 1]?.id ?? null } : state.active,
  });
}

export function setActiveEditor(sessionId: string, id: string | null) {
  set({ active: { ...state.active, [sessionId]: id } });
}

export function setEditorDirty(id: string, dirty: boolean) {
  const e = state.editors.find((x) => x.id === id);
  if (!e || e.dirty === dirty) return;
  set({ editors: state.editors.map((x) => (x.id === id ? { ...x, dirty } : x)) });
}

export function clearJump(id: string) {
  set({ editors: state.editors.map((x) => (x.id === id ? { ...x, jump: undefined } : x)) });
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
