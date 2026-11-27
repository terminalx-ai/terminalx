import { RegisteredSetting } from "./settingsRegistry";
import { useState } from "react";
import { CreditCard, Cpu, Github, KeyRound, Loader2, Settings2, SlidersHorizontal, Stethoscope, Users, Variable, Waypoints } from "@/icons";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type OrganizationSummary } from "@/lib/api";
import { deleteOrganization, refreshAccount, useAccount } from "@/lib/account";
import { defaultOrgId } from "@/lib/cloudCatalog";
import { isMultiOrg } from "@/lib/multiOrg";
import { organizationName } from "@/lib/organizationVisibility";
import { OrganizationAgentLogins } from "./OrganizationAgentLogins";
import { OrganizationAgentRoutes } from "./OrganizationAgentRoutes";
import { OrganizationRoutes } from "./OrganizationRoutes";
import { AddOrganizationRoute } from "./AddOrganizationRoute";
import { OrganizationBilling } from "./OrganizationBilling";
import { OrganizationCloudCompute } from "./OrganizationCloudCompute";
import { OrganizationCloudTeardown } from "./OrganizationCloudTeardown";
import { OrganizationDelete } from "./OrganizationDelete";
import { OrganizationConsoleLink } from "./OrganizationConsoleLink";
import { OrganizationCompute } from "./OrganizationCompute";
import { OrganizationDiagnostics } from "./OrganizationDiagnostics";
import { OrganizationEnvironment } from "./OrganizationEnvironment";
import { OrganizationGithubApp } from "./OrganizationGithubApp";
import { OrganizationMembers } from "./OrganizationMembers";
import { OrganizationWorkspaceConfig } from "./OrganizationWorkspaceConfig";
import { ProviderControls } from "./ProviderControls";
import { managesWorkStatus, OrganizationWorkStatusSettings } from "./WorkStatusSettings";
import { openCloudSetup, unfinishedFlow } from "@/lib/cloudSetupFlow";
import { loadSetups } from "@/lib/organizationSetup";
import { phase2Ready } from "@/lib/phase2Readiness";

/** "an owner", for "You are an owner of Acme" and the pages' subtitle. */
export const ORGANIZATION_ROLE: Record<string, string> = { owner: "an owner", admin: "an administrator", member: "a member" };

/** An organization's pages, nested under it in the Settings menu as a project's are (PRO-464, design 11.16). */
export type OrganizationPage = "general" | "members" | "cloudCompute" | "billing" | "agentLogins" | "modelAccess" | "github" | "workspace" | "environment" | "diagnostics";
export const ORGANIZATION_PAGES: readonly { page: OrganizationPage; label: string; icon: LucideIcon }[] = [
  { page: "general", label: "General", icon: Settings2 },
  { page: "members", label: "Members", icon: Users },
  { page: "cloudCompute", label: "Cloud compute", icon: Cpu },
  { page: "billing", label: "Billing", icon: CreditCard },
  { page: "agentLogins", label: "Agent logins", icon: KeyRound },
  { page: "modelAccess", label: "Model access", icon: Waypoints },
  { page: "github", label: "GitHub", icon: Github },
  { page: "workspace", label: "Workspace settings", icon: SlidersHorizontal },
  { page: "environment", label: "Environment", icon: Variable },
  { page: "diagnostics", label: "Diagnostics", icon: Stethoscope },
];

/** Pages the service keeps on the active organization only: another organization's General offers to make it active. */
const ACTIVE_ONLY: ReadonlySet<OrganizationPage> = new Set(["members", "cloudCompute", "github", "workspace", "environment", "diagnostics"]);
/** Pages only owners and administrators manage: a member's menu leaves them out. */
const MANAGERS_ONLY: ReadonlySet<OrganizationPage> = new Set(["members", "cloudCompute", "github", "workspace", "environment"]);

/** Whether someone with `role` manages `page`: a member's menu, and their Settings search, leave the rest out. */
export function roleManagesOrganizationPage(role: string, page: OrganizationPage): boolean {
  return role !== "member" || !MANAGERS_ONLY.has(page);
}

/**
 * The pages `organization` has for the person: those they can manage, and those its being active or not allows.
 * Billing (PRO-596) is there for every member once the server reports its readiness for that organization.
 */
