import { useDataPrivacy } from "@/lib/dataPrivacy";
import { PrivacyEmptyState } from "./DataPrivacySettings";
import { RegisteredSetting } from "./settingsRegistry";
import { Button } from "@/components/ui/button";
import { Segmented, Switch } from "@/components/ui/controls";
import { signIn, useAccount } from "@/lib/account";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { organizationName, organizationRunningCount, organizationSwitchTargets, setOrganizationHidden, switchOrganization, useOrganizationVisibility } from "@/lib/organizationVisibility";
import { useOrganizationSwitchingEnabled } from "@/lib/organizationVisibilityGate";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { forgetAgentLoginsRequest } from "@/lib/settingsLinks";
import { OrganizationSettings, type OrganizationPage } from "./OrganizationSettings";
import { openCloudSetup, unfinishedFlow } from "@/lib/cloudSetupFlow";
import { loadSetups } from "@/lib/organizationSetup";

interface OrganizationsTabProps {
  /** The organization whose pages are open in the menu; none: the list of organizations. */
  organizationId?: string;
  page?: OrganizationPage;
  /** Open an organization's General page (by hand: no earlier message's request scrolls it), or the list with null. */
  onOpenOrganization?: (organizationId: string | null) => void;
}

export function OrganizationsTab(props: OrganizationsTabProps = {}) {
  return useDataPrivacy().enabled ? <PrivacyEmptyState /> : <OrganizationsTabContent {...props} />;
}

function OrganizationsTabContent({ organizationId, page, onOpenOrganization }: OrganizationsTabProps) {
  const prefs = usePrefs();
  const { status, busy } = useAccount();
  const { all, selectedOrganization, temporaryOrganization } = useOrganizationVisibility();
  const catalog = useCloudCatalog();
  const switchingEnabled = useOrganizationSwitchingEnabled();
  const switchTargets = switchingEnabled ? organizationSwitchTargets(status) : all.map((org) => ({ id: org.id, org }));
  // Organizations whose full-window setup was left unfinished on this Mac.
  const email = status.state === "signed-in" ? (status.identity?.email ?? "") : "";
  const unfinished = new Set(email ? loadSetups(email).filter(unfinishedFlow).map((record) => record.organizationId!) : []);
  // Every organization the person belongs to has pages, cloud-enabled or not.
  const memberships = status.state === "signed-in" ? (status.organizations ?? []) : [];
  const organization = organizationId ? memberships.find((org) => org.id === organizationId) : undefined;
  if (organization) return <OrganizationSettings key={organization.id} organization={organization} page={page} onDeleted={() => onOpenOrganization?.(null)} />;
  const openPage = (id: string) => {
    forgetAgentLoginsRequest();
    onOpenOrganization?.(id);
  };
  const settingsButton = (org: (typeof memberships)[number]) => (
    <>
      {/* A setup left with "Finish later" resumes at the same step (PRO-370). */}
      {unfinished.has(org.id) && (
        <Button size="xs" aria-label={`Finish setting up ${organizationName(org)}`} onClick={() => openCloudSetup({ kind: "resume", organizationId: org.id })}>
          Finish setting up
        </Button>
      )}
      {/* Its own pages, opened in the menu: agent logins and the organization's other settings (PRO-107, PRO-464). */}
      <Button size="xs" variant="outline" aria-label={`Settings for ${organizationName(org)}`} onClick={() => openPage(org.id)}>
        Settings
      </Button>
    </>
  );
  return (
    <div className="flex flex-col">
      <RegisteredSetting setting="organizations.sidebar"
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Segmented aria-label="Organizations in sidebar" value={prefs.organizationDisplay} onChange={(organizationDisplay) => setPrefs({ organizationDisplay, selectedOrganization })} options={[{ value: "all", label: "All organizations" }, { value: "one", label: "One organization" }]} />
            {prefs.organizationDisplay === "one" && (
              <select aria-label="Organization in sidebar" value={selectedOrganization ?? ""} disabled={!switchTargets.length} onChange={(event) => {
                if (switchingEnabled) switchOrganization(event.target.value);
                else setPrefs({ selectedOrganization: event.target.value });
              }} className="h-7 max-w-56 rounded-md border border-hairline bg-well px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                {switchTargets.map(({ id, org }) => <option key={id} value={id}>{org ? organizationName(org) : "Only this Mac"}</option>)}
              </select>
            )}
          </div>
        }
      />
      <p className="py-3 text-xs text-muted-foreground">Needs you, notifications, and the dock badge include every organization. Working, Done, the command palette, and sidebar keyboard navigation follow the visible organizations; search can find hidden sessions by name. Opening a hidden session shows its organization while selected. New cloud sessions can use any available organization.</p>
      {prefs.organizationDisplay === "one" && <p className="pb-3 text-xs text-muted-foreground">Show in sidebar toggles apply in All organizations mode. Switching back restores your choices.</p>}
      {/* Any signed-in person can create another organization, whatever they belong to (PRO-370): the full-window setup does it. */}
      <RegisteredSetting setting="organizations.create"><div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <p className="text-xs text-muted-foreground">
          {all.length ? "Create another organization and set up its GitHub, compute, agent logins, environment and team." : "No cloud-enabled organizations."}
        </p>
        {status.state === "signed-in" && status.identity ? (
          <Button size="sm" onClick={() => openCloudSetup({ kind: "create" })}>Create organization</Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void signIn()}>Sign in to create an organization</Button>
        )}
      </div></RegisteredSetting>
      {all.map((org) => {
        const running = organizationRunningCount(org.id, catalog);
        return <RegisteredSetting setting="organizations.organization" instance={org.id} key={org.id} label={organizationName(org)} description={`${org.role} · ${running ? `${running} running workspace${running === 1 ? "" : "s"}` : "No running workspaces"}${temporaryOrganization === org.id ? " · Shown while selected" : ""}`} control={
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
        <RegisteredSetting setting="organizations.organization" instance={org.id} key={org.id} label={organizationName(org)} description={org.role} control={<div className="flex items-center gap-2">{settingsButton(org)}</div>} />
      ))}
    </div>
  );
}
