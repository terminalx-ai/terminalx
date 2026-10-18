import { useState } from "react";
import { ArrowLeft, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type OrganizationSummary } from "@/lib/api";
import { refreshAccount, useAccount } from "@/lib/account";
import { defaultOrgId } from "@/lib/cloudCatalog";
import { isMultiOrg } from "@/lib/multiOrg";
import { organizationName } from "@/lib/organizationVisibility";
import { OrganizationAgentLogins } from "./OrganizationAgentLogins";
import { OrganizationCloudTeardown } from "./OrganizationCloudTeardown";
import { OrganizationCompute } from "./OrganizationCompute";
import { OrganizationDiagnostics } from "./OrganizationDiagnostics";
import { OrganizationEnvironment } from "./OrganizationEnvironment";
import { OrganizationGithubApp } from "./OrganizationGithubApp";
import { OrganizationMembers } from "./OrganizationMembers";
import { OrganizationWorkspaceConfig } from "./OrganizationWorkspaceConfig";

const ROLE: Record<string, string> = { owner: "an owner", admin: "an administrator", member: "a member" };

/**
 * One organization's settings (PRO-107), chosen explicitly in Settings →
 * Organizations: its agent logins, and while it is the active organization
 * its members, compute, GitHub, workspace settings, environment, diagnostics
 * and teardown. The page names the organization it changes everywhere.
 *
 * Agent logins belong to each organization and are changed here for any one
 * the person belongs to, whichever is active. The other sections still act on
 * the active organization only (the service keeps them there), so another
 * organization's page offers to make it the active one for them.
 */
export function OrganizationSettings({ organization, onBack }: { organization: OrganizationSummary; onBack: () => void }) {
  const { status } = useAccount();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contextRevision = status.context?.revision ?? "";
  const name = organizationName(organization);
  const active = organization.id === defaultOrgId(status);
  const member = organization.role === "member";
  // With every organization live (CS-18) the active one only picks where new cloud work starts.
  const activeLabel = isMultiOrg(status) ? "default organization" : "active organization";
  const accountEmail = status.identity?.email ?? "";

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

  const logins = <OrganizationAgentLogins key={organization.id} contextRevision={contextRevision} organizationId={organization.id} organizationName={name} />;

  return (
    <div className="flex flex-col gap-4" data-testid="organization-settings" data-organization={organization.id}>
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
          <ArrowLeft /> All organizations
        </Button>
        <h3 className="mt-2 text-base font-semibold" data-testid="organization-settings-name">
          {name}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          You are {ROLE[organization.role] ?? organization.role} of {name}. {active ? `It is your ${activeLabel}.` : `It is not your ${activeLabel}.`} What you
          change on this page applies to {name} only.
        </p>
      </div>
      {active ? (
        <>
          <OrganizationMembers accountEmail={accountEmail} contextRevision={contextRevision} />
          <OrganizationCompute contextRevision={contextRevision} />
          {logins}
          <OrganizationGithubApp contextRevision={contextRevision} />
          <OrganizationWorkspaceConfig contextRevision={contextRevision} />
          <OrganizationEnvironment contextRevision={contextRevision} organizationId={organization.id} />
          <OrganizationDiagnostics contextRevision={contextRevision} member={member} />
          <OrganizationCloudTeardown contextRevision={contextRevision} organizationId={organization.id} organizationName={name} member={member} />
        </>
      ) : (
        <>
          {logins}
          <div className="rounded-lg border border-hairline p-3" data-testid="organization-settings-inactive">
            <div className="text-sm font-medium">Other settings of {name}</div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Members, compute, GitHub, workspace settings, environment, diagnostics and teardown of {name} are changed while it is your {activeLabel}.
              Its agent logins above are changed as it is.
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
          </div>
        </>
      )}
    </div>
  );
}
