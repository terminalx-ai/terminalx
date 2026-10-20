import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Segmented, SettingRow, Switch } from "@/components/ui/controls";
import { useAccount } from "@/lib/account";
import { defaultOrgId, useCloudCatalog } from "@/lib/cloudCatalog";
import { organizationName, organizationRunningCount, setOrganizationHidden, useOrganizationVisibility } from "@/lib/organizationVisibility";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { forgetAgentLoginsRequest, onOpenOrganizationSettings, takeOrganizationRequest } from "@/lib/settingsLinks";
import { OrganizationSettings } from "./OrganizationSettings";

export function OrganizationsTab() {
  const prefs = usePrefs();
  const { status } = useAccount();
  const { all, selectedOrganization, temporaryOrganization } = useOrganizationVisibility();
  const catalog = useCloudCatalog();
  // The organization whose page is open (PRO-107), chosen here or asked for by a message elsewhere.
  const [page, setPage] = useState<string | null>(null);
  const activeId = defaultOrgId(status);
  // Every organization the person belongs to has a page, cloud-enabled or not.
  const memberships = status.state === "signed-in" ? (status.organizations ?? []) : [];
  const members = useRef(memberships);
  members.current = memberships;
  useEffect(() => {
    const open = () => {
      const wanted = takeOrganizationRequest();
      if (wanted === undefined) return;
      const target = wanted ?? activeId;
      // No page for it here (not a member, or no default organization): its logins request is dropped with it.
      if (!target || !members.current.some((org) => org.id === target)) forgetAgentLoginsRequest();
      setPage(target);
    };
    open();
    return onOpenOrganizationSettings(open);
  }, [activeId]);
  /** A page opened by hand: no earlier message's request scrolls it. */
  const openPage = (organizationId: string) => {
    forgetAgentLoginsRequest();
    setPage(organizationId);
  };
  const organization = page ? memberships.find((org) => org.id === page) : undefined;
  if (organization) return <OrganizationSettings key={organization.id} organization={organization} onBack={() => setPage(null)} />;
  const settingsButton = (org: (typeof memberships)[number]) => (
    // Its own page: agent logins and the organization's other settings (PRO-107).
    <Button size="xs" variant="outline" aria-label={`Settings for ${organizationName(org)}`} onClick={() => openPage(org.id)}>
      Settings
    </Button>
  );
  return (
    <div className="flex flex-col">
      <SettingRow
        label="Organizations in sidebar"
        description="Local is always shown. These display preferences are saved on this desktop. Showing or switching organizations never wakes a workspace."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Segmented aria-label="Organizations in sidebar" value={prefs.organizationDisplay} onChange={(organizationDisplay) => setPrefs({ organizationDisplay, selectedOrganization })} options={[{ value: "all", label: "All organizations" }, { value: "one", label: "One organization" }]} />
            {prefs.organizationDisplay === "one" && (
              <select aria-label="Organization in sidebar" value={selectedOrganization ?? ""} disabled={!all.length} onChange={(event) => setPrefs({ selectedOrganization: event.target.value })} className="h-7 max-w-56 rounded-md border border-hairline bg-well px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                {all.map((org) => <option key={org.id} value={org.id}>{organizationName(org)}</option>)}
              </select>
            )}
          </div>
        }
      />
      <p className="py-3 text-xs text-muted-foreground">Needs you, notifications, and the dock badge include every organization. Working, Done, the command palette, and sidebar keyboard navigation follow the visible organizations; search can find hidden sessions by name. Opening a hidden session shows its organization while selected. New cloud sessions can use any available organization.</p>
      {prefs.organizationDisplay === "one" && <p className="pb-3 text-xs text-muted-foreground">Show in sidebar toggles apply in All organizations mode. Switching back restores your choices.</p>}
      {!all.length && <p className="py-3 text-xs text-muted-foreground">No cloud-enabled organizations.</p>}
      {all.map((org) => {
        const running = organizationRunningCount(org.id, catalog);
        return <SettingRow key={org.id} label={organizationName(org)} description={`${org.role} · ${running ? `${running} running workspace${running === 1 ? "" : "s"}` : "No running workspaces"}${temporaryOrganization === org.id ? " · Shown while selected" : ""}`} control={
          <div className="flex items-center gap-3">
            {settingsButton(org)}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Show in sidebar
              <Switch aria-label={`Show ${organizationName(org)} in sidebar`} checked={!prefs.hiddenOrganizations.includes(org.id)} disabled={prefs.organizationDisplay === "one"} onCheckedChange={(shown) => void setOrganizationHidden(org.id, !shown)} />
            </label>
          </div>
        } />;
      })}
      {/* Organizations the sidebar does not list (no cloud there, or a server that does not say) still have their page. */}
      {memberships.filter((org) => !all.some((listed) => listed.id === org.id)).map((org) => (
        <SettingRow key={org.id} label={organizationName(org)} description={org.role} control={settingsButton(org)} />
      ))}
    </div>
  );
}
