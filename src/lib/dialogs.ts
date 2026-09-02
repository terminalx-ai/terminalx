import { useSyncExternalStore } from "react";
import { BYPASS_MODE } from "./models";
import { getPrefs } from "./prefs";

/** App-level dialogs opened from anywhere (menus, panels, hotkeys). */
interface State {
  settleFor: string | null;
  workspaceDelete: { projectPath: string; path: string; name: string } | null;
  bypass: { harness: string; confirm: () => void } | null;
}

let state: State = { settleFor: null, workspaceDelete: null, bypass: null };
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

/**
 * A permission mode the reader picked, applied. Every mode but one applies
 * itself; "Bypass permissions" turns off the thing that would have asked, so
 * it is the one choice the app asks about first — once, unless they say not
 * to be asked again.
 *
 * Callers hand over what to do rather than what was chosen, so a picker never
 * has to know which case it is in: the mode either lands now or lands when
 * the dialog is agreed to.
 */
export function chooseMode(harness: string, mode: string, apply: (mode: string) => void) {
  if (mode !== BYPASS_MODE || getPrefs().bypassConfirmed) {
    apply(mode);
    return;
  }
  set({ bypass: { harness, confirm: () => apply(mode) } });
}

export function closeBypass() {
  set({ bypass: null });
}
