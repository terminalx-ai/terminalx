import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FolderInput, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { closeSettle, useDialogs } from "@/lib/dialogs";
import { settleSession, useSessionStore } from "@/lib/sessions";
import { confirmUncheckedDelete, reportBranchOutcome } from "@/lib/worktreeConfirm";
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

  // `checkFailed` is a disposition that could not be read at all: the tree is
  // then as unknown as one git cannot check.
  const [checkFailed, setCheckFailed] = useState(false);

  const check = useCallback(async (id: string, isLive: () => boolean = () => true) => {
    setDisp(null);
    setCheckFailed(false);
    try {
      const d = await api.worktreeDisposition(id);
      if (isLive()) setDisp(d);
    } catch (e) {
      if (!isLive()) return;
      setCheckFailed(true);
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (!settleFor) return;
    setError(null);
    let live = true;
    void check(settleFor, () => live);
    return () => {
      live = false;
    };
  }, [settleFor, check]);

  // A tree that could not be checked is treated as holding work.
  const unchecked = checkFailed || (!!disp && disp.exists && !disp.checked);
  const risky = unchecked || (!!disp && (disp.unpushed > 0 || disp.uncommitted > 0));
  // Deleting waits until the tree's state is known, one way or the other.
  const known = !!disp || checkFailed;

  const run = async (action: "delete" | "relocate") => {
    if (!settleFor) return;
    if (action === "delete" && unchecked && !(await confirmUncheckedDelete(session?.cwd ?? "this session's worktree"))) return;
    setBusy(action);
    setError(null);
    try {
      const report = await settleSession(settleFor, action);
      closeSettle();
      await reportBranchOutcome(report);
    } catch (e) {
      // The tree may have changed, or been partly removed: read it again
      // before the next attempt is offered.
      await check(settleFor);
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

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
          {checkFailed && (
            <div className="flex items-start gap-2 text-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <div>The worktree could not be checked for uncommitted or unpushed work.</div>
            </div>
          )}
          {disp?.exists && risky && (
            <div className="flex items-start gap-2 text-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <div>
                {unchecked && <div>This folder is not a working git checkout of this project, so it cannot be checked for uncommitted or unpushed work.</div>}
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
                <div className="mt-1 text-muted-foreground">
                  {unchecked ? "Deleting it loses any files in it that are not saved elsewhere. Its branch is kept if it holds commits nothing else has." : "Deleting the worktree loses them. Push or commit first, or move the session instead."}
                </div>
              </div>
            </div>
          )}
          {error && <div className="mt-1 text-destructive">{error}</div>}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={closeSettle} disabled={!!busy}>
            Keep as is
          </Button>
          <Button variant="outline" onClick={() => void run("relocate")} disabled={!!busy || !session?.worktreeName}>
            {busy === "relocate" ? <Loader2 className="animate-spin" /> : <FolderInput />} Move session to project
          </Button>
          <Button variant={risky ? "destructive" : "default"} onClick={() => void run("delete")} disabled={!!busy || !known || !session?.worktreeName}>
            {busy === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />} {risky ? "Delete anyway" : "Delete worktree"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
