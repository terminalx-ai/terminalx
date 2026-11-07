import { RegisteredSetting } from "./settingsRegistry";
import { useState } from "react";
import { Loader2 } from "@/icons";
import { MachineNameSettings } from "./MachineNameSettings";
import { OrganizationOnboarding } from "./OrganizationOnboarding";
import { WorkStatusSettings } from "./WorkStatusSettings";
import { AccountAvatar } from "@/components/account/AccountAvatar";
import { Button } from "@/components/ui/button";
import { pasteSignInLink, signIn, signOut, useAccount } from "@/lib/account";
import { isMultiOrg } from "@/lib/multiOrg";
import { usePairing } from "@/lib/pairing";
import { openOrganizationSettings } from "@/lib/settingsLinks";

export function AccountTab() {
  const account = useAccount();
  const pairing = usePairing();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const { status } = account;

  if (!account.ready) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading account…
      </div>
    );
  }

  if (status.state === "signed-in" && status.identity) {
    const identity = status.identity;
    // The active organization's page, by id; names are not unique, so an ambiguous match opens none.
    const named = (status.organizations ?? []).filter((organization) => organization.name === identity.organization);
    const activeId = identity.organizationId ?? (named.length === 1 ? named[0].id : null);
    return (
      <div className="flex flex-col gap-4">
        <RegisteredSetting setting="account.identity"><div className="flex items-center gap-3 rounded-lg bg-well px-3 py-3">
          <AccountAvatar identity={identity} className="size-10 text-sm" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{identity.name ?? identity.email}</div>
            <div className="truncate text-xs text-muted-foreground">{identity.email}</div>
            {identity.organization && <div className="mt-0.5 truncate text-xs text-faint">{identity.organization}</div>}
          </div>
        </div></RegisteredSetting>
        <MachineNameSettings />
        <WorkStatusSettings />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your TerminalX account is optional. The session refreshes automatically and its credentials are stored in macOS Keychain.
        </p>
        <RegisteredSetting setting="account.organizations"><div className="contents"><OrganizationOnboarding key={identity.email} organizationName={identity.organization} organizationId={identity.organizationId ?? null} accountEmail={identity.email} contextRevision={status.context?.revision ?? ""} organizations={status.organizations ?? []} multiOrg={isMultiOrg(status)} /></div></RegisteredSetting>
        {/* An organization's own settings, agent logins among them, are on its page (PRO-107). */}
        {identity.organization && activeId && (
          <RegisteredSetting setting="account.organizationSettings"><div className="flex items-center justify-between gap-3 rounded-lg border border-hairline p-3" data-testid="account-organization-settings">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{identity.organization} settings</div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Members, compute, agent logins, GitHub and the other settings of {identity.organization} are on its own page in Settings → Organizations, with each organization you belong to.
              </p>
            </div>
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => openOrganizationSettings(activeId)}>
              Open
            </Button>
          </div></RegisteredSetting>
        )}
        {pairing.status.host && (
          <RegisteredSetting setting="account.sharing"><details className="rounded-lg border border-hairline px-3 py-3">
            <summary className="cursor-pointer text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40">Advanced</summary>
            <div className="mt-3 text-xs font-medium">What this Mac shares</div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              The account directory receives exactly the seven binding fields below so your signed-in phone can find this Mac. Sessions, projects, worktrees, transcripts, paths, scrollback, and device credentials never leave through account binding. The work status above names, for each session linked to an issue, only the issue, the session’s title and branch, its state and when it was last active.
            </p>
            <dl className="mt-3 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[11px]">
              <dt className="text-faint">Host ID</dt><dd className="truncate font-mono">{pairing.status.host.hostId}</dd>
              <dt className="text-faint">Public key</dt><dd className="truncate font-mono">{pairing.status.host.publicKey}</dd>
              <dt className="text-faint">Generation</dt><dd>{pairing.status.host.bindingGeneration}</dd>
              <dt className="text-faint">Display name</dt>
              <dd className="truncate">{pairing.status.host.displayName}</dd>
              <dt className="text-faint">Platform</dt><dd>{pairing.status.host.platform}</dd>
              <dt className="text-faint">Environment</dt><dd>{pairing.status.host.environmentKind}</dd>
              <dt className="text-faint">Capability</dt><dd className="truncate font-mono">{pairing.status.host.capabilities.join(", ")}</dd>
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-faint">
              Relay proof also sends app version {pairing.status.host.appVersion}; the directory derives liveness from the last heartbeat{pairing.status.host.lastSeenAt ? ` at ${new Date(pairing.status.host.lastSeenAt).toLocaleString()}` : ""}.
            </p>
          </details></RegisteredSetting>
        )}
        {status.lastError && <p className="text-xs text-warning">{status.lastError}</p>}
        {confirmingSignOut ? (
          <RegisteredSetting setting="account.signOut"><div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Automatic account pairings will be removed and disconnected. QR and code pairings keep working, and running agents are untouched.
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="destructive" size="sm" disabled={account.busy} onClick={() => void signOut()}>
                {account.busy ? <Loader2 className="animate-spin" /> : null} Confirm sign out
              </Button>
              <Button variant="ghost" size="sm" disabled={account.busy} onClick={() => setConfirmingSignOut(false)}>Cancel</Button>
            </div>
          </div></RegisteredSetting>
        ) : (
          <RegisteredSetting setting="account.signOut"><div>
            <Button variant="destructive" size="sm" disabled={account.busy} onClick={() => setConfirmingSignOut(true)}>Sign out</Button>
          </div></RegisteredSetting>
        )}
      </div>
    );
  }

  const signingIn = status.state === "signing-in";
  return (
    <RegisteredSetting setting="account.identity"><div className="flex flex-col gap-4">
      <div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Sign in through TerminalX to find and pair your devices; every local workspace and agent continues to work without an account.
        </p>
      </div>
      {signingIn && (
        <div className="flex items-center gap-2 rounded-lg bg-well px-3 py-2.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Finish signing in in your browser, then return here.
        </div>
      )}
      {signingIn && <PasteSignInLink />}
      {status.lastError && <p className="text-xs text-destructive">{status.lastError}</p>}
      <div>
        <Button size="sm" disabled={account.busy} onClick={() => void signIn()}>
          {account.busy ? <Loader2 className="animate-spin" /> : null} {signingIn ? "Open sign-in again" : "Sign in"}
        </Button>
      </div>
    </div></RegisteredSetting>
  );
}

