import { useSyncExternalStore } from "react";
import { archiveSession, conversationTitle, getSessions } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

/**
 * Feedback for archiving a session (PRO-386, screen 02.23): the row leaves
 * the list, and a toast says which one went and offers Restore. Before it
 * the row disappeared without a word, and nothing put it back but finding
 * Show archived.
 */
export interface ArchiveNotice {
  id: string;
  sessionId: string;
  /** The session's title as it was archived. */
  title: string;
  /** The project it is under, named on the toast's second line. */
  project: string | null;
  /** Its workspace was removed: the conversations are kept, the checkout is not. */
  workspaceRemoved: boolean;
}

/** How long Restore is offered. The project's Archived fold has the session after that. */
export const ARCHIVE_UNDO_MS = 12_000;

let notices: ArchiveNotice[] = [];
let next = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function set(list: ArchiveNotice[]) {
  notices = list;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useArchiveNotices(): ArchiveNotice[] {
  return useSyncExternalStore(subscribe, () => notices, () => notices);
}

export function getArchiveNotices(): ArchiveNotice[] {
  return notices;
}

function clearTimer(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

/** Say that this session was archived, with Restore. A newer archive of the same session takes the older one's place. */
export function offerArchiveUndo(session: SessionEntry): string {
  const id = `archive-${++next}`;
  for (const old of notices.filter((notice) => notice.sessionId === session.id)) clearTimer(old.id);
  const project = getSessions().projects.find((candidate) => candidate.path === session.projectPath)?.name ?? null;
  const notice: ArchiveNotice = { id, sessionId: session.id, title: conversationTitle(session) || "Untitled session", project, workspaceRemoved: !!session.worktreeRemoved };
  set([...notices.filter((candidate) => candidate.sessionId !== session.id), notice]);
  timers.set(id, setTimeout(() => dismissArchiveNotice(id), ARCHIVE_UNDO_MS));
  return id;
}

/** Keep a notice up until it is dismissed: its Restore is under way, and a failure must stay to be read. */
export function holdArchiveNotice(id: string) {
  clearTimer(id);
}

export function dismissArchiveNotice(id: string) {
  clearTimer(id);
  if (!notices.some((notice) => notice.id === id)) return;
  set(notices.filter((notice) => notice.id !== id));
}

/** Archive a session the reader chose to archive, and say so with Restore. Rejects as `archiveSession` does. */
export async function archiveWithUndo(sessionId: string): Promise<void> {
  await archiveSession(sessionId, true);
  const session = getSessions().sessions.find((candidate) => candidate.id === sessionId);
  if (session) offerArchiveUndo(session);
}

/** Restore: the session comes back to the list, and the notice goes. */
export async function restoreArchived(notice: ArchiveNotice): Promise<void> {
  holdArchiveNotice(notice.id);
  await archiveSession(notice.sessionId, false);
  dismissArchiveNotice(notice.id);
}
