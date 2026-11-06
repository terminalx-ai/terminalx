import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { defaultOrgId, useCloudCatalog } from "@/lib/cloudCatalog";
import { openCloudSetup } from "@/lib/cloudSetupNavigation";
import { loadSetups, setupFor } from "@/lib/organizationSetup";
import { openOrganizationSettings } from "@/lib/settingsLinks";

export function CloudSetupNotice({ members = false, organizationId }: { members?: boolean; organizationId?: string }) {
  const { status } = useAccount();
  const catalog = useCloudCatalog();
  const id = organizationId ?? defaultOrgId(status);
  const org = status.organizations?.find((item) => item.id === id);
  if (status.state !== "signed-in" || !id || !org) return null;
  const setup = setupFor(loadSetups(status.identity?.email ?? ""), id);
  const known = catalog.orgs[id];
  const unfinished = setup ? setup.completedAt === null : known?.source === "live" && !known.error && !known.workspaces.some((item) => ["ready", "suspended"].includes(item.workspace.state));
  if (!unfinished) return null;
  const manage = org.role === "owner" || org.role === "admin";
  return <div className="my-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-well p-3 text-xs" role="status">
    <span>{members ? "Finish setting up your cloud computer" : "Computer isn't ready yet"}</span>
    <Button size="xs" variant="outline" onClick={() => manage ? openCloudSetup(id) : openOrganizationSettings(id)}>{members && manage ? "Continue setup" : "View computer"}</Button>
  </div>;
}
