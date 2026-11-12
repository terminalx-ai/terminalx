import { useState } from "react";
import { agent, errorMessage } from "@/lib/api";
import { reloadTabHistory } from "@/lib/agentEvents";
import { usePref } from "@/lib/prefs";
import { refreshSessions } from "@/lib/sessions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Starts the backend's refusal when restoring files would overwrite other changes (session_reset.rs `OVERLAP`). */
const OVERLAP = "Other changes to these files would be overwritten: ";

/** The paths in an overlap refusal, or null for any other error. */
export function overlapPaths(message: string): string[] | null {
  const at = message.indexOf(OVERLAP);
  if (at < 0) return null;
  const rest = message.slice(at + OVERLAP.length);
  try {
    const paths: unknown = JSON.parse(rest.slice(0, rest.lastIndexOf("]") + 1));
    return Array.isArray(paths) && paths.every((path) => typeof path === "string") ? paths : null;
  } catch {
    return null;
  }
}

const SHOWN = 5;

/** Mounted per selection, so confirmation always names the selected turn. */
export function ResetChatDialog({ sessionId, tabId, endSeq, filesRestored, onClose, onWarning }: {
  sessionId: string; tabId: string; endSeq: number | null;
  /** Undo only: how many files the reset being undone restored. */
  filesRestored?: number;
  onClose: () => void; onWarning: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlap, setOverlap] = useState<string[] | null>(null);
  const [resetFiles, setResetFiles] = usePref("resetFiles");
  const undo = endSeq === null;
  const withFiles = undo ? !!filesRestored : resetFiles;
  async function reset() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Asking again after the overlap warning, with nothing changed since, confirms it.
      const warning = await agent.resetChat(sessionId, tabId, endSeq, !undo && resetFiles);
      // Also refresh directly: the window may have missed the owner event.
      const refreshed = await Promise.allSettled([reloadTabHistory(sessionId, tabId), refreshSessions()]);
      if (warning) onWarning(warning);
      else if (refreshed.some((result) => result.status === "rejected")) onWarning("Chat reset. Reopen the tab if its history has not refreshed yet.");
      onClose();
    } catch (e) {
      const message = errorMessage(e);
      const paths = withFiles ? overlapPaths(message) : null;
      setOverlap(paths);
      if (!paths) setError(message);
    } finally {
      setBusy(false);
    }
  }
  const action = undo ? "Undo reset" : "Reset chat";
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent showClose={!busy}>
      <DialogHeader>
        <DialogTitle>{undo ? "Undo chat reset?" : "Reset to here?"}</DialogTitle>
        <DialogDescription>{undo
          ? `Restore the conversation saved before the last reset. Messages sent since that reset will leave this chat.${filesRestored ? ` The ${filesRestored === 1 ? "file it restored goes" : `${filesRestored} files it restored go`} back to how ${filesRestored === 1 ? "it was" : "they were"} before the reset.` : ""}`
          : "Later messages will be removed from this chat and the agent’s conversation. You can undo the last reset."}</DialogDescription>
      </DialogHeader>
      <div className="my-4 space-y-2 text-sm">
        {!undo && <>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={resetFiles} disabled={busy} aria-describedby="reset-files-hint"
              onChange={(e) => { setResetFiles(e.target.checked); setOverlap(null); setError(null); }} />
            Also reset files
          </label>
          <p id="reset-files-hint" className="pl-6 text-xs text-muted-foreground">{resetFiles
            ? "Files changed since this turn go back to how they were when it ended."
            : "Files stay as they are."}</p>
        </>}
        {overlap && <div role="alert" className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs">
          <p>{overlap.length === 1 ? "This file was" : `${overlap.length} files were`} changed by another chat or by hand since {undo ? "the reset" : "this turn"}:</p>
          <ul className="my-1.5 space-y-0.5 font-mono">
            {overlap.slice(0, SHOWN).map((path) => <li key={path} className="truncate" title={path}>{path}</li>)}
            {overlap.length > SHOWN && <li className="font-sans text-muted-foreground">and {overlap.length - SHOWN} more</li>}
          </ul>
          <p>{undo ? "Undoing the reset" : "Resetting files"} removes those changes too.</p>
        </div>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy} onClick={() => void reset()}>{busy ? "Resetting…" : overlap ? `${undo ? "Undo" : "Reset"} anyway` : action}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
