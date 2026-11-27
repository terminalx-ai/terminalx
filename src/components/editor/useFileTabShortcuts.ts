import { useShortcut } from "@/lib/hotkeys";
import { closeAllEditors, toggleViewMode } from "@/lib/editors";

/**
 * The file shortcuts of a session whose files are tabs: Toggle Preview acts
 * on the file tab on screen (`shown`), Close All Files closes the session's
 * file tabs and leaves its chats, diffs and pull requests.
 */
export function useFileTabShortcuts(sessionId: string, shown: string | null, enabled: boolean) {
  useShortcut(
    "files.togglePreview",
    () => {
      if (shown) toggleViewMode(shown);
    },
    { enabled: enabled && !!shown },
  );
  useShortcut("files.closeAll", () => void closeAllEditors(sessionId, true), { enabled });
}
