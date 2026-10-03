import { ask, message } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "@/lib/api";
import { deleteSession } from "@/lib/sessions";
import { confirmUncheckedDelete, reportBranchOutcome } from "@/lib/worktreeConfirm";
import type { SessionEntry } from "@/types/session";

const NOT_TRASH = "This deletes the directory; it is not moved to the Trash.";
const RETRY = "Retry";
const SESSION_ONLY = "Delete session only";
const CLOSE = "Close";

/**
 * What deleting the session's worktree would lose, read fresh. `confirmTwice`
 * is set when the worktree could not be checked at all, so "nothing to lose"
 * cannot be claimed and a second, explicit confirmation is asked for.
 */
async function worktreeDetail(session: SessionEntry): Promise<{ detail: string; confirmTwice: boolean }> {
  try {
    const disposition = await api.worktreeDisposition(session.id);
    if (!disposition.exists) return { detail: "Its worktree is already gone; its transcript and attachments are removed.", confirmTwice: false };
    if (!disposition.checked) {
      return {
        detail: `Its worktree is not a working git checkout of this project, so it cannot be checked for uncommitted or unpushed work. ${NOT_TRASH}`,
        confirmTwice: true,
      };
    }
    const parts = [];
    if (disposition.unpushed > 0) parts.push(`${disposition.unpushed} unpushed commit${disposition.unpushed === 1 ? "" : "s"}`);
    if (disposition.uncommitted > 0) parts.push(`${disposition.uncommitted} uncommitted file${disposition.uncommitted === 1 ? "" : "s"}`);
    const detail = parts.length
      ? `Its worktree has ${parts.join(" and ")}; deleting loses them along with the transcript.`
      : "Its worktree, transcript and attachments are removed.";
    return { detail: `${detail} ${NOT_TRASH}`, confirmTwice: false };
  } catch {
    // The state is unknown, so it is not presented as clean.
    return { detail: `Its worktree could not be checked for uncommitted or unpushed work. ${NOT_TRASH}`, confirmTwice: true };
  }
}

/**
 * The other sessions that run in this session's worktree, as the backend
 * matches them. Removing the worktree deletes them too, with their
 * transcripts and the agents' own data for them, so the confirmation names
 * them. `null` when the list could not be read.
 */
async function sharedSessionsNote(session: SessionEntry): Promise<string> {
  let titles: string[];
  try {
    titles = await api.sessionsSharingWorktree(session.id);
  } catch {
    return "\n\nOther sessions in the same worktree, if there are any, are deleted with it; the list could not be read.";
  }
  if (!titles.length) return "";
  const one = titles.length === 1;
  return `\n\n${one ? "This session shares" : "These sessions share"} its worktree and ${one ? "is" : "are"} deleted with it, transcripts included:\n${titles.map((title) => `• ${title}`).join("\n")}`;
}

/**
 * Ask before deleting a session, then delete it. A delete that fails (most
 * often a worktree something still holds, or a directory that is not this
 * project's to remove) is shown with its reason and the state the directory
 * was left in. From there the person can retry, which reads the worktree's
 * state again and asks again, or delete the session alone and leave the
 * directory, so a session is never stuck behind a directory that cannot go.
 */
export async function confirmDeleteSession(session: SessionEntry) {
  const hasWorktree = !!session.worktreeName && !session.worktreeRemoved;
  for (;;) {
    const { detail, confirmTwice } = hasWorktree ? await worktreeDetail(session) : { detail: "Its transcript and attachments are removed.", confirmTwice: false };
    const along = hasWorktree ? await sharedSessionsNote(session) : "";
    const yes = await ask(`Delete "${session.title}"? ${detail}${along}`, {
      title: "Delete session",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    }).catch(() => false);
    if (!yes) return;
    if (confirmTwice && !(await confirmUncheckedDelete(session.cwd))) return;
    try {
      await reportBranchOutcome(await deleteSession(session.id, true));
      return;
    } catch (error) {
      const choice = await message(
        `${errorMessage(error)}\n\n"${session.title}" is still in the list, so what remains of its worktree is not left without an owner.\n\n• ${RETRY}: close whatever is using the directory first; its state is checked again.\n• ${SESSION_ONLY}: removes this session and its transcript, and leaves the directory at ${session.cwd} on disk.`,
        { title: "Could not delete session", kind: "error", buttons: { yes: RETRY, no: SESSION_ONLY, cancel: CLOSE } },
      ).catch(() => CLOSE);
      if (choice === SESSION_ONLY) {
        try {
          await deleteSession(session.id, false);
        } catch (onlyError) {
          await message(errorMessage(onlyError), { title: "Could not delete session", kind: "error" }).catch(() => undefined);
        }
        return;
      }
      if (choice !== RETRY) return;
    }
  }
}
