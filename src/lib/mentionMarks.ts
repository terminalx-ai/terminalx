/**
 * The @ on a cloud session's sidebar row (PRO-141, design 13.16): a teammate
 * mentioned you there and you have not read it yet. Kept per account across
 * launches; no imports of the agent stores, which clear it when a tab is read.
 */
import { useSyncExternalStore } from "react";
import { cloudSessionKey } from "@/types/target";

/** Session row key → the inbox ids of mentions not read yet. Kept per account across launches. */
const marks = new Map<string, string[]>();
const markListeners = new Set<() => void>();
let markOwner: string | null = null;
const STORAGE_PREFIX = "terminalx.mentions.v1:";
const MAX_MARKED_SESSIONS = 200;

function saveMarks() {
  if (markOwner) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${encodeURIComponent(markOwner)}`, JSON.stringify([...marks]));
    } catch { /* The @ marks are a convenience; the row's read state stays the server's. */ }
  }
  for (const listener of markListeners) listener();
}

/** The signed-in account's marks; null (signed out, data privacy) clears them from memory. */
export function configureMentionMarks(account: string | null) {
  if (account === markOwner) return;
  markOwner = account;
  marks.clear();
  if (account) {
    try {
      const saved = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${encodeURIComponent(account)}`) ?? "[]");
      if (Array.isArray(saved)) {
        for (const entry of saved) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1])) marks.set(entry[0], entry[1].filter((id: unknown) => typeof id === "string"));
        }
      }
    } catch { /* Unreadable marks start empty. */ }
  }
  for (const listener of markListeners) listener();
}

/** The account changed for good: its saved marks are forgotten. */
export function forgetMentionMarks(account: string) {
  try { localStorage.removeItem(`${STORAGE_PREFIX}${encodeURIComponent(account)}`); } catch { /* storage unavailable */ }
}

export function markMentioned(notice: { id: string; organizationId: string; workspaceId: string; sessionId: string }) {
  const key = cloudSessionKey(notice.organizationId, notice.workspaceId, notice.sessionId);
  const ids = marks.get(key) ?? [];
  if (ids.includes(notice.id)) return;
  marks.delete(key);
  marks.set(key, [...ids, notice.id].slice(-20));
  while (marks.size > MAX_MARKED_SESSIONS) marks.delete(marks.keys().next().value!);
  saveMarks();
}

type ReadListener = (organizationId: string, workspaceId: string, sessionId: string) => void;
const readListeners = new Set<ReadListener>();
/** Told whenever a session is read, whether or not it had an @. */
export function onMentionsRead(listener: ReadListener): () => void {
  readListeners.add(listener);
  return () => { readListeners.delete(listener); };
}

/** The session was read here: its @ goes, and so do its notices. */
export function markMentionsRead(organizationId: string, workspaceId: string, sessionId: string) {
  const had = marks.delete(cloudSessionKey(organizationId, workspaceId, sessionId));
  for (const listener of readListeners) listener(organizationId, workspaceId, sessionId);
  if (had) saveMarks();
}

/** Access to a workspace is gone: its marks go with it. */
export function dropWorkspaceMarks(workspaceId: string) {
  let changed = false;
  for (const key of [...marks.keys()]) {
    // `cloud:<org>:<workspace>:<session>`
    if (key.split(":")[2] === workspaceId) {
      marks.delete(key);
      changed = true;
    }
  }
  if (changed) saveMarks();
}

export function mentionMarked(sessionKey: string): boolean {
  return marks.has(sessionKey);
}
export function useMentionMarked(sessionKey: string): boolean {
  return useSyncExternalStore((listener) => { markListeners.add(listener); return () => { markListeners.delete(listener); }; }, () => marks.has(sessionKey), () => false);
}