export function organizationPages(organization: Pick<OrganizationSummary, "role">, active: boolean, billing = false) {
  return ORGANIZATION_PAGES.filter(({ page }) => (page !== "billing" || billing)
    && (active || !ACTIVE_ONLY.has(page)) && roleManagesOrganizationPage(organization.role, page));
}

/** The page an organization's row lives on. Rows not named here (the overview, console, work status, teardown, delete…) are on General. */
export function organizationPageForRow(row: string | null | undefined): OrganizationPage {
  switch (row) {
    case "organizations.members": return "members";
    case "organizations.providers":
    case "organizations.compute": return "cloudCompute";
    case "organizations.billing": return "billing";
    case "organizations.agentLogins": return "agentLogins";
    case "organizations.agentRoutes": return "modelAccess";
    case "organizations.github": return "github";
    case "organizations.workspace": return "workspace";
    case "organizations.environment": return "environment";
    case "organizations.diagnostics": return "diagnostics";
    default: return "general";
  }
}

/**
 * One page of one organization's settings (PRO-107, PRO-464), chosen in the
 * Settings menu under Organizations. General holds who the person is there,
 * the console link, work status, and removing cloud resources or the
 * organization; each other page holds the section it is named after.
 *
 * Agent logins, work status (#441) and the console link to API keys and
 * webhooks (PRO-40) belong to each organization and are changed for any one
 * the person belongs to, whichever is active, and so is the person's own
 * model access there (PRO-18). The other pages still act on the active
 * organization only (the service keeps them there), so another
 * organization's General offers to make it the active one for them.
 * A page the organization does not have for the person shows General.
 */
