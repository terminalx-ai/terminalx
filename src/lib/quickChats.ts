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
 * A project session asks its project, as it always has (a project is a
 * repository unless it was attached as a plain folder). A quick chat has no
 * project to ask: its scratch directory never is one, and a folder it was
 * pointed at is read once and remembered.
 */
export function useSessionIsGit(session: Pick<SessionEntry, "kind" | "projectPath" | "cwd">): boolean {
  const projects = useSessionStore().projects;
  const quick = isQuickChat(session);
  const scratch = inScratch(session);
  const cwd = trimmed(session.cwd);
  const [known, setKnown] = useState<boolean | undefined>(() => repositories.get(cwd));
  useEffect(() => {
    if (!quick || scratch) return;
    let cancelled = false;
    setKnown(repositories.get(cwd));
    api
      .workStatus(cwd)
      .then((status) => {
        repositories.set(cwd, status.isRepo);
        if (!cancelled) setKnown(status.isRepo);
      })
      .catch(() => {
        if (!cancelled) setKnown(false);
      });
    return () => {
      cancelled = true;
    };
  }, [quick, scratch, cwd]);
  if (!quick) return projects.find((project) => project.path === session.projectPath)?.kind !== "folder";
  return !scratch && known === true;
}

/** Tests only. */
export function resetQuickChatRepositories() {
  repositories.clear();
}
