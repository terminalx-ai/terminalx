import type { RuntimeWorkspaceRemoved, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { forgetCloudSessions, liveCloudSessionList } from "@/lib/cloudSessions";
import { getSessionStore, selectSession } from "@/lib/sessions";
import { turnLive, type WorkspaceHost } from "@/lib/workspaceRemoval";
import type { BranchOutcome } from "@/lib/worktreeConfirm";
import type { WorkspaceDisposition } from "@/types/session";

/**
 * The worktree a cloud session runs in, on its runtime (`workspace/1`). It is
 * named by the session: the runtime resolves the directory from its own index.
 */
export function cloudWorkspaceHost(input: { orgId: string; workspaceId: string; workspaceKey: string; sessionId: string; sessionKey: string; client: WorkspaceRpcClient }): WorkspaceHost {
  const { orgId, workspaceId, sessionId, client } = input;
  return {
    key: `${input.workspaceKey}|${sessionId}`,
    disposition: (options) => client.workspaceDisposition<WorkspaceDisposition>(sessionId, options),
    remove: async (options): Promise<BranchOutcome> => {
      const removed = await client
        .removeSessionWorkspace(sessionId, {
          deleteBranch: options.deleteBranch,
          confirmedDigest: options.confirmedDigest,
          expectedSessions: options.expectedSessions,
        })
        .catch(async (error): Promise<RuntimeWorkspaceRemoved> => {
          // A removal can outlast the request (a slow fetch, sessions to
          // stop): the answer is lost but the worktree is gone. If the
          // runtime no longer lists the session, that is what happened.
          const listed = await client.listSessions().catch(() => null);
          if (!listed || listed.some((session) => session.id === sessionId)) throw error;
          return { deleted: options.expectedSessions.filter((id) => !listed.some((session) => session.id === id)) };
        });
      forgetCloudSessions({ orgId, workspaceId }, removed.deleted);
      // Read at the time of the action, not of the render.
      if (removed.deleted.includes(sessionId) && getSessionStore().selectedSessionId === input.sessionKey) selectSession(null);
      return removed;
    },
    turnRunning: (sessionIds) =>
      (liveCloudSessionList(orgId, workspaceId) ?? []).some((session) => sessionIds.includes(session.id) && session.tabs.some((tab) => turnLive(tab.status))),
  };
}
