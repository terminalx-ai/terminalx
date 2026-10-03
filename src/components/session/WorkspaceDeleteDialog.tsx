import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, GitMerge, GitPullRequest, Loader2, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/controls";
import { api, errorMessage } from "@/lib/api";
import { closeWorkspaceDelete, useDialogs } from "@/lib/dialogs";
import { deleteWorkspace } from "@/lib/sessions";
import { confirmUncheckedDelete, reportBranchOutcome } from "@/lib/worktreeConfirm";
import type { WorkspaceDisposition } from "@/types/session";

/**
 * Deleting a workspace checks three things first: uncommitted files,
 * commits no remote has, and the pull request its branch is on. A merged
 * PR over a clean tree is the happy case and says so; anything else is
 * spelled out before the destructive button. The sessions that ran in the
 * workspace go with it, transcripts included, so their count is shown too.
 */
export function WorkspaceDeleteDialog() {
  const { workspaceDelete } = useDialogs();
  const [disp, setDisp] = useState<WorkspaceDisposition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);

  const check = useCallback(async (projectPath: string, path: string, isLive: () => boolean = () => true) => {
    setDisp(null);
    try {
      const d = await api.workspaceDisposition(projectPath, path);
      if (isLive()) setDisp(d);
    } catch (e) {
      if (isLive()) setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (!workspaceDelete) return;
    setError(null);
    setDeleteBranch(true);
    let live = true;
    void check(workspaceDelete.projectPath, workspaceDelete.path, () => live);
    return () => {
      live = false;
    };
  }, [workspaceDelete, check]);

  if (!workspaceDelete) return null;
  const pr = disp?.pr ?? null;
  const merged = pr?.state === "MERGED";
  // A directory that could not be checked is never called clean.
  const unchecked = !!disp && disp.exists && !disp.checked;
  const clean = !!disp && !unchecked && disp.uncommitted === 0 && disp.unpushed === 0;
  const safe = !!disp && clean && (merged || (disp.prChecked && !pr && (disp.aheadOfBase ?? 0) === 0));
  const risky = !!disp && !safe;

  const run = async () => {
    // A directory that could not be checked needs the same second, explicit
    // confirmation as deleting its session from the sidebar.
    if (unchecked && !(await confirmUncheckedDelete(workspaceDelete.path))) return;
    setBusy(true);
    setError(null);
    try {
      const report = await deleteWorkspace(workspaceDelete.projectPath, workspaceDelete.path, deleteBranch);
      closeWorkspaceDelete();
      await reportBranchOutcome(report);
    } catch (e) {
      // It may have changed, or been partly removed: read it again before
      // the next attempt is offered.
      await check(workspaceDelete.projectPath, workspaceDelete.path);
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
            . Every session that ran here is stopped and removed, along with its transcripts. This deletes the directory; it is not moved to the Trash.
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
              <SessionsRow count={disp.sessions} titles={disp.sessionTitles ?? []} />
              {unchecked ? (
                <Row ok={false} text="This folder is not a working git checkout of this project, so it cannot be checked for uncommitted or unpushed work." />
              ) : (
                <>
                  <Row ok={disp.uncommitted === 0} text={disp.uncommitted === 0 ? "No uncommitted changes." : `${disp.uncommitted} file${disp.uncommitted === 1 ? "" : "s"} with uncommitted changes.`} />
                  <Row ok={disp.unpushed === 0} text={disp.unpushed === 0 ? "Every commit is pushed." : `${disp.unpushed} commit${disp.unpushed === 1 ? "" : "s"} not pushed anywhere.`} />
                </>
              )}
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

/** The sessions the deletion takes with it, by name. Not a warning: it is what was asked for. */
function SessionsRow({ count, titles }: { count: number; titles: string[] }) {
  const text = count === 0 ? "No sessions ran here." : `${count} session${count === 1 ? "" : "s"} and ${count === 1 ? "its" : "their"} transcripts will be removed${titles.length ? ":" : "."}`;
  return (
    <div className="flex items-start gap-2">
      <Trash2 className={`mt-0.5 size-3.5 shrink-0 ${count === 0 ? "text-faint" : "text-muted-foreground"}`} />
      <div className="min-w-0">
        <div>{text}</div>
        {titles.length > 0 && (
          <ul className="mt-0.5 max-h-24 overflow-y-auto scrollbar-thin text-muted-foreground">
            {titles.map((title, i) => (
              <li key={`${i}-${title}`} className="truncate">
                {title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
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
