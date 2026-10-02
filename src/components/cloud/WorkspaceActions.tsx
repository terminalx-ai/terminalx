import { useState } from "react";
import { Archive, ArchiveRestore, Lock, Pause, Play, Trash2, Users } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/menu";
import { CloudWorkspaceLifecycleDialog, actionsFor, type LifecycleAction } from "@/components/cloud/CloudWorkspaceLifecycle";
import { openShareDialog } from "@/components/cloud/CloudShareDialog";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { applyCloudSnapshot, refreshCloudCatalog, resumeCloudWorkspace, unarchiveCloudWorkspace } from "@/lib/cloudCatalog";
import { LIFECYCLE_ADMIN_REASON, VISIBILITY_ADMIN_REASON, workspaceAuthority } from "@/lib/cloudCollab";
import { closeCloudConnection } from "@/lib/cloudConnections";
import { lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { deriveCloudActivity } from "@/lib/cloudRowState";
import { errorCode } from "@/lib/cloudTerminals";
import { selectCloudWorkspace } from "@/lib/sessions";

/**
 * A cloud workspace's actions, used wherever the workspace shows: a
 * project's "…" menu, a VM group row, and a cloud session's location chip.
 * Sharing first (Share… for whoever manages shares, else a read-only list),
 * then the lifecycle (Stop, Resume, Archive, Delete) for the owners and
 * admins the server lets run it. Stop, Archive and Delete go through the
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
  const { workspace } = item;
  // What the server enforces (PRO-30, saas §21): the lifecycle is an owner's
  // or admin's; anyone with a role reads who it is shared with; owners,
  // admins and the creator change that. Nobody is offered an action that
  // would only be refused.
  const authority = workspaceAuthority(workspace);
  const present = !archived && workspace.state !== "destroyed" && !workspace.deletedAt;
  // A private workspace is shared from here too: the dialog makes it visible
  // to the organization with the first person added. Someone who cannot
  // manage shares has a list to read only once it is organization-visible.
  const shareable = present && (authority.manageShares || (authority.viewShares && workspace.accessMode === "organization"));
  const sharedWith = workspace.sharedWith ?? 0;
  const lifecycle = authority.lifecycle;
  // Sharing a private workspace means making it organization-visible first,
  // which is an owner's or admin's: a creator who is a plain member is told
  // so here, instead of being walked into a refusal.
  const shareBlocked = workspace.accessMode === "private" && authority.manageShares && !authority.lifecycle;
  const offersLifecycle =
    (workspace.state === "suspended" && !archived) || (actions.includes("stop") && !archived) || actions.includes("archive") || archived || actions.includes("delete");
  return (
    <>
      {shareable && shareBlocked && (
        <DropdownMenuItem disabled title={VISIBILITY_ADMIN_REASON} data-testid="cloud-share-locked">
          <Users />
          <span className="flex min-w-0 flex-col">
            <span>Share…</span>
            <span className="whitespace-normal text-[10px] text-faint">{VISIBILITY_ADMIN_REASON}</span>
          </span>
        </DropdownMenuItem>
      )}
      {shareable && !shareBlocked && (
        <DropdownMenuItem
          onSelect={() =>
            openShareDialog({
              orgId: workspace.orgId,
              workspaceId: workspace.id,
              name: workspace.name,
              accessMode: workspace.accessMode,
              createdBy: workspace.createdBy ?? null,
              canManage: authority.manageShares,
            })
          }
        >
          <Users /> {authority.manageShares ? "Share…" : "Who has access…"}
          {sharedWith > 0 && <span className="ml-auto text-[10px] text-faint">{sharedWith}</span>}
        </DropdownMenuItem>
      )}
      {lifecycle && workspace.state === "suspended" && !archived && (
        <DropdownMenuItem disabled={busy} onSelect={() => void run(() => resumeCloudWorkspace(item))}>
          <Play /> Resume
        </DropdownMenuItem>
      )}
      {lifecycle && actions.includes("stop") && !archived && (
        <DropdownMenuItem disabled={busy} onSelect={() => onLifecycle({ item, action: "stop" })}>
          <Pause /> Stop
        </DropdownMenuItem>
      )}
      {lifecycle && actions.includes("archive") && (
        <DropdownMenuItem disabled={busy} onSelect={() => onLifecycle({ item, action: "archive" })}>
          <Archive /> {archived ? "Retry archive" : "Archive… (stops compute, deleted after 30 days)"}
        </DropdownMenuItem>
      )}
      {lifecycle && archived && (
        <DropdownMenuItem disabled={busy} onSelect={() => void run(() => unarchiveCloudWorkspace(item).then(() => refreshCloudCatalog()))}>
          <ArchiveRestore /> Unarchive
        </DropdownMenuItem>
      )}
      {lifecycle && actions.includes("delete") && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={state.label === "Deleting"} onSelect={() => onLifecycle({ item, action: "delete" })}>
            <Trash2 /> Delete…
          </DropdownMenuItem>
        </>
      )}
      {/* Destructive items are hidden, not disabled; one line says who has them, so the menu is never empty or silent. */}
      {!lifecycle && offersLifecycle && (
        <DropdownMenuItem disabled data-testid="cloud-lifecycle-locked">
          <Lock /> <span className="whitespace-normal text-[11px]">{LIFECYCLE_ADMIN_REASON}</span>
        </DropdownMenuItem>
      )}
    </>
  );
}

/** The confirmation dialog for a requested action; a deleted workspace's connection is closed after. */
export function WorkspaceLifecycleDialog({ request, onClose }: { request: LifecycleRequest; onClose: () => void }) {
  return (
    <CloudWorkspaceLifecycleDialog
      item={request.item}
      initial={request.action}
      onClose={onClose}
      onDone={(snapshot) => {
        onClose();
        if (request.action === "delete") {
          // Deleted: nothing is left to connect to.
          closeCloudConnection({ orgId: request.item.workspace.orgId, workspaceId: request.item.workspace.id });
        } else if (snapshot?.workspace) {
          // Stopping or archiving: the row and the header say so at once. An open
          // session keeps its connection, which follows the machine down and, when
          // someone wakes the workspace again, back up (closing it here left that
          // session on a dead client for good).
          applyCloudSnapshot(snapshot);
        }
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
