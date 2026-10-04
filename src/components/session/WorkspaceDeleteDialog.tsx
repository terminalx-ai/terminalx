import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/controls";
import { api, errorMessage } from "@/lib/api";
import { closeWorkspaceDelete, useDialogs } from "@/lib/dialogs";
import { deleteSession, deleteWorkspace, settleSession } from "@/lib/sessions";
import { reportBranchOutcome } from "@/lib/worktreeConfirm";
import type { WorkspaceDisposition } from "@/types/session";

export function WorkspaceDeleteDialog() {
  const { workspaceDelete } = useDialogs();
  return workspaceDelete ? <WorkspaceRemovalDialog key={`${workspaceDelete.path}:${workspaceDelete.sessionId ?? "workspace"}`} {...workspaceDelete}
    intent={workspaceDelete.sessionId ? "session" : "delete"} onClose={closeWorkspaceDelete} /> : null;
}

/** One confirmation for every local workspace removal, including settlement. */
export function WorkspaceRemovalDialog({ projectPath, path, name, sessionId, intent, onClose }: {
  projectPath: string; path: string; name: string; sessionId?: string;
  intent: "delete" | "settle" | "session"; onClose: () => void;
}) {
  const [disp, setDisp] = useState<WorkspaceDisposition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [alsoWorkspace, setAlsoWorkspace] = useState(false);
  const [confirmingUnsafe, setConfirmingUnsafe] = useState(false);
  const removingWorkspace = intent !== "session" || alsoWorkspace;
  const risky = disp?.safe !== true;

  const check = useCallback(async (isLive: () => boolean = () => true) => {
    setDisp(null);
    try {
      const result = await api.workspaceDisposition(projectPath, path);
      if (isLive()) setDisp(result);
    } catch (e) {
      if (isLive()) setError(errorMessage(e));
    }
  }, [projectPath, path]);

  useEffect(() => {
    setError(null);
    setDeleteBranch(true);
    setAlsoWorkspace(false);
    setConfirmingUnsafe(false);
    let live = true;
    // Deleting a conversation at the root needs no workspace check.
    if (intent !== "session" || path !== projectPath) void check(() => live);
    return () => { live = false; };
  }, [check, intent, path, projectPath, sessionId]);

  const run = async (relocate = false) => {
    if (!relocate && removingWorkspace && risky && !confirmingUnsafe) {
      setConfirmingUnsafe(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const report = intent === "settle" && sessionId
        ? await settleSession(sessionId, relocate ? "relocate" : "delete", !relocate && confirmingUnsafe)
        : intent === "session" && sessionId
          ? await deleteSession(sessionId, alsoWorkspace, alsoWorkspace && confirmingUnsafe)
          : await deleteWorkspace(projectPath, path, deleteBranch, confirmingUnsafe);
      onClose();
      await reportBranchOutcome(report);
    } catch (e) {
      setConfirmingUnsafe(false);
      if (removingWorkspace) await check();
      setError(errorMessage(e));
    } finally { setBusy(false); }
  };

  const label = intent === "settle" ? "Settle and delete workspace" : intent === "session"
    ? alsoWorkspace ? "Delete session and workspace" : "Delete session" : "Delete workspace";
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent width="max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>{confirmingUnsafe ? "Confirm permanent removal" : intent === "settle" ? "Settle this workspace" : intent === "session" ? "Delete this session" : "Delete this workspace"}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">{name}</span>.{" "}
            {intent === "settle"
              ? "Settle after your work has landed: keep every conversation and move future work to the project root. Delete workspace instead removes its sessions and transcripts."
              : intent === "session" ? "Only this session and its transcripts and attachments will be deleted."
                : "Every session in this workspace is stopped and deleted, including its transcripts and attachments."}
            {removingWorkspace && " The workspace directory is permanently deleted, not moved to the Trash."}
          </DialogDescription>
        </DialogHeader>

        {intent === "session" && disp && !disp.isMain && disp.sessions === 1 && (
          <label className="mt-3 flex items-center justify-between gap-3 text-xs">
            <span>Also delete the workspace (this is its last session)</span>
            <Switch aria-label="Also delete the workspace" checked={alsoWorkspace} disabled={busy || confirmingUnsafe} onCheckedChange={setAlsoWorkspace} />
          </label>
        )}
        {intent === "session" && disp && disp.sessions > 1 && !disp.isMain &&
          <p className="text-xs text-muted-foreground">Other sessions use this workspace. It will remain on disk.</p>}

        {removingWorkspace && <div className="mt-3 flex flex-col gap-2 rounded-lg bg-well px-3 py-2 text-xs">
          {!disp && !error && <span className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Fetching the default branch and checking the workspace…</span>}
          {disp && <>
            <div>{disp.sessions} session{disp.sessions === 1 ? "" : "s"} will be {intent === "settle" ? "kept at the project root" : "deleted with their transcripts"}:</div>
            {(disp.sessionTitles ?? []).length > 0 && <ul className="max-h-24 overflow-auto">{(disp.sessionTitles ?? []).map((title, i) => <li key={i}>{title}</li>)}</ul>}
            <div>Branch: <span className="font-mono">{disp.branch ?? "detached / unknown"}</span>{intent !== "delete" && disp.branch ? " (the local branch will also be deleted)" : ""}</div>
            <Row ok={disp.checked && disp.uncommitted === 0} text={disp.checked
              ? `${disp.uncommitted} uncommitted or untracked files${disp.uncommitted ? " will be lost" : ""}.`
              : "Uncommitted and untracked files could not be checked."} />
            <Row ok={disp.checked && !disp.stashes} text={disp.checked ? `${disp.stashes ?? 0} repository stash entries${disp.stashes ? ": kept, but review them first; Git cannot reliably identify which workspace made them" : ""}.` : "Stash entries could not be checked."} />
            <Row ok={disp.merged === true} text={disp.merged === true
              ? `Merged into ${disp.defaultBranch ?? "the default branch"} (including squash or rebase merges).`
              : `${disp.aheadOfBase ?? "Unknown number of"} commits not in ${disp.defaultBranch ?? "the default branch"}.`} />
            <div>{disp.pushed === true ? "Branch commits are pushed." : disp.pushed === false ? `Branch is not fully pushed (${disp.unpushed} unpushed commits).` : "Push status not verified."}</div>
            {disp.pr && <div>Pull request <button className="underline" onClick={() => void openUrl(disp.pr!.url)}>#{disp.pr.number}: {disp.pr.title}</button> is {disp.pr.state.toLowerCase()}.</div>}
            {!disp.prChecked && <div className="text-muted-foreground">Pull request status could not be checked.</div>}
            {disp.verificationError && <div role="alert">Not verified: {disp.verificationError}</div>}
            <div className={risky ? "text-warning" : "text-add"}>{risky
              ? "Review the work above. Deleting discards unsaved files; deleting the branch also removes its local reference to unmerged commits."
              : "Merged and clean: safe to delete."}</div>
          </>}
        </div>}
        {error && <div role="alert" className="text-xs text-destructive">{error}</div>}
        {removingWorkspace && intent === "delete" && disp?.branch && !disp.isMain && <label className="mt-3 flex items-center justify-between text-xs">
          <span>Also delete the branch <span className="font-mono">{disp.branch}</span></span>
          <Switch aria-label="Also delete the branch" checked={deleteBranch} disabled={busy || confirmingUnsafe} onCheckedChange={setDeleteBranch} />
        </label>}
        {confirmingUnsafe && <p role="alert" className="mt-3 text-xs text-warning">
          Explicitly confirm deleting {path} with the risks shown above. This cannot be undone.
        </p>}
        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          {intent === "settle" && !confirmingUnsafe && <Button variant="outline" onClick={() => void run(true)} disabled={busy}>Keep workspace, move this session</Button>}
          <Button variant="destructive" onClick={() => void run()} disabled={busy || (removingWorkspace && (!disp || disp.isMain))}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} {confirmingUnsafe ? "Delete anyway" : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ ok, text }: { ok: boolean; text: string }) {
  const Icon = ok ? Check : AlertTriangle;
  return <div className="flex items-start gap-2"><Icon className={`mt-0.5 size-3.5 shrink-0 ${ok ? "text-add" : "text-warning"}`} /><span>{text}</span></div>;
}
