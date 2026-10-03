import { ask, message } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "@/lib/api";
import { deleteSession } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

const NOT_TRASH = "This deletes the directory; it is not moved to the Trash.";

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
        detail: `Its worktree is no longer a working git checkout, so it cannot be checked for uncommitted or unpushed work. ${NOT_TRASH}`,
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
 * Ask before deleting a session, then delete it. A delete that fails (most
 * often a worktree something still holds) is shown with its reason and the
 * state the directory was left in, and can be retried. Every attempt reads
 * the worktree's state again and asks again, so work that appeared since the
 * first confirmation is never deleted on the strength of the old answer.
 */
export async function confirmDeleteSession(session: SessionEntry) {
  const hasWorktree = !!session.worktreeName && !session.worktreeRemoved;
  for (;;) {
    const { detail, confirmTwice } = hasWorktree ? await worktreeDetail(session) : { detail: "Its transcript and attachments are removed.", confirmTwice: false };
    const yes = await ask(`Delete "${session.title}"? ${detail}`, {
      title: "Delete session",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    }).catch(() => false);
    if (!yes) return;
    if (confirmTwice) {
      const sure = await ask(
        `Nothing can confirm that "${session.title}" has no unsaved work. Any files in its worktree that are not saved elsewhere will be lost for good. Its branch is kept if it holds commits nothing else has.`,
        { title: "Delete without checking?", kind: "warning", okLabel: "Delete anyway", cancelLabel: "Cancel" },
      ).catch(() => false);
      if (!sure) return;
    }
    try {
      const report = await deleteSession(session.id, true);
      if (report?.keptBranch) {
        await message(`The branch ${report.keptBranch} was kept: it holds commits that no other branch, remote or tag has.`, {
          title: "Branch kept",
          kind: "info",
        }).catch(() => undefined);
      }
      return;
    } catch (error) {
      const retry = await ask(
        `${errorMessage(error)}\n\n"${session.title}" is still in the list, so what remains of its worktree is not left without an owner. Close whatever is still using the directory, then retry; its state is checked again first.`,
        { title: "Could not delete session", kind: "error", okLabel: "Retry", cancelLabel: "Close" },
      ).catch(() => false);
      if (!retry) return;
    }
  }
}
