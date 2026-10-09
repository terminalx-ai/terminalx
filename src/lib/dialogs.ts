import { useSyncExternalStore } from "react";
import { BYPASS_MODE } from "./models";
import { getPrefs } from "./prefs";

/** App-level dialogs opened from anywhere (menus, panels, hotkeys). */
/**
 * A workspace about to be removed. `settle` keeps its sessions (the work has
 * landed, the conversations stay); `delete` removes them with it.
 */
export interface WorkspaceRemoveRequest {
  projectPath: string;
  path: string;
  name: string;
  mode: "delete" | "settle";
  /** Settling was started from this session; "Move session to project" applies to it. */
  sessionId?: string;
}

interface State {
  workspaceRemove: WorkspaceRemoveRequest | null;
  bypass: { harness: string; confirm: () => void } | null;
  /** The session being renamed. */
  renameSession: string | null;
  /** The quick chat being moved into a project. */
  moveToProject: string | null;
}

let state: State = { workspaceRemove: null, bypass: null, renameSession: null, moveToProject: null };
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

/** Every way of removing a workspace opens this one dialog. */
export function openWorkspaceRemove(request: WorkspaceRemoveRequest) {
  set({ workspaceRemove: request });
}

/** Settle a session's worktree: remove it, keep the conversations. */
export function openSettle(session: { id: string; projectPath: string; cwd: string; worktreeName?: string | null }) {
  openWorkspaceRemove({ projectPath: session.projectPath, path: session.cwd, name: session.worktreeName ?? session.cwd, mode: "settle", sessionId: session.id });
}

export function openWorkspaceDelete(projectPath: string, path: string, name: string) {
  openWorkspaceRemove({ projectPath, path, name, mode: "delete" });
}

export function closeWorkspaceRemove() {
  set({ workspaceRemove: null });
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

/** Rename a session: one dialog, in whichever window asked. */
export function openRenameSession(sessionId: string) {
  set({ renameSession: sessionId });
}

export function closeRenameSession() {
  set({ renameSession: null });
}

/** Move a quick chat into a project. */
export function openMoveToProject(sessionId: string) {
  set({ moveToProject: sessionId });
}

export function closeMoveToProject() {
  set({ moveToProject: null });
}
