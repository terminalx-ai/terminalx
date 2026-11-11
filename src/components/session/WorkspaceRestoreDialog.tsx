import { useEffect, useState } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { closeWorkspaceRestore, useDialogs } from "@/lib/dialogs";
import { restoreWorkspace } from "@/lib/sessions";
import type { WorkspaceRestorePreview } from "@/types/session";

export function WorkspaceRestoreDialog() {
  const { workspaceRestore } = useDialogs();
  return workspaceRestore ? <Restore key={workspaceRestore} sessionId={workspaceRestore} /> : null;
}

function Restore({ sessionId }: { sessionId: string }) {
  const [preview, setPreview] = useState<WorkspaceRestorePreview | null>(null);
  const [branch, setBranch] = useState("");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setChecking(true);
    setError(null);
    setPreview(null);
    api.previewWorkspaceRestore(sessionId).then((value) => {
      if (!live) return;
      setPreview(value);
      setBranch(value.suggestedBranch);
    }).catch((error) => live && setError(errorMessage(error))).finally(() => live && setChecking(false));
    return () => { live = false; };
  }, [sessionId, attempt]);

  const restore = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      await restoreWorkspace(sessionId, preview, preview.needsBranch ? branch.trim() : null);
      closeWorkspaceRestore();
    } catch (error) {
      setPreview(null);
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && closeWorkspaceRestore()}>
      <DialogContent width="max-w-[30rem]" showClose={!busy}>
        <DialogHeader>
          <DialogTitle>Restore workspace</DialogTitle>
          <DialogDescription>Recreate the checkout and reopen its retained conversations there. Running tabs will stop; the next message resumes the agent in the restored workspace.</DialogDescription>
        </DialogHeader>
        {checking && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Checking the saved workspace…</p>}
        {preview && <div className="space-y-3 text-sm">
          <dl className="space-y-1 rounded-lg bg-well p-3">
            <dt className="text-muted-foreground">Workspace path</dt><dd className="break-all font-mono text-xs">{preview.path}</dd>
            <dt className="text-muted-foreground">Commit</dt><dd className="break-all font-mono text-xs">{preview.commit}</dd>
            {!preview.needsBranch && <><dt className="text-muted-foreground">Branch</dt><dd className="break-all font-mono text-xs">{preview.branch}</dd></>}
          </dl>
          <p>{preview.sessionIds.length} retained conversation{preview.sessionIds.length === 1 ? "" : "s"} will reopen here.</p>
          {preview.legacy && <p className="text-warning">No removal commit was saved by this older version. This restores the branch at its current commit.</p>}
          {preview.needsBranch && <>
            <p>{preview.needsBranch}</p>
            <label className="block space-y-1"><span>New branch name</span>
              <input className="w-full rounded-md border border-hairline bg-background px-3 py-2 font-mono text-sm" value={branch} onChange={(event) => setBranch(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} />
            </label>
          </>}
        </div>}
        <p className="text-xs text-muted-foreground">Only committed files are restored. Uncommitted changes, untracked files, and deleted conversations cannot be recovered. Git checkout can recreate tracked files deliberately removed by an archive script; that script is not undone or rerun.</p>
        {error && <p role="alert" className="whitespace-pre-line text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={closeWorkspaceRestore}>Cancel</Button>
          {error && !preview && <Button variant="outline" disabled={busy || checking} onClick={() => setAttempt((value) => value + 1)}>Check again</Button>}
          <Button disabled={busy || checking || !preview || (!!preview.needsBranch && !branch.trim())} onClick={() => void restore()}>
            {busy && <Loader2 className="animate-spin" />} Restore workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
