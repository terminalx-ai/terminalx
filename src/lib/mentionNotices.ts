/**
 * The receiving half of chat @mentions (PRO-141): the in-app notification
 * (design 13.03), the `@` on a session's row until it is read (13.16), and
 * the quote, read from this device's own decrypted transcript by message id.
 * The server sent ids only.
 */
import { useSyncExternalStore } from "react";
import { getTabLog } from "@/lib/agentEvents";
import { relistCloudCheckpoints, refreshFromCheckpoint } from "@/lib/cloudAgents";
import { openCloudSession } from "@/lib/cloudDashboard";
import { mentionMessage, mentionQuote } from "@/lib/mentions";
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
/** The quote, once this device has the message; the notice was shown without it. */
export function setMentionQuote(id: string, quote: string) {
  if (notices.some((notice) => notice.id === id && notice.quote !== quote)) {
    publishNotices(notices.map((notice) => (notice.id === id ? { ...notice, quote } : notice)));
  }
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

/** When to look again for a message this device does not have yet: the workspace saves its checkpoint after the turn. */
const QUOTE_RETRIES_MS = [0, 3_000, 10_000, 30_000];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The mentioned message's text, from the tab's log here: already loaded, else
 * this desktop's saved cache, else the workspace's encrypted checkpoint for
 * the tab, decrypted here. Never from the server in plain text. The
 * checkpoint list is read again first: a person who has just started
 * following knows none of the workspace's tabs, and a tab may be newer than
 * the list read before. A checkpoint saved before the message is tried again
 * a few times. The notification does not wait for any of this. Only a
 * message the transcript says the mentioning person wrote is quoted: the
 * message id comes from them, so it could name someone else's message.
 */
export async function lookUpMentionQuote(notice: Pick<MentionNotice, "organizationId" | "workspaceId" | "sessionId" | "tabId" | "messageId" | "actorId">, retries: readonly number[] = QUOTE_RETRIES_MS): Promise<string | null> {
  const events = () => getTabLog(notice.sessionId, notice.tabId).events;
  const read = () => mentionQuote(events(), notice.messageId, notice.actorId);
  // Here and written by someone else: no later checkpoint changes who wrote it.
  const other = () => mentionMessage(events(), notice.messageId, notice.actorId) === "other";
  const scope = { organizationId: notice.organizationId, workspaceId: notice.workspaceId };
  let waited = 0;
  for (const at of retries) {
    await wait(at - waited);
    waited = at;
    const now = read();
    if (now) return now;
    if (other()) return null;
    try {
      await relistCloudCheckpoints(scope);
      if (read()) return read();
      await refreshFromCheckpoint(scope, notice.tabId);
    } catch { /* Offline or no key: try again later, then go without the quote. */ }
    const found = read();
    if (found || other()) return found;
  }
  return null;
}
