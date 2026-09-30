import { useState } from "react";
import { Archive, ArchiveRestore, Pause, Play, Trash2, Users } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/menu";
import { CloudWorkspaceLifecycleDialog, actionsFor, type LifecycleAction } from "@/components/cloud/CloudWorkspaceLifecycle";
import { openShareDialog } from "@/components/cloud/CloudShareDialog";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { refreshCloudCatalog, resumeCloudWorkspace, unarchiveCloudWorkspace } from "@/lib/cloudCatalog";
import { closeCloudConnection } from "@/lib/cloudConnections";
import { lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { deriveCloudActivity } from "@/lib/cloudRowState";
import { errorCode } from "@/lib/cloudTerminals";
import { selectCloudWorkspace } from "@/lib/sessions";

/**
 * A cloud workspace's lifecycle actions (Stop, Resume, Archive, Delete), used
 * wherever the workspace shows: a project's "…" menu, a VM group row, and a
 * cloud session's location chip. Stop, Archive and Delete go through the
 * existing confirmation dialog; Resume is the one explicit wake.
 */

export type LifecycleRequest = { item: CloudWorkspaceListItem; action: LifecycleAction };

export function WorkspaceActionItems({
  item,
  onLifecycle,
  run,
  archived = false,
}: {
  item: CloudWorkspaceListItem;
  onLifecycle: (request: LifecycleRequest) => void;
  run: (work: () => Promise<void>) => void;
  archived?: boolean;
}) {
  const state = deriveCloudActivity(item);
  const actions = actionsFor(item);
  const busy = state.tone === "changing";
  // PRO-30: an organization-visible workspace can be shared. Anyone who sees
  // it may read who it is shared with; the dialog lets managers and the
  // creator change it.
  // Offered only by a server that reports roles (`you`, saas §21.2).
  const shareable = !!item.workspace.you && !archived && item.workspace.accessMode === "organization" && item.workspace.state !== "destroyed" && !item.workspace.deletedAt;
  const sharedWith = item.workspace.sharedWith ?? 0;
  return (
    <>
      {shareable && (
        <DropdownMenuItem onSelect={() => openShareDialog({ orgId: item.workspace.orgId, workspaceId: item.workspace.id, name: item.workspace.name })}>
          <Users /> {item.workspace.you?.role === "manager" ? "Share…" : "Sharing…"}
          {sharedWith > 0 && <span className="ml-auto text-[10px] text-faint">{sharedWith}</span>}
        </DropdownMenuItem>
      )}
      {item.workspace.state === "suspended" && !archived && (
        <DropdownMenuItem disabled={busy} onSelect={() => void run(() => resumeCloudWorkspace(item))}>
          <Play /> Resume
        </DropdownMenuItem>
      )}
      {actions.includes("stop") && !archived && (
        <DropdownMenuItem disabled={busy} onSelect={() => onLifecycle({ item, action: "stop" })}>
          <Pause /> Stop
        </DropdownMenuItem>
      )}
      {actions.includes("archive") && (
        <DropdownMenuItem disabled={busy} onSelect={() => onLifecycle({ item, action: "archive" })}>
          <Archive /> {archived ? "Retry archive" : "Archive… (stops compute, deleted after 30 days)"}
        </DropdownMenuItem>
      )}
      {archived && (
        <DropdownMenuItem disabled={busy} onSelect={() => void run(() => unarchiveCloudWorkspace(item).then(() => refreshCloudCatalog()))}>
          <ArchiveRestore /> Unarchive
        </DropdownMenuItem>
      )}
      {actions.includes("delete") && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={state.label === "Deleting"} onSelect={() => onLifecycle({ item, action: "delete" })}>
            <Trash2 /> Delete…
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

/** The confirmation dialog for a requested action; a stopped or archived workspace's connection is closed after. */
export function WorkspaceLifecycleDialog({ request, onClose }: { request: LifecycleRequest; onClose: () => void }) {
  return (
    <CloudWorkspaceLifecycleDialog
      item={request.item}
      initial={request.action}
      onClose={onClose}
      onDone={() => {
        onClose();
        // Stopped, archived or deleted: nothing may keep reading it as live.
        closeCloudConnection({ orgId: request.item.workspace.orgId, workspaceId: request.item.workspace.id });
        void refreshCloudCatalog(request.item.workspace.orgId);
      }}
      onExport={() => {
        onClose();
        selectCloudWorkspace(`cloud:${request.item.workspace.orgId}:${request.item.workspace.id}`);
      }}
    />
  );
}

/** Run a lifecycle call, keeping its error for the caller to show. */
export function useLifecycleRun(): [string | null, (work: () => Promise<void>) => void] {
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<void>) => {
    setError(null);
    void work().catch((e: unknown) => setError(lifecycleErrorMessage(errorCode(e))));
  };
  return [error, run];
}
