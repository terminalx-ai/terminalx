import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { defaultOrgId } from "@/lib/cloudCatalog";
import { openCloudSetup } from "@/lib/cloudSetupNavigation";
import { openOrganizationSettings } from "@/lib/settingsLinks";

export function CloudSetupNotice({ members = false, organizationId }: { members?: boolean; organizationId?: string }) {
  const { status } = useAccount();
  const id = organizationId ?? defaultOrgId(status);
  const org = status.organizations?.find((item) => item.id === id);
  if (status.state !== "signed-in" || !id || !org) return null;
  if (org.cloudComputerReady !== false) return null;
  const manage = org.role === "owner" || org.role === "admin";
  return <div className="my-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-well p-3 text-xs" role="status">
    <span>{members ? "Finish setting up your cloud computer" : "Computer isn't ready yet"}</span>
    <Button size="xs" variant="outline" onClick={() => manage ? openCloudSetup(id) : openOrganizationSettings(id)}>{members && manage ? "Continue setup" : "View computer"}</Button>
  </div>;
}
