import { CONVERSATION_DELETION } from "@/lib/conversationRetention";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "@/lib/api";
import { openWorkspaceDelete } from "@/lib/dialogs";
import { deleteSession } from "@/lib/sessions";
import { inScratch, isQuickChat } from "@/lib/quickChats";
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
  const base = `Delete "${session.title}"? Its transcript and attachments are removed.\n\n${CONVERSATION_DELETION}`;
  if (isQuickChat(session)) {
    // A quick chat's scratch folder goes with it. Files in it are named
    // before they are deleted; an empty one needs no mention.
    const scratch = await api.quickChatScratch(session.id).catch(() => null);
    const count = scratch?.files ?? 0;
    const files = count > 0 ? `\n\nIts scratch folder holds ${count}${scratch?.more ? " or more" : ""} file${count === 1 && !scratch?.more ? "" : "s"}, which ${count === 1 && !scratch?.more ? "is" : "are"} deleted with it:\n${scratch!.path}` : "";
    const elsewhere = inScratch(session) ? "" : `\n\nThe folder it runs in (${session.cwd}) is yours and is not touched.`;
    const yes = await ask(`${base}${files}${elsewhere}`, { title: "Delete quick chat", kind: "warning", okLabel: count > 0 ? "Delete chat and files" : "Delete", cancelLabel: "Cancel" }).catch(() => false);
    if (!yes) return;
  } else if (!workspace) {
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

/**
 * Ask once, then delete several sessions (the sidebar's bulk bar, #718). As with one, each session goes and nothing
 * else: every workspace stays on disk, with whatever else runs in it. Removing a workspace too is done one at a time,
 * from its own dialog, which checks its work first. A quick chat's scratch folder goes with it. One that cannot be
 * deleted does not stop the rest; what failed is said once at the end. Resolves to whether anything was asked to go.
 */
export async function confirmDeleteSessions(sessions: SessionEntry[]): Promise<boolean> {
  if (sessions.length === 0) return false;
  if (sessions.length === 1) {
    await confirmDeleteSession(sessions[0]);
    return true;
  }
  const quick = sessions.filter(isQuickChat).length;
  const scratch = quick === 0 ? "" : quick === sessions.length
    ? "\n\nTheir scratch folders are deleted with them, and the files in them."
    : `\n\n${quick} of them ${quick === 1 ? "is a quick chat, whose scratch folder is" : "are quick chats, whose scratch folders are"} deleted with ${quick === 1 ? "it" : "them"}, and the files in ${quick === 1 ? "it" : "them"}.`;
  const workspaces = sessions.some((session) => session.worktreeName && !session.worktreeRemoved) ? " Their workspaces stay on disk." : "";
  const yes = await ask(
    `Delete ${sessions.length} sessions? Their transcripts and attachments are removed.${workspaces}\n\n${CONVERSATION_DELETION}${scratch}`,
    { title: "Delete sessions", kind: "warning", okLabel: `Delete ${sessions.length}`, cancelLabel: "Cancel" },
  ).catch(() => false);
  if (!yes) return false;
  const failed: string[] = [];
  for (const session of sessions) {
    try {
      await deleteSession(session.id);
    } catch (error) {
      failed.push(`${session.title}: ${errorMessage(error)}`);
    }
  }
  if (failed.length) {
    await message(failed.join("\n"), { title: failed.length === 1 ? "Could not delete a session" : `Could not delete ${failed.length} sessions`, kind: "error" }).catch(() => undefined);
  }
  return true;
}
