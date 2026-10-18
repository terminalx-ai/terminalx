import { useEffect, useState } from "react";
import { SettingRow, Switch } from "@/components/ui/controls";
import { errorMessage, workStatus, type OrganizationSummary, type OrganizationWorkStatus } from "@/lib/api";

/**
 * What this person's work status shares, and with whom (#441): their own
 * other machines always, teammates unless they turn it off, and, for an
 * admin, whether their organization shares it at all.
 */
export function WorkStatusSettings({ organizations }: { organizations: OrganizationSummary[] }) {
  const [shareWithTeam, setShareWithTeam] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const managed = organizations.filter((organization) => !organization.isPersonal && (organization.role === "owner" || organization.role === "admin"));

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => workStatus.settings())
      .then((settings) => live && setShareWithTeam(settings?.shareWithTeam ?? true))
      .catch(() => live && setShareWithTeam(true));
    return () => {
      live = false;
    };
  }, []);

  const changeShare = async (on: boolean) => {
    const before = shareWithTeam;
    setShareWithTeam(on);
    setError(null);
    try {
      setShareWithTeam((await workStatus.setShareWithTeam(on)).shareWithTeam);
    } catch (e) {
      setShareWithTeam(before);
      setError(errorMessage(e));
    }
  };

  return (
    <div className="rounded-lg border border-hairline px-3 py-2" data-testid="work-status-settings">
      <SettingRow
        label="Show my team what I’m working on"
        description="Teammates in an organization that connected a repository see which of its issues you have a session on: your name, the session’s title and branch, and whether an agent is working. Your other machines always see it, with this Mac’s name. Prompts, transcripts, paths and code never leave this Mac."
        control={<Switch aria-label="Show my team what I’m working on" checked={shareWithTeam ?? true} disabled={shareWithTeam === null} onCheckedChange={(on) => void changeShare(on)} />}
      />
      {managed.map((organization) => (
        <OrganizationSwitch key={organization.id} organization={organization} />
      ))}
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

const ORGANIZATION_ERRORS: Record<string, string> = {
  forbidden: "Only an owner or administrator can change this.",
  not_found: "You are no longer a member of this organization.",
  work_claims_unsupported: "The account service does not offer work status yet.",
};

/** An admin's switch: members of the organization see each other's work, or nobody's. */
function OrganizationSwitch({ organization }: { organization: OrganizationSummary }) {
  const [status, setStatus] = useState<OrganizationWorkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => workStatus.organization(organization.id))
      .then((found) => live && setStatus(found ?? null))
      .catch((e: { code?: string }) => live && setError(ORGANIZATION_ERRORS[e?.code ?? ""] ?? null));
    return () => {
      live = false;
    };
  }, [organization.id]);

  if (!status && !error) return null;
  const change = async (on: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setStatus(await workStatus.setOrganization(organization.id, on));
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "";
      setError(ORGANIZATION_ERRORS[code] ?? errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow
      label={`Work status in ${organization.name}`}
      description={error ?? "Members see who works on the issues of the organization’s repositories. Off, nobody in it is shown anyone else’s work; each person’s own machines still are."}
      disabled={!status?.canManage}
      control={<Switch aria-label={`Share work status in ${organization.name}`} checked={!!status?.shareWorkStatus} disabled={!status?.canManage || saving} onCheckedChange={(on) => void change(on)} />}
    />
  );
}
