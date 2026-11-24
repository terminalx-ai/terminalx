import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { getCloudCatalog, useCloudCatalog } from "@/lib/cloudCatalog";
import { lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { errorCode } from "@/lib/cloudTerminals";
import { canRestartWorkspace, detailsScope, restartCloudWorkspace, RestartAlreadyPendingError, RestartOperationError, useWorkspaceDetailsAvailable } from "@/lib/cloudWorkspaceDetails";
import { showError } from "@/lib/errorToasts";
import { selectCloudWorkspace } from "@/lib/sessions";
import { cloudWorkspaceKey } from "@/types/target";

export function WorkspaceRestartDialog({ item, onClose }: { item: CloudWorkspaceListItem; onClose: () => void }) {
  const { id, orgId, name } = item.workspace;
  const available = useWorkspaceDetailsAvailable(orgId);
  const catalog = useCloudCatalog();
  const [owner] = useState(detailsScope);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const currentItem = (source: typeof catalog) => {
    const org = source.orgs[orgId];
    return org?.source === "live" && !org.error ? org.workspaces.find((row) => row.workspace.id === id) : item;
  };
  const current = currentItem(catalog);
  const eligible = current && canRestartWorkspace(current);
  const [alreadyPending, setAlreadyPending] = useState(false);
  const unavailableReason = alreadyPending ? "A restart is already pending."
    : eligible ? null : "Restart is unavailable while this workspace is busy or you lack permission.";
  const submit = async () => {
    if (!confirmed || pending || alreadyPending || !available || owner !== detailsScope()) return;
    const latest = currentItem(getCloudCatalog());
    if (!latest || !canRestartWorkspace(latest)) return;
    setPending(true);
    setError(null);
    const key = JSON.stringify(["workspace-restart", orgId, id]);
    try {
      await restartCloudWorkspace(latest);
      if (owner !== detailsScope()) return;
      showError(name, undefined, { title: "Restarted workspace", tone: "success", key });
      if (mounted.current) onClose();
    } catch (error) {
      if (owner !== detailsScope()) return;
      if (error instanceof RestartAlreadyPendingError) {
        if (mounted.current) setAlreadyPending(true);
        return;
      }
      const message = error instanceof Error ? error.message : lifecycleErrorMessage(errorCode(error));
      const terminal = error instanceof RestartOperationError;
      showError(name, message, {
        title: "Couldn't restart workspace",
        tone: "error",
        key,
        actions: terminal ? [{
          label: "Open workspace",
          run: () => {
            if (owner === detailsScope()) selectCloudWorkspace(cloudWorkspaceKey(orgId, id));
          },
        }] : undefined,
      });
      if (mounted.current) {
        if (terminal) onClose();
        else setError(message);
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  if (!available || owner !== detailsScope()) return null;
  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent showClose={!pending && !alreadyPending}>
      <DialogHeader>
        <DialogTitle>Restart {name}?</DialogTitle>
        <DialogDescription>The workspace keeps its disk, pinned setup and saved conversations. Running processes will be interrupted. A checkpoint can time out and unsaved in-memory work may be lost.</DialogDescription>
      </DialogHeader>
      <label className="my-4 flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={pending} onChange={(event) => setConfirmed(event.target.checked)} />I understand running work may be interrupted</label>
      {pending && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Restart pending… You can close this dialog and keep working.</p>}
      {!pending && unavailableReason && <p role="status" className="text-xs text-muted-foreground">{unavailableReason}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{pending || alreadyPending ? "Close" : "Cancel"}</Button>
        <Button disabled={!confirmed || pending || !!unavailableReason} onClick={() => void submit()}>{error ? "Try again" : "Restart workspace"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
