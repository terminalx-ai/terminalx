import type { RuntimeWorkspaceRemoved, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { allMachineSessions } from "@/lib/machineCatalog";
import { getSessionStore, openWelcome } from "@/lib/sessions";
import { turnLive, type RemovableWorkspace, type WorkspaceHost } from "@/lib/workspaceRemoval";
import type { BranchOutcome } from "@/lib/worktreeConfirm";
import type { WorkspaceDisposition } from "@/types/session";

/**
 * The worktree a machine session runs in, on that machine (`workspace/1`,
 * PRO-406). It is named by the session: the machine resolves the folder from
 * its own index and removes it through the one checked removal its own
 * window uses (`session_ops::remove_workspace_fallible`): uncommitted work,
 * commits no other branch has and an open pull request need the second
 * confirmation, for exactly what was shown. Nothing on this computer is read
 * or removed; the path is only shown.
 *
 * The machine's `session.sessions` broadcast then drops the removed sessions
 * from its rows (`machineCatalog`).
 */
export function machineWorkspaceHost(input: { machineId: string; name: string; sessionId: string; sessionKey: string; client: WorkspaceRpcClient }): WorkspaceHost {
  const { machineId, name, sessionId, client } = input;
  return {
    key: `machine:${machineId}|${sessionId}`,
    keepConversationsUnavailable: `Removing a worktree on ${name} from this Mac cannot keep its conversations. Cancel to leave it on ${name} as it is.`,
    disposition: (options) => client.workspaceDisposition<WorkspaceDisposition>(sessionId, options),
    remove: async (options): Promise<BranchOutcome> => {
      if (options.keepSessions) throw new Error(`Removing a worktree on ${name} from this Mac cannot keep its conversations.`);
      const removed = await client
        .removeSessionWorkspace(sessionId, {
          deleteBranch: options.deleteBranch,
          confirmedDigest: options.confirmedDigest,
          expectedSessions: options.expectedSessions,
        })
        .catch(async (error): Promise<RuntimeWorkspaceRemoved> => {
          // A removal can outlast the request (sessions to stop, a slow
          // fetch, the link dropping): the answer is lost but the worktree is
          // gone. If the machine no longer lists the session, that is what happened.
          const listed = await client.listSessions().catch(() => null);
          if (!listed || listed.some((session) => session.id === sessionId)) throw error;
          return { deleted: options.expectedSessions.filter((id) => !listed.some((session) => session.id === id)) };
        });
      // Read at the time of the action, not of the render.
      if (removed.deleted.includes(sessionId) && getSessionStore().selectedSessionId === input.sessionKey) openWelcome();
      return removed;
    },
    turnRunning: (sessionIds) =>
      allMachineSessions().some((row) => row.machineId === machineId && sessionIds.includes(row.sessionId) && row.tabs.some((tab) => turnLive(tab.status))),
  };
}

/**
 * A machine session's worktree as the chat and the header offer to remove it:
 * only for a manager of a machine that serves `workspace/1`, and none for a
 * session in the project's own folder or whose worktree is already gone.
 * `path` is the machine's own, only shown or sent back to it.
 */
export function machineRemovableWorkspace(input: {
  client: WorkspaceRpcClient | null;
  manage: boolean;
  machineId: string;
  name: string;
  sessionId: string;
  sessionKey: string;
  projectKey: string;
  worktreeName: string | null | undefined;
  worktreeRemoved: boolean | undefined;
  cwd: string | null | undefined;
}): RemovableWorkspace | undefined {
  const { client } = input;
  if (!client || !input.manage || !client.hasCapability("workspace/1")) return undefined;
  if (!input.worktreeName || input.worktreeRemoved || !input.cwd) return undefined;
  return {
    host: machineWorkspaceHost({ machineId: input.machineId, name: input.name, sessionId: input.sessionId, sessionKey: input.sessionKey, client }),
    projectPath: input.projectKey,
    path: input.cwd,
    name: input.worktreeName,
  };
}
