import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, FolderInput, GitMerge, GitPullRequest, Loader2, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/controls";
import { api, errorMessage } from "@/lib/api";
import { closeWorkspaceRemove, useDialogs } from "@/lib/dialogs";
import { relocateSession, removeWorkspace } from "@/lib/sessions";
import { confirmRiskyRemoval, reportBranchOutcome } from "@/lib/worktreeConfirm";
import type { Landed, WorkspaceDisposition } from "@/types/session";

const MERGED_HOW: Record<NonNullable<Landed["merged"]>, string> = {
  ancestor: "is in",
  rebase: "was rebased into",
  squash: "was squash-merged into",
  noChanges: "changes nothing relative to",
};

/**
 * The one dialog for removing a workspace, whichever way it was started: the
 * workspace menu, the right panel, settling, or deleting a workspace's last
 * session. A workspace owns its sessions, so deleting it deletes them, and
 * they are named. Settling removes the workspace too but keeps the
 * conversations, because the work has landed.
 *
 * One check decides how much confirmation is needed: the workspace is safe
 * when it is clean and its work is merged into the default branch. Then the
 * button here is the only confirmation. Otherwise what would be lost is
 * listed and a second, explicit confirmation is asked.
 */
export function WorkspaceRemoveDialog() {
  const { workspaceRemove: request } = useDialogs();
  const [disp, setDisp] = useState<WorkspaceDisposition | null>(null);
  // The check itself failed: the workspace is then as unknown as one that
  // could not be verified.
  const [checkFailed, setCheckFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"remove" | "relocate" | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);

  const check = useCallback(async (projectPath: string, path: string, isLive: () => boolean = () => true) => {
    setDisp(null);
    setCheckFailed(false);
    try {
      // The one caller that fetches: the answer decides whether this
      // workspace can go with a single confirmation.
      const d = await api.workspaceDisposition(projectPath, path, { fetch: true });
      if (isLive()) setDisp(d);
    } catch (e) {
      if (!isLive()) return;
      setCheckFailed(true);
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (!request) return;
    setError(null);
    setDeleteBranch(true);
    let live = true;
    void check(request.projectPath, request.path, () => live);
    return () => {
      live = false;
    };
  }, [request, check]);

  if (!request) return null;
  const settle = request.mode === "settle";
  const landed = disp?.landed ?? null;
  const gone = !!disp && !disp.exists;
  const safe = gone || !!landed?.safe;
  const known = !!disp || checkFailed;
  const risky = known && !safe;
  const losses = landed?.losses ?? [];
  const pr = disp?.pr ?? null;
  const verb = settle ? "Settle" : "Delete";

  const remove = async () => {
    if (risky && !(await confirmRiskyRemoval(request.path, losses))) return;
    setBusy("remove");
    setError(null);
    try {
      const report = await removeWorkspace(request.projectPath, request.path, { keepSessions: settle, deleteBranch, confirmedRisky: risky });
      closeWorkspaceRemove();
      await reportBranchOutcome(report);
    } catch (e) {
      // It may have changed since it was checked, or been partly removed:
      // read it again before the next attempt is offered.
      await check(request.projectPath, request.path);
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const relocate = async () => {
    if (!request.sessionId) return;
    setBusy("relocate");
    setError(null);
    try {
      await relocateSession(request.sessionId);
      closeWorkspaceRemove();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && closeWorkspaceRemove()}>
      <DialogContent width="max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>{settle ? "Settle this workspace" : "Delete this workspace"}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">{request.name}</span>
            {disp?.branch && (
              <>
                {" "}
                on <span className="font-mono text-foreground">{disp.branch}</span>
              </>
            )}
            .{" "}
            {settle
              ? "Settling is for work that has landed: the workspace is removed and its sessions are kept, with their conversations, and run in the project from now on. Deleting the workspace instead would delete its sessions too."
              : "A workspace owns its sessions: they are stopped and deleted with it, transcripts included."}{" "}
            The directory is deleted; it is not moved to the Trash.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 flex flex-col gap-1.5 rounded-lg bg-well px-3 py-2 text-xs">
          {!known && (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Fetching the default branch and checking the workspace…
            </span>
          )}
          {checkFailed && <Row ok={false} text="The workspace could not be checked for uncommitted or unmerged work." />}
          {gone && <span className="text-muted-foreground">The workspace folder is already gone.</span>}
          {disp?.exists && (
            <>
              <SessionsRow count={disp.sessions} titles={disp.sessionTitles ?? []} kept={settle} />
              {landed?.checked && (
                <>
                  <Row ok={landed.clean} text={landed.clean ? "Clean: nothing uncommitted, untracked or stashed." : "Not clean."} />
                  <Row
                    ok={!!landed.merged && !landed.notVerified}
                    text={
                      landed.merged
                        ? `Merged: the branch ${MERGED_HOW[landed.merged]} ${landed.base ?? "the default branch"}${landed.notVerified ? ", as far as could be checked" : ""}.`
                        : `Not merged into ${landed.base ?? "the default branch"}.`
                    }
                  />
                </>
              )}
              {losses.length > 0 && (
                <ul aria-label="What would be lost" className="ml-5 list-disc text-warning">
                  {losses.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {pr ? (
                <div className="flex items-start gap-2">
                  {pr.state === "MERGED" ? <GitMerge className="mt-0.5 size-3.5 shrink-0 text-merged" /> : <GitPullRequest className={`mt-0.5 size-3.5 shrink-0 ${pr.state === "OPEN" ? "text-warning" : "text-faint"}`} />}
                  <span className="min-w-0">
                    Pull request{" "}
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => void openUrl(pr.url)}>
                      #{pr.number}
                    </button>{" "}
                    is {pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? (pr.isDraft ? "still an open draft" : "still open") : "closed without merging"}.
                  </span>
                </div>
              ) : null}
              <div className={`mt-1 ${safe ? "text-add" : "text-warning"}`}>
                {safe ? "Clean and merged: safe to remove." : "Removing it now needs a second confirmation."}
              </div>
            </>
          )}
          {error && <div className="whitespace-pre-line text-destructive">{error}</div>}
        </div>

        {disp?.exists && !disp.isMain && disp.branch && (
          <label className="mt-3 flex items-center justify-between text-xs">
            <span>
              Also delete the branch <span className="font-mono">{disp.branch}</span>
            </span>
            <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} />
          </label>
        )}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={closeWorkspaceRemove} disabled={!!busy}>
            {settle ? "Keep as is" : "Cancel"}
          </Button>
          {settle && request.sessionId && (
            <Button variant="outline" onClick={() => void relocate()} disabled={!!busy}>
              {busy === "relocate" ? <Loader2 className="animate-spin" /> : <FolderInput />} Move session to project
            </Button>
          )}
          <Button variant={risky ? "destructive" : "default"} onClick={() => void remove()} disabled={!!busy || !known || !!disp?.isMain}>
            {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />} {risky ? `${verb} anyway…` : `${verb} workspace`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The sessions in the workspace, by name, and what happens to them. Not a warning: it is what was asked for. */
function SessionsRow({ count, titles, kept }: { count: number; titles: string[]; kept: boolean }) {
  const many = count !== 1;
  const text =
    count === 0
      ? "No sessions run here."
      : kept
        ? `${count} session${many ? "s are" : " is"} kept and move${many ? "" : "s"} to the project${titles.length ? ":" : "."}`
        : `${count} session${many ? "s" : ""} and ${many ? "their" : "its"} transcripts will be deleted${titles.length ? ":" : "."}`;
  return (
    <div className="flex items-start gap-2">
      <Trash2 className={`mt-0.5 size-3.5 shrink-0 ${count === 0 || kept ? "text-faint" : "text-muted-foreground"}`} />
      <div className="min-w-0">
        <div>{text}</div>
        {titles.length > 0 && (
          <ul aria-label="Sessions in this workspace" className="mt-0.5 max-h-24 overflow-y-auto scrollbar-thin text-muted-foreground">
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
