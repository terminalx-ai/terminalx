import { ask, message } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "@/lib/api";
import { openWorkspaceDelete } from "@/lib/dialogs";
import { deleteSession } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

const SESSION_ONLY = "Delete session";
const WITH_WORKSPACE = "Also delete the workspace…";
const CANCEL = "Cancel";

/**
 * Ask before deleting a session, then delete it. Deleting a session deletes
 * that session and nothing else: its workspace stays, and so does every
 * other session in it.
 *
 * When it is the last session in its workspace, the dialog also offers to
 * delete the workspace. That is not done here: it opens the same workspace
 * dialog as everywhere else, which checks that the work is clean and merged
 * and names what goes.
 */
export async function confirmDeleteSession(session: SessionEntry) {
  let workspace: string | null = null;
  if (session.worktreeName && !session.worktreeRemoved) {
    // Asked of the backend, which matches sessions to a workspace the way
    // the removal does. If it cannot say, the workspace is left alone.
    workspace = await api.soleWorkspaceOf(session.id).catch(() => null);
  }
  const base = `Delete "${session.title}"? Its transcript and attachments are removed.`;
  if (!workspace) {
    const stays = session.worktreeName && !session.worktreeRemoved ? ` Its workspace ${session.worktreeName} stays, with the other sessions in it.` : "";
    const yes = await ask(`${base}${stays}`, { title: "Delete session", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" }).catch(() => false);
    if (!yes) return;
  } else {
    const choice = await message(
      `${base}\n\nIt is the last session in the workspace ${session.worktreeName}. Deleting only the session leaves the workspace on disk, listed with no sessions.`,
      { title: "Delete session", kind: "warning", buttons: { yes: SESSION_ONLY, no: WITH_WORKSPACE, cancel: CANCEL } },
    ).catch(() => CANCEL);
    if (choice === WITH_WORKSPACE) {
      openWorkspaceDelete(session.projectPath, workspace, session.worktreeName ?? workspace);
      return;
    }
    if (choice !== SESSION_ONLY) return;
  }
  try {
    await deleteSession(session.id);
  } catch (error) {
    await message(errorMessage(error), { title: "Could not delete session", kind: "error" }).catch(() => undefined);
  }
}
