/**
 * The sending half of chat @mentions (PRO-141): who can be mentioned in a
 * cloud session's composer, the access check before a message goes, and the
 * ids posted once it has its own event in the transcript.
 */
import { api } from "@/lib/api";
import { getTabLog, subscribeTabLog } from "@/lib/agentEvents";
import { getCloudCatalog } from "@/lib/cloudCatalog";
import { workspaceAuthority } from "@/lib/cloudCollab";
import type { AgentEvent } from "@terminalx/portable/events";

export interface ComposerPeople {
  /** Changes when the session does. */
  key: string;
  orgId: string;
  workspaceId: string;
  /** The runtime's session id: what the server and the mentioned person's transcript know it by. */
  sessionId: string;
  /** The workspace's `collab/1` key, for who is here and in which tab. */
  collabKey: string;
  /** The reader, never offered to themselves. */
  selfUserId: string | null;
  /** The workspace's name for the no-access message. */
  workspaceName(): string;
  /** Who of these cannot watch the workspace. Nothing is written. Throws when it cannot tell. */
  check(userIds: string[], tabId: string): Promise<string[]>;
  /**
   * Once the sent message is in the tab's transcript, tell the server who it
   * mentions (ids only). Resolves to who cannot watch the workspace, when
   * access changed since the check; then nobody was notified.
   */
  record(userIds: string[], tabId: string, text: string, afterSeq: number): Promise<string[]>;
  /** Open the workspace's Share dialog, for the no-access message. */
  share(): void;
}

/** How long a sent message may take to reach the transcript (a stopped workspace is woken for it). */
const ARRIVAL_TIMEOUT_MS = 10 * 60_000;

/** The sent message's own event, as `hasArrived` finds it: same text, after Send was pressed. */
export function sentMessageEvent(events: readonly AgentEvent[], text: string, afterSeq: number): AgentEvent | null {
  for (let index = events.length - 1; index >= 0 && events[index].seq > afterSeq; index--) {
    const event = events[index];
    // A shared tab's message can carry who it is from ahead of the text.
    if (event.payload.type === "user_message" && (event.payload.text === text || event.payload.text.endsWith(text))) return event;
  }
  return null;
}

/** The id of the sent message once it is in the tab's log; null if it does not come in time. */
export function sentMessageId(sessionId: string, tabId: string, text: string, afterSeq: number, timeoutMs = ARRIVAL_TIMEOUT_MS): Promise<string | null> {
  const found = () => sentMessageEvent(getTabLog(sessionId, tabId).events, text, afterSeq)?.id ?? null;
  const now = found();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeTabLog(sessionId, tabId, () => {
      const id = found();
      if (!id) return;
      finish(id);
    });
    function finish(id: string | null) {
      unsubscribe();
      if (timer) clearTimeout(timer);
      resolve(id);
    }
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function workspaceRow(orgId: string, workspaceId: string) {
  return getCloudCatalog().orgs[orgId]?.workspaces.find((row) => row.workspace.id === workspaceId)?.workspace;
}

/** A cloud session's people source; the server is the authority on who can watch it. */
export function cloudComposerPeople(params: { orgId: string; workspaceId: string; sessionId: string; collabKey: string; selfUserId: string | null }): ComposerPeople {
  const { orgId, workspaceId, sessionId } = params;
  return {
    ...params,
    key: `${orgId}:${workspaceId}:${sessionId}`,
    workspaceName: () => workspaceRow(orgId, workspaceId)?.name || "this workspace",
    check: async (userIds, tabId) => (await api.cloudWorkspaceMentions(orgId, workspaceId, { sessionId, tabId, userIds, check: true })).noAccess,
    record: async (userIds, tabId, text, afterSeq) => {
      const messageId = await sentMessageId(sessionId, tabId, text, afterSeq);
      if (!messageId) return [];
      return (await api.cloudWorkspaceMentions(orgId, workspaceId, { sessionId, tabId, messageId, userIds })).noAccess;
    },
    share: () => {
      const workspace = workspaceRow(orgId, workspaceId);
      // The dialog is UI: loaded when asked for, so this module stays free of components.
      void import("@/components/cloud/CloudShareDialog").then(({ openShareDialog }) => openShareDialog({
        orgId,
        workspaceId,
        name: workspace?.name ?? "This workspace",
        accessMode: workspace?.accessMode,
        createdBy: workspace?.createdBy ?? null,
        canManage: workspace ? workspaceAuthority(workspace).manageShares : false,
      }));
    },
  };
}
