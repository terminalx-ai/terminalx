import { Segmented, SettingRow, Switch } from "@/components/ui/controls";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { organizationName, organizationRunningCount, setOrganizationHidden, useOrganizationVisibility } from "@/lib/organizationVisibility";
import { setPrefs, usePrefs } from "@/lib/prefs";

export function OrganizationsTab() {
  const prefs = usePrefs();
  const { all, selectedOrganization, temporaryOrganization } = useOrganizationVisibility();
  const catalog = useCloudCatalog();
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
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Show in sidebar
            <Switch aria-label={`Show ${organizationName(org)} in sidebar`} checked={!prefs.hiddenOrganizations.includes(org.id)} disabled={prefs.organizationDisplay === "one"} onCheckedChange={(shown) => void setOrganizationHidden(org.id, !shown)} />
          </label>
        } />;
      })}
    </div>
  );
}
