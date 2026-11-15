import { useState } from "react";
import { Archive, ArchiveRestore, CalendarClock, Copy, Info, Lock, RotateCcw, Pause, Play, Trash2, Users } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CloudWorkspaceDetailsCard } from "./CloudWorkspaceDetails";
import { canRestartWorkspace, detailsScope, restartCloudWorkspace, useWorkspaceDetailsAvailable } from "@/lib/cloudWorkspaceDetails";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/menu";
import { CloudWorkspaceLifecycleDialog, actionsFor, type LifecycleAction } from "@/components/cloud/CloudWorkspaceLifecycle";
import { openSchedulesDialog } from "@/components/cloud/CloudSchedulesDialog";
import { openShareDialog } from "@/components/cloud/CloudShareDialog";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { applyCloudSnapshot, refreshCloudCatalog, resumeCloudWorkspace, unarchiveCloudWorkspace } from "@/lib/cloudCatalog";
import { LIFECYCLE_ADMIN_REASON, VISIBILITY_ADMIN_REASON, workspaceAuthority } from "@/lib/cloudCollab";
import { closeCloudConnection } from "@/lib/cloudConnections";
import { lifecycleErrorMessage, noteCloudWorkspaceDeleted } from "@/lib/cloudLifecycle";
import { deriveCloudActivity } from "@/lib/cloudRowState";
import { useSchedulesOffer } from "@/lib/cloudSchedules";
import { errorCode } from "@/lib/cloudTerminals";
import { selectCloudWorkspace } from "@/lib/sessions";

/**
 * A cloud workspace's actions, used wherever the workspace shows: a
 * project's "…" menu, a VM group row, and a cloud session's location chip.
 * Details, copy and restart when the native readiness gate offers them.
 * Sharing (Share… for whoever manages shares, else a read-only list),
 * then scheduled tasks for the owners and admins the server offers them to,
 * then the lifecycle (Stop, Resume, Archive, Delete) for the owners and
 * admins the server lets run it. Stop, Archive and Delete go through the
 * existing confirmation dialog; Resume is the one explicit wake.
 */

export type LifecycleRequest = { item: CloudWorkspaceListItem; action: LifecycleAction | "restart" | "details" | "copy-machine" | "copy-info" };

export function WorkspaceActionItems({
  item,
  onLifecycle,
  run,
  archived = false,
  detailsAllowed = true,
}: {
  item: CloudWorkspaceListItem;
  onLifecycle: (request: LifecycleRequest) => void;
  run: (work: () => Promise<void>) => void;
  archived?: boolean;
  detailsAllowed?: boolean;
}) {
  const detailsAvailable = useWorkspaceDetailsAvailable();
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
  // which takes managing it. Against a server from before PRO-73 a creator
  // who is a plain member manages shares only: they are told so here,
  // instead of being walked into a refusal.
  const shareBlocked = workspace.accessMode === "private" && authority.manageShares && !authority.lifecycle;
  // Scheduled tasks (PRO-37) are an owner's or admin's, and exist only on a
  // server that has them turned on. Whether both hold is the server's to
  // say: the item appears once it has, and never for someone it would refuse.
  // A private workspace's tasks are its creator's alone, so for one the
  // server is asked about that workspace too: an admin it is only shared
  // with is not shown the item.
  const schedules = useSchedulesOffer(workspace.orgId, lifecycle && present, workspace.accessMode === "private" ? workspace.id : null) === "offered" && lifecycle && present;
  const offersLifecycle =
    (workspace.state === "suspended" && !archived) || (actions.includes("stop") && !archived) || actions.includes("archive") || archived || actions.includes("delete");
  return (
    <>
      {detailsAvailable && detailsAllowed && present && <>
        <DropdownMenuItem onSelect={() => onLifecycle({ item, action: "details" })}><Info /> Workspace details…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onLifecycle({ item, action: "copy-machine" })}><Copy /> Copy machine ID</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onLifecycle({ item, action: "copy-info" })}><Copy /> Copy workspace info</DropdownMenuItem>
        {canRestartWorkspace(item) && <DropdownMenuItem onSelect={() => onLifecycle({ item, action: "restart" })}><RotateCcw /> Restart workspace…</DropdownMenuItem>}
        <DropdownMenuSeparator />
      </>}
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
      {schedules && (
        <DropdownMenuItem onSelect={() => openSchedulesDialog({ orgId: workspace.orgId, workspaceId: workspace.id, name: workspace.name })}>
          <CalendarClock /> Scheduled tasks…
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
      {/* The long label wraps rather than being cut off at the menu's edge. */}
      {lifecycle && actions.includes("archive") && (
        <DropdownMenuItem disabled={busy} className="whitespace-normal" onSelect={() => onLifecycle({ item, action: "archive" })}>
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
  if (request.action === "restart") return <WorkspaceRestartDialog item={request.item} onClose={onClose} />;
  if (request.action === "details" || request.action === "copy-machine" || request.action === "copy-info") return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent><DialogHeader><DialogTitle>Workspace details</DialogTitle><DialogDescription>Original setup and current connected resources.</DialogDescription></DialogHeader>
      <CloudWorkspaceDetailsCard item={request.item} initialCopy={request.action === "copy-machine" ? "machine" : request.action === "copy-info" ? "info" : undefined} />
    </DialogContent>
  </Dialog>;
  return (
    <CloudWorkspaceLifecycleDialog
      item={request.item}
      initial={request.action}
      onClose={onClose}
      onDone={(snapshot, done) => {
        onClose();
        // The action performed, not the one the dialog was opened for: the person may have switched.
        if (done.action === "delete") {
          // Deleted: nothing is left to connect to, and a session still open on it says so.
          noteCloudWorkspaceDeleted(request.item.workspace.orgId, request.item.workspace.id);
          closeCloudConnection({ orgId: request.item.workspace.orgId, workspaceId: request.item.workspace.id });
        } else if (snapshot?.workspace) {
          // Stopping or archiving: the row and the header say so at once. An open
          // session keeps its connection, which follows the machine down and, when
          // someone wakes the workspace again, back up (closing it here left that
          // session on a dead client for good).
          applyCloudSnapshot(snapshot, done.requestedAt);
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

/** Separate from Stop/Archive/Delete: restart is queued and never accepts force. */
function WorkspaceRestartDialog({ item, onClose }: { item: CloudWorkspaceListItem; onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owner] = useState(detailsScope);
  const submit = async () => {
    if (!confirmed || pending || owner !== detailsScope()) return;
    setPending(true); setError(null);
    try { await restartCloudWorkspace(item); if (owner === detailsScope()) onClose(); }
    catch (error) { if (owner === detailsScope()) setError(error instanceof Error ? error.message : lifecycleErrorMessage(errorCode(error))); }
    finally { setPending(false); }
  };
  return <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
    <DialogContent showClose={!pending} onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }} onPointerDownOutside={(event) => { if (pending) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Restart {item.workspace.name}?</DialogTitle><DialogDescription>The workspace keeps its disk, pinned setup and saved conversations. Running processes will be interrupted. A checkpoint can time out; unsaved in-memory work may be lost.</DialogDescription></DialogHeader>
      <label className="my-4 flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={pending} onChange={(event) => setConfirmed(event.target.checked)} />I understand running work may be interrupted</label>
      {pending && <p role="status">Restart pending… Waiting for the workspace operation.</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button><Button disabled={!confirmed || pending || !canRestartWorkspace(item) || owner !== detailsScope()} onClick={() => void submit()}>Restart workspace</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
