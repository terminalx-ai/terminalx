import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { sortSessions, useSessionStore } from "@/lib/sessions";
import type { Project, SessionEntry } from "@/types/session";

/**
 * Quick chats: sessions with no project. Each runs in a scratch directory of
 * its own under the TerminalX home, or in a folder the reader pointed it at,
 * and has no worktree, branch or base. Everything else about one is an
 * ordinary session, so the same views draw it; this is where they ask what
 * differs.
 */
export const QUICK_CHATS_LABEL = "Quick chats";
export const QUICK_CHAT_LABEL = "Quick chat";

export function isQuickChat(session: Pick<SessionEntry, "kind">): boolean {
  return session.kind === "quick";
}

/** A quick chat's `projectPath` is its scratch directory: it runs there until it is pointed elsewhere. */
export function inScratch(session: Pick<SessionEntry, "kind" | "projectPath" | "cwd">): boolean {
  return isQuickChat(session) && trimmed(session.cwd) === trimmed(session.projectPath);
}

function trimmed(path: string): string {
  return path.replace(/\/+$/, "");
}

function baseName(path: string): string {
  return trimmed(path).split("/").pop() || path;
}

/** Where a quick chat runs, for a label: "Scratch folder", or the folder it was pointed at. */
export function quickChatPlace(session: Pick<SessionEntry, "kind" | "projectPath" | "cwd">): string {
  return inScratch(session) ? "Scratch folder" : baseName(session.cwd);
}

/**
 * The name of what a session belongs to: its project's, or "Quick chat". A
 * quick chat's path ends in its own id, which names nothing to a reader.
 */
export function sessionProjectName(session: Pick<SessionEntry, "kind" | "projectPath">, project: Pick<Project, "name"> | null | undefined): string {
  if (isQuickChat(session)) return QUICK_CHAT_LABEL;
  return project?.name ?? baseName(session.projectPath);
}

/** Quick chats in the order the sidebar and the switcher list them: pinned first, then newest. */
export function quickChatsOf(sessions: SessionEntry[], options: { archived?: boolean } = {}): SessionEntry[] {
  return sortSessions(sessions.filter((session) => isQuickChat(session) && (options.archived || !session.archived)));
}

const repositories = new Map<string, boolean>();

/**
 * Whether a session's directory is a Git repository, which is what the
 * Changes, Repo and PR surfaces need.
 *
 * Attached projects supply their kind. Ordinary Chats and other unlisted
 * local sessions need their actual working directory checked, as do quick
 * chats pointed outside their scratch folder. Cloud callers keep their
 * remote Git handling and never probe a path on this computer.
 */
export function useSessionIsGit(session: Pick<SessionEntry, "kind" | "projectPath" | "cwd">, local = true): boolean {
  const { projects, chatsPath } = useSessionStore();
  const project = projects.find((item) => item.path === session.projectPath);
  const quick = isQuickChat(session);
  const scratch = inScratch(session);
  const cwd = trimmed(session.cwd);
  const chat = chatsPath != null && trimmed(session.projectPath) === trimmed(chatsPath);
  const probe = local && !scratch && (quick || chat || !project);
  const [known, setKnown] = useState(() => ({ cwd, isRepo: repositories.get(cwd) }));
  useEffect(() => {
    if (!probe) return;
    let cancelled = false;
    setKnown({ cwd, isRepo: repositories.get(cwd) });
    api
      .workStatus(cwd)
      .then((status) => {
        repositories.set(cwd, status.isRepo);
        if (!cancelled) setKnown({ cwd, isRepo: status.isRepo });
      })
      .catch(() => {
        if (!cancelled) setKnown({ cwd, isRepo: false });
      });
    return () => {
      cancelled = true;
    };
  }, [probe, cwd]);
  if (probe) return (known.cwd === cwd ? known.isRepo : repositories.get(cwd)) === true;
  if (quick) return false;
  return project?.kind !== "folder";
}

/** Tests only. */
export function resetQuickChatRepositories() {
  repositories.clear();
}
