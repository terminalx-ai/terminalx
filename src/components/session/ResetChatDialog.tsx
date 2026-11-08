import { useState } from "react";
import { agent, errorMessage } from "@/lib/api";
import { reloadTabHistory } from "@/lib/agentEvents";
import { refreshSessions } from "@/lib/sessions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Mounted per selection, so confirmation always names the selected turn. */
export function ResetChatDialog({ sessionId, tabId, endSeq, onClose, onWarning }: {
  sessionId: string; tabId: string; endSeq: number | null; onClose: () => void; onWarning: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = endSeq === null;
  async function reset() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const warning = await agent.resetChat(sessionId, tabId, endSeq, false);
      // Also refresh directly: the window may have missed the owner event.
      const refreshed = await Promise.allSettled([reloadTabHistory(sessionId, tabId), refreshSessions()]);
      if (warning) onWarning(warning);
      else if (refreshed.some((result) => result.status === "rejected")) onWarning("Chat reset. Reopen the tab if its history has not refreshed yet.");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent showClose={!busy}>
      <DialogHeader>
        <DialogTitle>{undo ? "Undo chat reset?" : "Reset to here?"}</DialogTitle>
        <DialogDescription>{undo
          ? "Restore the conversation saved before the last reset. Messages sent since that reset will leave this chat."
          : "Later messages will be removed from this chat and the agent’s conversation. You can undo the last reset."}</DialogDescription>
      </DialogHeader>
      <div className="my-4 space-y-2 text-sm">
        {!undo && <label className="flex items-center gap-2 text-muted-foreground"><input type="checkbox" disabled checked={false} readOnly aria-describedby="reset-files-unavailable" />Also reset files</label>}
        <p id="reset-files-unavailable" className="text-xs text-muted-foreground">Files stay as they are. Resetting files will be available when saved turn checkpoints are supported.</p>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy} onClick={() => void reset()}>{busy ? "Resetting…" : undo ? "Undo reset" : "Reset chat"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
