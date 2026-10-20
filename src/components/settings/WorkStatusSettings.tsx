import { useEffect, useState } from "react";
import { SettingRow, Switch } from "@/components/ui/controls";
import { Button } from "@/components/ui/button";
import { errorMessage, workStatus, type OrganizationSummary, type OrganizationWorkStatus, type OrganizationWorkStatusPatch } from "@/lib/api";

/**
 * What this person's work status shares, and with whom (#441): their own
 * other machines always, and teammates unless they turn it off. Whether an
 * organization shares it at all is on the organization's page
 * (OrganizationWorkStatusSettings).
 */
export function WorkStatusSettings() {
  const [shareWithTeam, setShareWithTeam] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

const ORGANIZATION_ERRORS: Record<string, string> = {
  forbidden: "Only an owner or administrator can change this.",
  not_found: "You are no longer a member of this organization.",
  work_claims_unsupported: "The account service does not offer work status yet.",
};

/** "acme, Other-Co" as the server takes it: lower case, no duplicates, each a Linear URL key. */
export function linearWorkspaceKeys(text: string): string[] | null {
  const keys = [...new Set(text.split(/[\s,]+/).map((key) => key.trim().toLowerCase().replace(/^https?:\/\/linear\.app\//, "").replace(/\/.*$/, "")).filter(Boolean))];
  return keys.every((key) => /^[a-z0-9-]{1,64}$/.test(key)) && keys.length <= 10 ? keys : null;
}

/** Whether the person changes the organization's work status: its owners and administrators, not of a personal one. */
export function managesWorkStatus(organization: OrganizationSummary): boolean {
  return !organization.isPersonal && (organization.role === "owner" || organization.role === "admin");
}

/**
 * An organization's work status, on its page in Settings → Organizations
 * (PRO-107), for its owners and administrators. It is the organization's
 * own, so it changes whichever organization is active.
 */
export function OrganizationWorkStatusSettings({ organization }: { organization: OrganizationSummary }) {
  if (!managesWorkStatus(organization)) return null;
  return <OrganizationSwitch organization={organization} />;
}

/**
 * An admin's settings for one organization: members see each other's work,
 * or nobody's; and the Linear workspaces that are the organization's, whose
 * issues members see each other's work on (GitHub repositories are the ones
 * the organization connected).
 */
function OrganizationSwitch({ organization }: { organization: OrganizationSummary }) {
  const [status, setStatus] = useState<OrganizationWorkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [workspaces, setWorkspaces] = useState<string | null>(null);

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
  const save = async (patch: OrganizationWorkStatusPatch) => {
    setSaving(true);
    setError(null);
    try {
      setStatus(await workStatus.setOrganization(organization.id, patch));
      setWorkspaces(null);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "";
      setError(ORGANIZATION_ERRORS[code] ?? errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const declared = (status?.linearWorkspaces ?? []).join(", ");
  const typed = workspaces ?? declared;
  const keys = linearWorkspaceKeys(typed);
  return (
    <div className="rounded-lg border border-hairline px-3 py-2" data-testid="organization-work-status">
      <SettingRow
        label={`Work status in ${organization.name}`}
        description={error ?? "Members see who works on the issues of the organization’s repositories. Off, nobody in it is shown anyone else’s work; each person’s own machines still are."}
        disabled={!status?.canManage}
        control={<Switch aria-label={`Share work status in ${organization.name}`} checked={!!status?.shareWorkStatus} disabled={!status?.canManage || saving} onCheckedChange={(on) => void save({ shareWorkStatus: on })} />}
      />
      {status?.canManage && status.shareWorkStatus && (
        <SettingRow
          stacked
          label={`Linear workspaces of ${organization.name}`}
          description="Members see each other’s work on Linear issues only in these workspaces: the name after linear.app/ in an issue’s address. Up to 10, separated by commas."
          control={
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (keys) void save({ linearWorkspaces: keys });
              }}
            >
              <input
                aria-label={`Linear workspaces of ${organization.name}`}
                value={typed}
                placeholder="acme"
                spellCheck={false}
                onChange={(event) => setWorkspaces(event.target.value)}
                className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-background px-2 font-mono text-xs outline-none focus:border-border"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={saving || !keys || typed === declared}>
                Save
              </Button>
            </form>
          }
        />
      )}
      {workspaces != null && !keys && <p role="alert" className="pb-2 text-xs text-destructive">A workspace is the name after linear.app/ in an issue’s address: letters, digits and dashes.</p>}
    </div>
  );
}
