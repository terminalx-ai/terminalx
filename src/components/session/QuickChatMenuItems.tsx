import { FolderInput, FolderOpen, MessageCircle, Pencil } from "lucide-react";
import { message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { DropdownMenuItem } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api";
import { openMoveToProject, openRenameSession } from "@/lib/dialogs";
import { inScratch, isQuickChat } from "@/lib/quickChats";
import { setQuickChatCwd } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

/** Rename, for any session's menu. */
export function RenameSessionItem({ session }: { session: SessionEntry }) {
  return (
    <DropdownMenuItem onSelect={() => openRenameSession(session.id)}>
      <Pencil /> Rename…
    </DropdownMenuItem>
  );
}

/** Point a quick chat at a folder, with a word of warning when that stops a running agent. */
async function chooseFolder(session: SessionEntry) {
  try {
    const dir = await openDialog({ directory: true, multiple: false, title: "Choose a folder for this chat" });
    if (typeof dir !== "string") return;
    await setQuickChatCwd(session.id, dir);
  } catch (error) {
    await message(errorMessage(error), { title: "Could not change the working directory", kind: "error" }).catch(() => undefined);
  }
}

async function backToScratch(session: SessionEntry) {
  try {
    await setQuickChatCwd(session.id, null);
  } catch (error) {
    await message(errorMessage(error), { title: "Could not change the working directory", kind: "error" }).catch(() => undefined);
  }
}

/**
 * What only a quick chat can do: run in another folder (which does not become
 * a project), and move into a project for good. Renders nothing for an
 * ordinary session, so a menu can include it unconditionally.
 */
export function QuickChatMenuItems({ session }: { session: SessionEntry }) {
  if (!isQuickChat(session)) return null;
  return (
    <>
      <DropdownMenuItem onSelect={() => void chooseFolder(session)}>
        <FolderOpen /> Set working directory…
      </DropdownMenuItem>
      {!inScratch(session) && (
        <DropdownMenuItem onSelect={() => void backToScratch(session)}>
          <MessageCircle /> Use scratch folder
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => openMoveToProject(session.id)}>
        <FolderInput /> Move to project…
      </DropdownMenuItem>
    </>
  );
}
