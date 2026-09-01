import { useSyncExternalStore } from "react";

/** App-level dialogs opened from anywhere (menus, panels, hotkeys). */
interface State {
  settleFor: string | null;
}

let state: State = { settleFor: null };
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
