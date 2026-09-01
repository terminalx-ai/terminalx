import { useEffect, useState } from "react";
import { AlertTriangle, FolderInput, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { closeSettle, useDialogs } from "@/lib/dialogs";
import { settleSession, useSessionStore } from "@/lib/sessions";
import type { WorktreeDisposition } from "@/types/session";

/**
 * What to do with a session's worktree once its work has landed. Deleting
 * warns about commits that never left the machine and files never committed;
 * relocating keeps the tree on disk but runs the session in the project
 * itself from now on.
 */
export function SettleDialog() {
  const { settleFor } = useDialogs();
  const store = useSessionStore();
  const session = store.sessions.find((s) => s.id === settleFor);
  const [disp, setDisp] = useState<WorktreeDisposition | null>(null);
  const [busy, setBusy] = useState<"delete" | "relocate" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settleFor) return;
    setDisp(null);
    setError(null);
    let live = true;
    api
      .worktreeDisposition(settleFor)
      .then((d) => live && setDisp(d))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [settleFor]);

  const run = async (action: "delete" | "relocate") => {
    if (!settleFor) return;
    setBusy(action);
    setError(null);
    try {
      await settleSession(settleFor, action);
      closeSettle();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const risky = !!disp && (disp.unpushed > 0 || disp.uncommitted > 0);

  return (
    <Dialog open={!!settleFor} onOpenChange={(o) => !o && closeSettle()}>
      <DialogContent width="max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>Settle this worktree</DialogTitle>
          <DialogDescription>
            {session ? (
              <>
                <span className="text-foreground">{session.title}</span> works in{" "}
                <span className="font-mono text-foreground">{session.worktreeName ?? "a worktree"}</span> on{" "}
                <span className="font-mono text-foreground">{session.branch ?? "its branch"}</span>.
              </>
            ) : (
              "This session has no worktree."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 rounded-lg bg-well px-3 py-2 text-xs">
          {!disp && !error && (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Checking the tree…
            </span>
          )}
          {disp && !disp.exists && <span className="text-muted-foreground">The worktree folder is already gone.</span>}
          {disp?.exists && !risky && <span className="text-muted-foreground">Everything is committed and pushed. Safe to delete.</span>}
          {disp?.exists && risky && (
            <div className="flex items-start gap-2 text-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <div>
                {disp.unpushed > 0 && (
                  <div>
                    {disp.unpushed} commit{disp.unpushed === 1 ? "" : "s"} on this branch {disp.unpushed === 1 ? "has" : "have"} not been pushed anywhere.
                  </div>
                )}
                {disp.uncommitted > 0 && (
                  <div>
                    {disp.uncommitted} file{disp.uncommitted === 1 ? "" : "s"} {disp.uncommitted === 1 ? "has" : "have"} uncommitted changes.
                  </div>
                )}
                <div className="mt-1 text-muted-foreground">Deleting the worktree loses them. Push or commit first, or move the session instead.</div>
              </div>
            </div>
          )}
          {error && <span className="text-destructive">{error}</span>}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={closeSettle} disabled={!!busy}>
            Keep as is
          </Button>
          <Button variant="outline" onClick={() => void run("relocate")} disabled={!!busy || !session?.worktreeName}>
            {busy === "relocate" ? <Loader2 className="animate-spin" /> : <FolderInput />} Move session to project
          </Button>
          <Button variant={risky ? "destructive" : "default"} onClick={() => void run("delete")} disabled={!!busy || !session?.worktreeName}>
            {busy === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />} {risky ? "Delete anyway" : "Delete worktree"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
