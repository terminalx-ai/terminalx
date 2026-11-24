import { Eye } from "@/icons";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { selectCloudWorkspace } from "@/lib/sessions";
import { useAccount } from "@/lib/account";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { phase2Ready } from "@/lib/phase2Readiness";
import { PresenceFaces } from "@/components/dashboard/TeamOverview";
import { useCloudPresence } from "@/lib/cloudPresence";

/** Following is read from the same authorized live catalog as the rows, never a grant. */
export function WorkspaceFollowingSection({ orgId }: { orgId: string }) {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const catalog = useCloudCatalog();
  const org = catalog.orgs[orgId];
  if (privacy.enabled || !phase2Ready(status, orgId, "followReassign") || org?.source !== "live" || org.error) return null;
  const rows = org.workspaces.filter((item) => item.following === true && item.workspace.state !== "destroyed" && !item.workspace.deletedAt && !item.workspace.archivedAt);
  if (!rows.length) return null;
  return <section aria-label="Following" className="mb-2 px-1">
    <h3 className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase text-faint"><Eye className="size-3" />Following <span className="ml-auto">{rows.length}</span></h3>
    <ul>{rows.map((item) => <li key={item.workspace.id} className="flex min-w-0 items-center gap-1 rounded px-2 hover:bg-selected/50">
      <button type="button" className="min-w-0 flex-1 truncate py-1 text-left text-xs" onClick={() => selectCloudWorkspace(`cloud:${orgId}:${item.workspace.id}`)}>{item.workspace.name}</button>
      <PresenceFaces orgId={orgId} workspaceId={item.workspace.id} othersOnly compact />
    </li>)}</ul>
  </section>;
}
export function OrganizationPresenceCount({ orgId }: { orgId: string }) {
  const presence = useCloudPresence(orgId);
  const count = new Set(presence.activeMembers.map((person) => person.userId)).size;
  const label = presence.state === "live" ? `cloud · ${count} online` : presence.state === "loading" ? "Presence loading…" : presence.state === "stale" ? "Presence stale" : "Presence unavailable";
  return <span className="max-w-10 shrink-0 truncate text-[10px] text-faint" aria-label={label} title={label}>{presence.state === "live" ? <><span className="sr-only">cloud · </span>{count} online</> : "—"}</span>;
}
