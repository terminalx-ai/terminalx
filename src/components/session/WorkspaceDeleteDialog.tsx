import { useEffect, useState } from "react";
import { AlertTriangle, Check, GitMerge, GitPullRequest, Loader2, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/controls";
import { api, errorMessage } from "@/lib/api";
import { closeWorkspaceDelete, useDialogs } from "@/lib/dialogs";
import { deleteWorkspace } from "@/lib/sessions";
import type { WorkspaceDisposition } from "@/types/session";

/**
 * Deleting a workspace checks three things first: uncommitted files,
 * commits no remote has, and the pull request its branch is on. A merged
 * PR over a clean tree is the happy case and says so; anything else is
 * spelled out before the destructive button.
 */
export function WorkspaceDeleteDialog() {
  const { workspaceDelete } = useDialogs();
  const [disp, setDisp] = useState<WorkspaceDisposition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);

  useEffect(() => {
    if (!workspaceDelete) return;
    setDisp(null);
    setError(null);
    setDeleteBranch(true);
    let live = true;
    api
      .workspaceDisposition(workspaceDelete.projectPath, workspaceDelete.path)
      .then((d) => live && setDisp(d))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [workspaceDelete]);

  if (!workspaceDelete) return null;
  const pr = disp?.pr ?? null;
  const merged = pr?.state === "MERGED";
  const clean = !!disp && disp.uncommitted === 0 && disp.unpushed === 0;
  const safe = !!disp && clean && (merged || (disp.prChecked && !pr && (disp.aheadOfBase ?? 0) === 0));
  const risky = !!disp && !safe;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteWorkspace(workspaceDelete.projectPath, workspaceDelete.path, deleteBranch);
      closeWorkspaceDelete();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && closeWorkspaceDelete()}>
      <DialogContent width="max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>Delete this workspace</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">{workspaceDelete.name}</span>
            {disp?.branch && (
              <>
                {" "}
                on <span className="font-mono text-foreground">{disp.branch}</span>
              </>
            )}
            . Sessions that ran here keep their transcripts and remain identified with this removed workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 flex flex-col gap-1.5 rounded-lg bg-well px-3 py-2 text-xs">
          {!disp && !error && (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Checking the tree and its pull request…
            </span>
          )}
          {disp && (
            <>
              <Row ok={disp.uncommitted === 0} text={disp.uncommitted === 0 ? "No uncommitted changes." : `${disp.uncommitted} file${disp.uncommitted === 1 ? "" : "s"} with uncommitted changes.`} />
              <Row ok={disp.unpushed === 0} text={disp.unpushed === 0 ? "Every commit is pushed." : `${disp.unpushed} commit${disp.unpushed === 1 ? "" : "s"} not pushed anywhere.`} />
              {pr ? (
                <div className="flex items-start gap-2">
                  {merged ? <GitMerge className="mt-0.5 size-3.5 shrink-0 text-merged" /> : <GitPullRequest className={`mt-0.5 size-3.5 shrink-0 ${pr.state === "OPEN" ? "text-warning" : "text-faint"}`} />}
                  <span className="min-w-0">
                    Pull request{" "}
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => void openUrl(pr.url)}>
                      #{pr.number}
                    </button>{" "}
                    is {merged ? "merged" : pr.state === "OPEN" ? (pr.isDraft ? "still an open draft" : "still open") : "closed without merging"}.
                  </span>
                </div>
              ) : disp.prChecked ? (
                <Row ok={(disp.aheadOfBase ?? 0) === 0} text={(disp.aheadOfBase ?? 0) === 0 ? "No pull request, and nothing ahead of the default branch." : `No pull request; ${disp.aheadOfBase} commit${disp.aheadOfBase === 1 ? "" : "s"} ahead of the default branch.`} />
              ) : (
                <div className="text-faint">Pull request status not checked (no remote or the GitHub CLI is unavailable).</div>
              )}
              <div className={`mt-1 ${safe ? "text-add" : "text-warning"}`}>
                {safe ? "Merged and clean: safe to delete." : "Deleting now loses work that has not landed anywhere else."}
              </div>
            </>
          )}
          {error && <span className="text-destructive">{error}</span>}
        </div>

        {disp && !disp.isMain && disp.branch && (
          <label className="mt-3 flex items-center justify-between text-xs">
            <span>
              Also delete the branch <span className="font-mono">{disp.branch}</span>
            </span>
            <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} />
          </label>
        )}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={closeWorkspaceDelete} disabled={busy}>
            Cancel
          </Button>
          <Button variant={risky ? "destructive" : "default"} onClick={() => void run()} disabled={busy || !disp?.exists || disp.isMain}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} {risky ? "Delete anyway" : "Delete workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className="flex items-start gap-2">
      {ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-add" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />}
      <span>{text}</span>
    </div>
  );
}
