import { RegisteredSetting } from "./settingsRegistry";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAccount } from "@/lib/account";
import { organizationGit, validGitIdentity, type GitIdentity, type OrganizationGitSettings as Settings } from "@/lib/organizationGit";
import { githubAppErrorMessage } from "@/lib/organizationGithubApp";

const inputClass = "h-8 rounded-md border border-hairline bg-background px-2 text-xs";

export function GitSettingsTab() {
  const { status } = useAccount();
  if (status.state !== "signed-in" || !status.identity?.organizationId) return <p>Sign in and select an organization to configure cloud commits.</p>;
  return <div><p className="mb-3 text-sm">Organization: {status.identity.organization}</p><RegisteredSetting setting="git.organizationIdentity"><div><OrganizationGitSettings key={status.context?.revision} contextRevision={status.context?.revision ?? ""} /></div></RegisteredSetting></div>;
}

export function OrganizationGitSettings({ contextRevision, tokenOnly = false }: { contextRevision: string; tokenOnly?: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [fallback, setFallback] = useState<GitIdentity | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [scope, setScope] = useState<"managers" | "organization">("managers");
  const [sharing, setSharing] = useState(false);
  const [installation, setInstallation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const epoch = useRef(0);
  const accept = (next: Settings) => { setSettings(next); setName(next.identity?.name ?? ""); setEmail(next.identity?.email ?? ""); setScope(next.tokenSharedUse ?? "managers"); };
  useEffect(() => {
    const current = ++epoch.current;
    setSettings(null); setToken(""); setSharing(false); setInstallation(false); setBusy(false); setError(null); setNotice(null);
    void Promise.all([organizationGit.get(), api.gitIdentity()]).then(([next, identity]) => {
      if (current !== epoch.current) return;
      accept(next); setFallback(identity);
    }).catch((failure) => { if (current === epoch.current) setError(githubAppErrorMessage(failure)); });
    return () => { epoch.current += 1; };
  }, [contextRevision]);
  const save = async (action: (revision: string) => Promise<void>, message: string) => {
    if (!settings || busy) return;
    const current = epoch.current;
    setBusy(true); setError(null); setNotice(null);
    try {
      await action(settings.contextRevision);
      const next = await organizationGit.get();
      if (current === epoch.current) { accept(next); setNotice(message); }
    } catch (failure) { if (current === epoch.current) setError(githubAppErrorMessage(failure)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  return <div className="rounded-lg border border-hairline p-3">
    {!tokenOnly && <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Commit author for this organization</h3>
      <p className="text-xs text-muted-foreground">Default on this computer: {fallback ? `${fallback.name} <${fallback.email}>` : "No global Git identity configured"}. The override applies only to this organization's cloud workspaces.</p>
      <label className="flex flex-col gap-1 text-xs">Commit name<input aria-label="Organization commit name" className={inputClass} value={name} maxLength={200} disabled={!settings?.canManage || busy} onChange={(e) => setName(e.target.value)} /></label>
      <label className="flex flex-col gap-1 text-xs">Commit email<input aria-label="Organization commit email" className={inputClass} value={email} maxLength={254} disabled={!settings?.canManage || busy} onChange={(e) => setEmail(e.target.value)} /></label>
      <div className="flex gap-2"><Button size="sm" disabled={!settings?.canManage || busy || !validGitIdentity(name, email)} onClick={() => void save((revision) => organizationGit.saveIdentity({ name: name.trim(), email: email.trim() }, revision), "Commit author saved.")}>Save commit author</Button><Button size="sm" variant="outline" disabled={!settings?.canManage || busy || !settings.identity} onClick={() => void save((revision) => organizationGit.saveIdentity(null, revision), "Default Git identity restored.")}>Use default</Button></div>
      <p className="text-xs text-muted-foreground">Cloud commit controls read this setting for each commit. Agent sessions pick it up after the workspace refreshes its configuration; restart existing agent sessions after changing or removing it.</p>
    </div>}
    <details className="mt-3"><summary className="cursor-pointer text-sm font-medium">Advanced: GitHub personal access token</summary>
      <p className="mt-2 text-xs">Clones and pushes will act as the token's owner.</p>
      <p className="mt-1 text-xs text-muted-foreground">Use a token limited to the repositories you need when the GitHub App is not installed. Stored encrypted as an organization credential; its value is never shown again. App-selected repositories keep using the App.</p>
      {settings?.tokenConfigured && <p className="mt-2 text-xs">A token is configured ({settings.tokenSharedUse === "organization" ? "all members" : "owners and admins"}).</p>}
      <div className="mt-2 flex flex-col gap-2 text-xs">
        <label className="flex flex-col gap-1">Personal access token<input type="password" autoComplete="new-password" aria-label="GitHub personal access token" className={inputClass} value={token} maxLength={8192} disabled={!settings?.canManage || busy} onChange={(e) => setToken(e.target.value)} /></label>
        <label>Who may use this token <select aria-label="Token access" value={scope} disabled={!settings?.canManage || busy} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="managers">Owners and admins</option><option value="organization">All organization members</option></select></label>
        <label><input type="checkbox" checked={sharing} disabled={!settings?.canManage || busy} onChange={(e) => setSharing(e.target.checked)} /> I may share this token with the selected organization members.</label>
        <label><input type="checkbox" checked={installation} disabled={!settings?.canManage || busy} onChange={(e) => setInstallation(e.target.checked)} /> I allow this token to be used on the organization's cloud machines.</label>
        <div className="flex gap-2"><Button size="sm" disabled={!settings?.canManage || busy || !token || /\s|[\x00-\x1f\x7f]/.test(token) || !sharing || !installation} onClick={() => { const value = token; setToken(""); void save((revision) => organizationGit.saveToken(value, scope, revision), "GitHub token saved."); }}>Save token</Button><Button size="sm" variant="outline" disabled={!settings?.canManage || busy || !settings.tokenConfigured} onClick={() => void save(organizationGit.removeToken, "Token removed from future workspace grants.")}>Remove token</Button></div>
        <p className="text-muted-foreground">Removing it stops new grants. Existing cached tokens may work for up to an hour; revoke the token on GitHub to invalidate copies immediately.</p>
      </div>
    </details>
    {settings && !settings.canManage && <p className="mt-2 text-xs text-muted-foreground">Only organization owners and admins can change these settings.</p>}
    {!settings && !error && <p className="text-xs">Loading Git settings…</p>}
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
  </div>;
}
