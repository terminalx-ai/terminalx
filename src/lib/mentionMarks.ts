/**
 * The @ on a cloud session's sidebar row (PRO-141, design 13.16): a teammate
 * mentioned you there and you have not read it yet. Kept per account across
 * launches; no imports of the agent stores, which clear it when a tab is read.
 *
 * Whether it was read is the session's synced read marker (PRO-125), the same
 * one every device of the account writes: a mention at or before the marker
 * is read, here or elsewhere. So a replay after signing in again, or a read on
 * another Mac, takes the @ away rather than bringing it back.
 */
import { useSyncExternalStore } from "react";
import { cloudActivityRead, subscribeCloudReadMarkers, writeCloudReadMarker } from "@/lib/cloudReadMarkers";
import { cloudSessionKey } from "@/types/target";

interface Mark {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  /** The inbox ids of the mentions not read yet. */
  ids: string[];
  /** When the newest of them was made (ms). */
  at: number;
}

/** Session row key → its unread mentions. */
const marks = new Map<string, Mark>();
const markListeners = new Set<() => void>();
let markOwner: string | null = null;
const STORAGE_PREFIX = "terminalx.mentions.v1:";
const MAX_MARKED_SESSIONS = 200;

const iso = (at: number) => new Date(at).toISOString();
/** The account's marker for the session has reached the mention. */
const readBy = (mark: Pick<Mark, "organizationId" | "workspaceId" | "sessionId">, at: number) =>
  cloudActivityRead(mark.organizationId, mark.workspaceId, mark.sessionId, iso(at));

function saveMarks() {
  if (markOwner) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${encodeURIComponent(markOwner)}`, JSON.stringify([...marks.values()]));
    } catch { /* The @ marks are a convenience; the row's read state stays the server's. */ }
  }
  for (const listener of markListeners) listener();
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function savedMark(value: unknown): Mark | null {
  if (!value || typeof value !== "object") return null;
  const mark = value as Partial<Mark>;
  if (!text(mark.organizationId) || !text(mark.workspaceId) || !text(mark.sessionId) || !Array.isArray(mark.ids) || !Number.isFinite(mark.at)) return null;
  return { organizationId: mark.organizationId, workspaceId: mark.workspaceId, sessionId: mark.sessionId, ids: mark.ids.filter(text), at: mark.at! };
}

/** The signed-in account's marks; null (signed out, data privacy) clears them from memory. */
export function configureMentionMarks(account: string | null) {
  if (account === markOwner) return;
  markOwner = account;
  marks.clear();
  if (account) {
    try {
      const saved = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${encodeURIComponent(account)}`) ?? "[]");
      for (const entry of Array.isArray(saved) ? saved : []) {
        const mark = savedMark(entry);
        if (mark) marks.set(cloudSessionKey(mark.organizationId, mark.workspaceId, mark.sessionId), mark);
      }
    } catch { /* Unreadable marks start empty. */ }
  }
  for (const listener of markListeners) listener();
}

/** The account changed for good: its saved marks are forgotten. */
export function forgetMentionMarks(account: string) {
  try { localStorage.removeItem(`${STORAGE_PREFIX}${encodeURIComponent(account)}`); } catch { /* storage unavailable */ }
}

/**
 * A confirmed mention, made at `at` (ms). Nothing when the session was read
 * since, on any of the account's devices.
 */
export function markMentioned(mention: { id: string; organizationId: string; workspaceId: string; sessionId: string; at: number }) {
  const { id, organizationId, workspaceId, sessionId, at } = mention;
  if (!Number.isFinite(at) || readBy(mention, at)) return;
  const key = cloudSessionKey(organizationId, workspaceId, sessionId);
  const known = marks.get(key);
  if (known?.ids.includes(id)) return;
  marks.delete(key);
  marks.set(key, { organizationId, workspaceId, sessionId, ids: [...(known?.ids ?? []), id].slice(-20), at: Math.max(known?.at ?? -Infinity, at) });
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

/**
 * The session was read here: its @ goes, and so do its notices. The read
 * marker is moved up to the mention, so the account's other devices drop
 * their @ too (a marker is never set later than now).
 */
export function markMentionsRead(organizationId: string, workspaceId: string, sessionId: string) {
  const key = cloudSessionKey(organizationId, workspaceId, sessionId);
  const mark = marks.get(key);
  marks.delete(key);
  for (const listener of readListeners) listener(organizationId, workspaceId, sessionId);
  if (!mark) return;
  saveMarks();
  void writeCloudReadMarker(organizationId, workspaceId, sessionId, iso(Math.min(mark.at, Date.now())));
}

// A marker that reached a mention, from this device, another one or a replay, takes its @.
subscribeCloudReadMarkers(() => {
  let changed = false;
  for (const [key, mark] of [...marks]) {
    if (!readBy(mark, mark.at)) continue;
    marks.delete(key);
    for (const listener of readListeners) listener(mark.organizationId, mark.workspaceId, mark.sessionId);
    changed = true;
  }
  if (changed) saveMarks();
});

/** Access to a workspace is gone: its marks go with it. */
export function dropWorkspaceMarks(workspaceId: string) {
  let changed = false;
  for (const [key, mark] of [...marks]) {
    if (mark.workspaceId !== workspaceId) continue;
    marks.delete(key);
    changed = true;
  }
  if (changed) saveMarks();
}

export function mentionMarked(sessionKey: string): boolean {
  return marks.has(sessionKey);
}
export function useMentionMarked(sessionKey: string): boolean {
  return useSyncExternalStore((listener) => { markListeners.add(listener); return () => { markListeners.delete(listener); }; }, () => marks.has(sessionKey), () => false);
}
