import { X } from "@/icons";
import { useReassignedNotices, dismissReassignedNotice } from "@/lib/desktopInbox";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { usePeople } from "@/lib/cloudPeople";
import { selectCloudWorkspace } from "@/lib/sessions";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { Button } from "@/components/ui/button";

export function WorkspaceReassignedNotices() {
  const notices = useReassignedNotices();
  const catalog = useCloudCatalog();
  const name = usePeople(false);
  const privacy = useDataPrivacy();
  if (privacy.enabled) return null;
  const visible = notices.filter((notice) => {
    const org = catalog.orgs[notice.organizationId];
    return catalog.viewerUserId && org?.source === "live" && !org.error && org.workspaces.some((row) => row.workspace.id === notice.workspaceId && row.workspace.createdBy === catalog.viewerUserId);
  });
  return <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">{visible.map((notice) => <aside key={notice.id} role="status" className="pointer-events-auto rounded-lg bg-popover p-3 text-xs shadow-surface hairline">
    <div className="flex items-start gap-2"><span>{name(notice.actorId)} reassigned to you {notice.name}</span><Button size="icon-xs" variant="ghost" aria-label="Dismiss reassignment" onClick={() => dismissReassignedNotice(notice.id)}><X /></Button></div>
    {notice.note && <p className="my-2 whitespace-pre-wrap break-words text-muted-foreground">{notice.note}</p>}
    <Button variant="ghost" size="sm" onClick={() => selectCloudWorkspace(`cloud:${notice.organizationId}:${notice.workspaceId}`)}>Open workspace</Button>
  </aside>)}</div>;
}
