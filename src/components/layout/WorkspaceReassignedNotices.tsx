import { CheckCircle2, X } from "@/icons";
import { useReassignedNotices, dismissReassignedNotice } from "@/lib/desktopInbox";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { usePeople } from "@/lib/cloudPeople";
import { selectCloudWorkspace } from "@/lib/sessions";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { dismissWorkspaceReassignReceipt, useWorkspaceReassignReceipt } from "@/lib/workspaceFollowing";
import { Button } from "@/components/ui/button";

export function WorkspaceReassignedNotices() {
  const notices = useReassignedNotices();
  const catalog = useCloudCatalog();
  const name = usePeople(false);
  const privacy = useDataPrivacy();
  const receipt = useWorkspaceReassignReceipt();
  if (privacy.enabled) return null;

  const visibleWorkspace = (orgId: string, workspaceId: string) => {
    const org = catalog.orgs[orgId];
    return org?.source === "live" && !org.error
      ? org.workspaces.find(({ workspace }) => workspace.id === workspaceId && workspace.state !== "destroyed" && !workspace.deletedAt)?.workspace
      : undefined;
  };
  const visible = notices.filter((notice) => catalog.viewerUserId
    && visibleWorkspace(notice.organizationId, notice.workspaceId)?.createdBy === catalog.viewerUserId);
  const sentWorkspace = receipt && visibleWorkspace(receipt.orgId, receipt.workspaceId);
  return <>
    {receipt && <aside className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover p-3 text-sm shadow-surface hairline">
      <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-add" />
      <div role="status" className="min-w-0 flex-1 break-words font-medium">
        {receipt.reassigned
          ? sentWorkspace ? `Reassigned ${sentWorkspace.name} to ${receipt.targetName}` : "Workspace reassigned"
          : "The server confirmed the earlier reassignment."}
      </div>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss reassignment confirmation" onClick={dismissWorkspaceReassignReceipt}><X /></Button>
    </aside>}
    {visible.map((notice) => <aside key={notice.id} role="status" className="pointer-events-auto rounded-lg bg-popover p-3 text-xs shadow-surface hairline">
      <div className="flex items-start gap-2"><span className="min-w-0 flex-1 break-words">{name(notice.actorId)} reassigned to you {notice.name}</span><Button size="icon-xs" variant="ghost" aria-label="Dismiss reassignment" onClick={() => dismissReassignedNotice(notice.id)}><X /></Button></div>
      {notice.note && <p className="my-2 whitespace-pre-wrap break-words text-muted-foreground">{notice.note}</p>}
      <Button variant="ghost" size="sm" onClick={() => selectCloudWorkspace(`cloud:${notice.organizationId}:${notice.workspaceId}`)}>Open workspace</Button>
    </aside>)}
  </>;
}
