import { useSyncExternalStore } from "react";

/** App-level dialogs opened from anywhere (menus, panels, hotkeys). */
interface State {
  settleFor: string | null;
  workspaceDelete: { projectPath: string; path: string; name: string } | null;
}

let state: State = { settleFor: null, workspaceDelete: null };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useDialogs(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

export function openSettle(sessionId: string) {
  set({ settleFor: sessionId });
}

export function closeSettle() {
  set({ settleFor: null });
}

export function openWorkspaceDelete(projectPath: string, path: string, name: string) {
  set({ workspaceDelete: { projectPath, path, name } });
}

export function closeWorkspaceDelete() {
  set({ workspaceDelete: null });
}
