import { useEffect, useRef, useState } from "react";
import { api, type WorkspaceRemoveOptions } from "@/lib/api";
import { getSessionStore, removeWorkspace } from "@/lib/sessions";
import type { BranchOutcome } from "@/lib/worktreeConfirm";
import type { SessionEntry, WorkspaceDisposition } from "@/types/session";

/**
 * Only a confirmed merged PR with no local-only work is a safe cleanup
 * shortcut. The one rule behind every "Delete workspace" shortcut (the PR
 * panel's and the chat's), so they cannot drift.
 */
export function canDeleteMergedWorkspace(disposition: WorkspaceDisposition | null): boolean {
  return !!(
    disposition?.exists &&
    !disposition.isMain &&
    disposition.uncommitted === 0 &&
    disposition.unpushed === 0 &&
    disposition.prChecked &&
    disposition.pr?.state === "MERGED"
  );
}

/** The chat's shortcut: the same rule, and never while an agent turn runs in the workspace. */
export function offersWorkspaceDelete(disposition: WorkspaceDisposition | null, turnRunning: boolean): boolean {
  return !turnRunning && canDeleteMergedWorkspace(disposition);
}

/**
 * Where a workspace is read and removed: this computer, or the cloud
 * workspace whose runtime holds the worktree. The removal dialog asks its
 * host and nothing else, so a path is never interpreted on another machine.
 */
export interface WorkspaceHost {
  /** Changes whenever what it points at does; effects key on it. */
  key: string;
  /** `fetch` asks for the clean-and-merged verdict the removal dialog shows; without it the read is quick. */
  disposition(options?: { fetch?: boolean }): Promise<WorkspaceDisposition>;
  remove(options: WorkspaceRemoveOptions): Promise<BranchOutcome>;
  /** Whether an agent turn runs in any of these sessions, as far as this window knows. */
  turnRunning(sessionIds: string[]): boolean;
}

/** A session's worktree, as the chat offers to remove it. */
export interface RemovableWorkspace {
  host: WorkspaceHost;
  projectPath: string;
  /** The worktree's path on its host; only ever shown, or sent back to that host. */
  path: string;
  name: string;
}

/** A tab whose agent turn has not ended: running, or waiting on an answer. */
export const turnLive = (status: string) => status === "in_progress" || status === "waiting";

/** The worktree at `path` on this computer, through the existing Tauri commands. */
export function localWorkspaceHost(projectPath: string, path: string): WorkspaceHost {
  return {
    key: `local:${projectPath}\0${path}`,
    disposition: (options) => api.workspaceDisposition(projectPath, path, options),
    remove: (options) => removeWorkspace(projectPath, path, options),
    turnRunning: (sessionIds) =>
      getSessionStore().sessions.some((session) => sessionIds.includes(session.id) && session.tabs.some((tab) => turnLive(tab.status))),
  };
}

/** A local session's worktree; none for one in the project's main directory or whose worktree is gone. */
export function localRemovableWorkspace(session: SessionEntry): RemovableWorkspace | undefined {
  if (!session.worktreeName || session.worktreeRemoved) return undefined;
  return { host: localWorkspaceHost(session.projectPath, session.cwd), projectPath: session.projectPath, path: session.cwd, name: session.worktreeName };
}

/** How often the chat reads a worktree again, as the PR panel does for an open pull request. */
const RECHECK_MS = 30_000;

/**
 * The quick read of a workspace, kept current while `watching`: read at
 * once, every 30 seconds, and when the window comes back. That is how a pull
 * request merged elsewhere is noticed without a new turn.
 *
 * Nothing is kept from before `watching`: what was true before an agent's
 * turn says nothing about the worktree after it. A read that fails is "not
 * checked", never the last answer.
 */
export function useWorkspaceDisposition(host: WorkspaceHost | undefined, watching: boolean): WorkspaceDisposition | null {
  const [checked, setChecked] = useState<{ key: string; disposition: WorkspaceDisposition } | null>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  const key = host?.key ?? null;

  useEffect(() => {
    setChecked(null);
    if (!key || !watching) return;
    let cancelled = false;
    const read = () => {
      const current = hostRef.current;
      if (!current || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      current
        .disposition()
        .then((disposition) => !cancelled && setChecked({ key, disposition }))
        .catch(() => !cancelled && setChecked(null));
    };
    read();
    const timer = window.setInterval(read, RECHECK_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [key, watching]);

  return checked && checked.key === key ? checked.disposition : null;
}
