import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "@/lib/api";
import { deleteSession } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

/**
 * Ask before deleting a session, then delete it. A delete that fails (most
 * often a worktree something still holds) is shown with its reason and can be
 * retried; the session stays in the list until it really is gone.
 */
export async function confirmDeleteSession(session: SessionEntry) {
  const hasWorktree = !!session.worktreeName && !session.worktreeRemoved;
  let detail = "Its transcript and attachments are removed.";
  if (hasWorktree) {
    detail = "Its worktree, transcript and attachments are removed.";
    try {
      const disposition = await api.worktreeDisposition(session.id);
      const parts = [];
      if (disposition.unpushed > 0) parts.push(`${disposition.unpushed} unpushed commit${disposition.unpushed === 1 ? "" : "s"}`);
      if (disposition.uncommitted > 0) parts.push(`${disposition.uncommitted} uncommitted file${disposition.uncommitted === 1 ? "" : "s"}`);
      if (parts.length) detail = `Its worktree has ${parts.join(" and ")}; deleting loses them along with the transcript.`;
    } catch {
      // The confirmation still protects the destructive action if status fails.
    }
    detail += " This deletes the directory; it is not moved to the Trash.";
  }
  const yes = await ask(`Delete "${session.title}"? ${detail}`, {
    title: "Delete session",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  }).catch(() => false);
  if (!yes) return;
  for (;;) {
    try {
      await deleteSession(session.id, true);
      return;
    } catch (error) {
      const retry = await ask(
        `${errorMessage(error)}\n\nNothing was deleted and "${session.title}" was kept, so the directory is not left behind. Close whatever is still using it, then retry.`,
        { title: "Could not delete session", kind: "error", okLabel: "Retry", cancelLabel: "Keep session" },
      ).catch(() => false);
      if (!retry) return;
    }
  }
}
