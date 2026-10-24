import { useSyncExternalStore } from "react";
import { BYPASS_MODE } from "./models";
import { getPrefs } from "./prefs";
import type { BulkClose } from "./tabActions";
import type { WorkspaceHost } from "./workspaceRemoval";

/** App-level dialogs opened from anywhere (menus, panels, hotkeys). */
/**
 * A workspace about to be removed. The mode records the entry point for
 * compatibility; the dialog defaults to keeping conversations from either one.
 * Permanent deletion is chosen separately in the dialog.
 */
export interface WorkspaceRemoveRequest {
  projectPath: string;
  path: string;
  name: string;
  mode: "delete" | "settle";
  /** Settling was started from this session; "Move session to project" applies to it. */
  sessionId?: string;
  /** Where the workspace is read and removed; this computer when absent. Hosts that cannot keep conversations explain that limitation in the dialog. */
  host?: WorkspaceHost;
}

interface State {
  workspaceRemove: WorkspaceRemoveRequest | null;
  bypass: { harness: string; confirm: () => void } | null;
  /** The session being renamed. */
  renameSession: string | null;
  /** The quick chat being moved into a project. */
  moveToProject: string | null;
  /** The session being linked to an issue by hand (#441). */
  linkIssue: string | null;
  /** The bulk worktree clean-up is open. */
  worktreeCleanup: boolean;
  /** The tab being renamed. */
  renameTab: TabRequest | null;
  /** Several tabs about to be closed: the dialog says how many, and what is still going on in them. */
  closeTabs: (TabRequest & { action: BulkClose }) | null;
}

/** A tab of a workspace, named from one of that workspace's sessions (the open one). */
export interface TabRequest {
  sessionId: string;
  /** The tab's key (`tabKey`); for a bulk close, the tab its menu was opened on, if any. */
  tab: string | null;
}

let state: State = { workspaceRemove: null, bypass: null, renameSession: null, moveToProject: null, linkIssue: null, worktreeCleanup: false, renameTab: null, closeTabs: null };
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

export function openWorkspaceDelete(projectPath: string, path: string, name: string, host?: WorkspaceHost) {
  openWorkspaceRemove({ projectPath, path, name, mode: "delete", host });
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

/** Rename a tab: the reader's own title for it. */
export function openRenameTab(sessionId: string, tab: string) {
  set({ renameTab: { sessionId, tab } });
}

export function closeRenameTab() {
  set({ renameTab: null });
}

/** Ask before closing several tabs of a workspace at once. */
export function openCloseTabs(sessionId: string, action: BulkClose, tab: string | null) {
  set({ closeTabs: { sessionId, action, tab } });
}

export function closeCloseTabs() {
  set({ closeTabs: null });
}

/** "Link to issue…" on a session. */
export function openLinkIssue(sessionId: string) {
  set({ linkIssue: sessionId });
}

export function closeLinkIssue() {
  set({ linkIssue: null });
}

/** Move a quick chat into a project. */
export function openMoveToProject(sessionId: string) {
  set({ moveToProject: sessionId });
}

export function closeMoveToProject() {
  set({ moveToProject: null });
}

/** The bulk clean-up of worktrees across open projects. Opening it only scans. */
export function openWorktreeCleanup() {
  set({ worktreeCleanup: true });
}

export function closeWorktreeCleanup() {
  set({ worktreeCleanup: false });
}
