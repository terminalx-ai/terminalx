/**
 * The receiving half of chat @mentions (PRO-141): the in-app notification
 * (design 13.03), the `@` on a session's row until it is read (13.16), and
 * the quote, read from this device's own decrypted transcript by message id.
 * The server sent ids only.
 */
import { useSyncExternalStore } from "react";
import { getTabLog } from "@/lib/agentEvents";
import { loadCloudAgents, refreshFromCheckpoint } from "@/lib/cloudAgents";
import { openCloudSession } from "@/lib/cloudDashboard";
import { mentionQuote } from "@/lib/mentions";
import { dropWorkspaceMarks, markMentionsRead, onMentionsRead } from "@/lib/mentionMarks";
export { configureMentionMarks, forgetMentionMarks, markMentioned, markMentionsRead, mentionMarked, useMentionMarked } from "@/lib/mentionMarks";
import { cloudSessionKey } from "@/types/target";

export interface MentionNotice {
  /** The inbox event id. */
  id: string;
  organizationId: string;
  workspaceId: string;
  /** The runtime session; with org and workspace, the session row's key. */
  sessionId: string;
  tabId: string;
  messageId: string;
  actorId: string;
  actorName: string;
  workspaceName: string;
  /** The message, when this device has it; else the notice says only who and where. */
  quote: string | null;
  at: number;
}

const MAX_NOTICES = 10;
let notices: MentionNotice[] = [];
const noticeListeners = new Set<() => void>();
function publishNotices(next: MentionNotice[]) {
  notices = next;
  for (const listener of noticeListeners) listener();
}

export function getMentionNotices() { return notices; }
export function useMentionNotices() {
  return useSyncExternalStore((listener) => { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; }, () => notices);
}
export function showMentionNotice(notice: MentionNotice) {
  publishNotices([...notices.filter((existing) => existing.id !== notice.id), notice].slice(-MAX_NOTICES));
}
/** Another account, or data privacy: nothing shown stays. */
export function clearMentionNotices() {
  if (notices.length) publishNotices([]);
}
export function dismissMentionNotice(id: string) {
  if (notices.some((notice) => notice.id === id)) publishNotices(notices.filter((notice) => notice.id !== id));
}
/** Access to a workspace is gone: its notices go with it. */
export function dropWorkspaceMentions(workspaceId: string) {
  if (notices.some((notice) => notice.workspaceId === workspaceId)) publishNotices(notices.filter((notice) => notice.workspaceId !== workspaceId));
  dropWorkspaceMarks(workspaceId);
}

// A session read here takes its notices with its @ (the marks are kept apart, free of the agent stores).
onMentionsRead((organizationId, workspaceId, sessionId) => {
  if (notices.some((notice) => notice.organizationId === organizationId && notice.workspaceId === workspaceId && notice.sessionId === sessionId)) {
    publishNotices(notices.filter((notice) => !(notice.organizationId === organizationId && notice.workspaceId === workspaceId && notice.sessionId === sessionId)));
  }
});

/** Open: the session and the mentioned tab; the @ stays until the tab is read there. */
export function openMention(notice: MentionNotice) {
  dismissMentionNotice(notice.id);
  openCloudSession(cloudSessionKey(notice.organizationId, notice.workspaceId, notice.sessionId), notice.tabId);
}

/** Mark as read without opening it. */
export function readMention(notice: MentionNotice) {
  markMentionsRead(notice.organizationId, notice.workspaceId, notice.sessionId);
}

// ---- the quote, from this device's own transcript

const QUOTE_WAIT_MS = 1500;

/**
 * The mentioned message's text, from the tab's log here: already loaded, else
 * this desktop's saved cache, else the workspace's newest encrypted
 * checkpoint, decrypted here. Never from the server in plain text. Gives up
 * after a moment so the notification is not held back for it.
 */
export async function lookUpMentionQuote(notice: Pick<MentionNotice, "organizationId" | "workspaceId" | "sessionId" | "tabId" | "messageId">, waitMs = QUOTE_WAIT_MS): Promise<string | null> {
  const read = () => mentionQuote(getTabLog(notice.sessionId, notice.tabId).events, notice.messageId);
  const now = read();
  if (now) return now;
  const scope = { organizationId: notice.organizationId, workspaceId: notice.workspaceId };
  const load = (async () => {
    await loadCloudAgents(scope);
    if (read()) return;
    await refreshFromCheckpoint(scope, notice.tabId);
  })().catch(() => undefined);
  await Promise.race([load, new Promise((resolve) => setTimeout(resolve, waitMs))]);
  return read();
}