export function OrganizationSettings({ organization, page = "general", onDeleted }: { organization: OrganizationSummary; page?: OrganizationPage; onDeleted: () => void }) {
  const { status } = useAccount();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contextRevision = status.context?.revision ?? "";
  const name = organizationName(organization);
  const active = organization.id === defaultOrgId(status);
  const member = organization.role === "member";
  const shown = organizationPages(organization, active, phase2Ready(status, organization.id, "desktopBilling")).some((entry) => entry.page === page) ? page : "general";
  // With every organization live (CS-18) the active one only picks where new cloud work starts.
  const activeLabel = isMultiOrg(status) ? "default organization" : "active organization";
  const accountEmail = status.identity?.email ?? "";
  // A setup left with "Finish later" resumes at the same step (PRO-370), from the list and from General.
  const unfinished = !!accountEmail && loadSetups(accountEmail).some((record) => record.organizationId === organization.id && unfinishedFlow(record));

  const makeActive = async () => {
    setSwitching(true);
    setError(null);
    try {
      await api.organizationSelect(organization.id, contextRevision);
      await refreshAccount();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSwitching(false);
    }
  };

  const content = (() => {
    switch (shown) {
      case "members":
        return <RegisteredSetting setting="organizations.members" instance={organization.id}><div className="contents"><OrganizationMembers accountEmail={accountEmail} contextRevision={contextRevision} organizationId={organization.id} plan={organization.plan} /></div></RegisteredSetting>;
      case "cloudCompute":
        return <OrganizationCloudCompute key={organization.id} organizationName={name} panels={{
          providers: <RegisteredSetting setting="organizations.providers" instance={organization.id}><div className="contents"><ProviderControls contextRevision={contextRevision} /></div></RegisteredSetting>,
          limits: <RegisteredSetting setting="organizations.compute" instance={organization.id}><div className="contents"><OrganizationCompute contextRevision={contextRevision} /></div></RegisteredSetting>,
        }} />;
      case "billing":
        return <RegisteredSetting setting="organizations.billing" instance={organization.id}><div className="contents"><OrganizationBilling key={organization.id} organization={organization} contextRevision={contextRevision} /></div></RegisteredSetting>;
      case "agentLogins":
        return <>
          <RegisteredSetting setting="organizations.agentLogins" instance={organization.id}><div className="contents"><OrganizationAgentLogins key={organization.id} contextRevision={contextRevision} organizationId={organization.id} organizationName={name} /></div></RegisteredSetting>
          <OrganizationRoutes key={`organization-routes-${organization.id}`} contextRevision={contextRevision} organizationId={organization.id} organizationName={name}
            renderAdd={({ routes, onAdded }) => <AddOrganizationRoute contextRevision={contextRevision} organizationId={organization.id} organizationName={name} routes={routes} onAdded={onAdded} />} />
        </>;
      case "modelAccess":
        return <RegisteredSetting setting="organizations.agentRoutes" instance={organization.id}><div className="contents"><OrganizationAgentRoutes key={`routes-${organization.id}`} contextRevision={contextRevision} organizationId={organization.id} organizationName={name} /></div></RegisteredSetting>;
      case "github":
        return <RegisteredSetting setting="organizations.github" instance={organization.id}><div className="contents"><OrganizationGithubApp contextRevision={contextRevision} /></div></RegisteredSetting>;
      case "workspace":
        return <RegisteredSetting setting="organizations.workspace" instance={organization.id}><div className="contents"><OrganizationWorkspaceConfig contextRevision={contextRevision} /></div></RegisteredSetting>;
      case "environment":
        return <RegisteredSetting setting="organizations.environment" instance={organization.id}><div className="contents"><OrganizationEnvironment contextRevision={contextRevision} organizationId={organization.id} /></div></RegisteredSetting>;
      case "diagnostics":
        return <RegisteredSetting setting="organizations.diagnostics" instance={organization.id}><div className="contents"><OrganizationDiagnostics contextRevision={contextRevision} member={member} /></div></RegisteredSetting>;
      case "general":
        return <>
          <RegisteredSetting setting="organizations.overview" instance={organization.id}><div>
            <p className="text-xs text-muted-foreground">
              You are {ORGANIZATION_ROLE[organization.role] ?? organization.role} of {name}. {active ? `It is your ${activeLabel}.` : `It is not your ${activeLabel}.`} What you
              change on this page applies to {name} only.
            </p>
            {unfinished && <Button className="mt-2" size="sm" aria-label={`Finish setting up ${name}`} onClick={() => openCloudSetup({ kind: "resume", organizationId: organization.id })}>Finish setting up</Button>}
          </div></RegisteredSetting>
          <RegisteredSetting setting="organizations.console" instance={organization.id}><div className="contents"><OrganizationConsoleLink organizationId={organization.id} organizationName={name} member={member} /></div></RegisteredSetting>
          <RegisteredSetting setting="organizations.workStatus" instance={organization.id}><div className="contents"><OrganizationWorkStatusSettings key={organization.id} organization={organization} /></div></RegisteredSetting>
          {!active && <RegisteredSetting setting="organizations.activate"><div className="rounded-lg border border-hairline p-3" data-testid="organization-settings-inactive">
            <div className="text-sm font-medium">Other settings of {name}</div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {member ? "Diagnostics" : "Members, compute, GitHub, workspace settings, environment, diagnostics and teardown"} of {name} are changed while it is your {activeLabel}.
              Its agent logins{managesWorkStatus(organization) ? " and work status" : ""} are changed as it is. So is your own model access in it.
            </p>
            <Button className="mt-2" size="sm" variant="outline" disabled={switching || !contextRevision} onClick={() => void makeActive()}>
              {switching && <Loader2 className="animate-spin" />}
              Make {name} your {activeLabel}
            </Button>
            {error && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </div></RegisteredSetting>}
          {active && <RegisteredSetting setting="organizations.teardown" instance={organization.id}><div className="contents"><OrganizationCloudTeardown contextRevision={contextRevision} organizationId={organization.id} organizationName={name} member={member} /></div></RegisteredSetting>}
          <RegisteredSetting setting="organizations.delete" instance={organization.id}><div className="contents"><OrganizationDelete organization={organization} contextRevision={contextRevision}
            unavailableReason={organization.isPersonal ? "Personal/default organizations cannot be deleted." : undefined}
            remove={deleteOrganization} onDeleted={onDeleted} /></div></RegisteredSetting>
        </>;
    }
  })();

  return (
    <div className="flex flex-col gap-4" data-testid="organization-settings" data-organization={organization.id} data-organization-page={shown}>
      {content}
    </div>
  );
}