/**
 * For when the browser's Open button does not reach this app, as with a
 * development build (it has no URL scheme registered): copy that button's
 * link and paste it here to finish the same sign-in.
 */
function PasteSignInLink() {
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const submit = async () => {
    setSending(true);
    setProblem(await pasteSignInLink(link));
    setSending(false);
  };
  return (
    <form
      className="flex flex-col gap-1.5"
      data-testid="paste-sign-in-link"
      onSubmit={(event) => {
        event.preventDefault();
        if (link.trim()) void submit();
      }}
    >
      <label htmlFor="sign-in-link" className="text-xs text-muted-foreground">
        Button didn't open the app? Right-click it, choose Copy Link, and paste it here.
      </label>
      <div className="flex items-center gap-2">
        <input
          id="sign-in-link"
          value={link}
          onChange={(event) => { setLink(event.target.value); setProblem(null); }}
          placeholder="terminalx-dev://auth/callback?…"
          spellCheck={false}
          autoComplete="off"
          className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-2 font-mono text-[11px] outline-none focus:border-ring"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={sending || !link.trim()}>
          {sending ? <Loader2 className="animate-spin" /> : null} Finish sign-in
        </Button>
      </div>
      {problem && <p role="alert" className="text-xs text-destructive">{problem}</p>}
    </form>
  );
}
