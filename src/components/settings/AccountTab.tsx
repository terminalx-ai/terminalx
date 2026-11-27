import { useDataPrivacy } from "@/lib/dataPrivacy";
import { profile, thisComputer } from "@/lib/platform";
import { DataPrivacySettings } from "./DataPrivacySettings";
import { RegisteredSetting } from "./settingsRegistry";
import { useState } from "react";
import { Loader2, LogOut } from "@/icons";
import { MachineNameSettings } from "./MachineNameSettings";
import { WorkStatusSettings } from "./WorkStatusSettings";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { signIn, signOut, useAccount } from "@/lib/account";
import { PasteSignInLink } from "@/components/account/PasteSignInLink";
import { usePairing } from "@/lib/pairing";
import { openOrganizationSettings } from "@/lib/settingsLinks";
import type { AccountIdentity } from "@/lib/api";
import type { AccountListing } from "@/types/pairing";

/** Up to two initials from the person's name, else the first letter of their email. */
export function accountInitials(identity: AccountIdentity): string {
  const words = (identity.name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words.length ? [words[0]] : [identity.email.trim()];
  return letters.map((word) => Array.from(word)[0] ?? "").join("").toLocaleUpperCase();
}

/** Who is signed in (design 09.06): initials, name with the active organization, email; no box around it. */
function IdentityHeader({ identity }: { identity: AccountIdentity }) {
  return (
    <div className="flex items-center gap-3 pb-4" data-testid="account-identity">
      <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent/15 text-base font-semibold text-accent">
        {accountInitials(identity)}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-medium">{identity.name ?? identity.email}</span>
          {identity.organization && (
            <span className="max-w-48 shrink-0 truncate rounded-md bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent" title="Active organization">{identity.organization}</span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">{identity.email}</div>
      </div>
    </div>
  );
}

/**
 * Whether this computer is on the account's machine list, where the account's other computers find it in
 * Add a machine → On your account (PRO-598). When it is not, the reason, so no one has to guess.
 */
function AccountListingRow({ listing, email }: { listing: AccountListing; email: string }) {
  if (listing.state === "off") return null;
  const listed = listing.state === "listed";
  return (
    <div className="py-3" data-testid="account-listing" data-state={listing.state}>
      <div className="text-[13px] font-medium">{listed ? "On your account’s machine list" : "Not on your account’s machine list"}</div>
      {listed ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your other computers signed in as {email} find {thisComputer} under Add a machine → On your account.
        </p>
      ) : (
        <p role="status" className={listing.state === "refused" ? "text-xs leading-relaxed text-warning" : "text-xs leading-relaxed text-muted-foreground"}>
          Your other computers signed in as {email} cannot find {thisComputer} yet. {listing.reason}
        </p>
      )}
    </div>
  );
}

export function AccountTab() {
  const privacy = useDataPrivacy();
  const account = useAccount();
  const pairing = usePairing();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const { status } = account;

  // Data privacy mode turns the account's features off: who is signed in, and the card that says what is off.
  if (privacy.enabled) return (
    <div className="flex flex-col">
      {account.status.identity && <IdentityHeader identity={account.status.identity} />}
      <DataPrivacySettings />
    </div>
  );

  if (!account.ready) {
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 pb-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading account…
        </div>
        <DataPrivacySettings />
      </div>
    );
  }

  if (status.state === "signed-in" && status.identity) {
    const identity = status.identity;
    // The active organization's page, by id; names are not unique, so an ambiguous match opens none.
    const named = (status.organizations ?? []).filter((organization) => organization.name === identity.organization);
    const activeId = identity.organizationId ?? (named.length === 1 ? named[0].id : null);
    return (
      <div className="flex flex-col">
        <RegisteredSetting setting="account.identity"><div><IdentityHeader identity={identity} /></div></RegisteredSetting>
        <div className="flex flex-col divide-y divide-hairline border-t border-hairline">
          <MachineNameSettings />
          <AccountListingRow listing={pairing.status.accountListing} email={identity.email} />
          <WorkStatusSettings />
          {/* An organization's own settings, agent logins among them, are on its page (PRO-107); creating one is under Organizations. */}
          {identity.organization && activeId && (
            <RegisteredSetting setting="account.organizationSettings"><div className="flex items-center justify-between gap-4 py-3" data-testid="account-organization-settings">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{identity.organization} settings</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Members, compute, agent logins, GitHub and the other settings of {identity.organization} are on its own page in Settings → Organizations, with each organization you belong to.
                </p>
              </div>
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => openOrganizationSettings(activeId)}>
                Open
              </Button>
            </div></RegisteredSetting>
          )}
          <div className="py-1"><DataPrivacySettings /></div>
          {pairing.status.host && (
            <RegisteredSetting setting="account.sharing"><details className="py-3">
              <summary className="cursor-pointer text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40">Advanced</summary>
              <div className="mt-3 text-xs font-medium">What {thisComputer} shares</div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                The account directory receives exactly the seven binding fields below so your signed-in phone can find {thisComputer}. Sessions, projects, worktrees, transcripts, paths, scrollback, and device credentials never leave through account binding. The work status above names, for each session linked to an issue, only the issue, the session’s title and branch, its state and when it was last active.
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
          <RegisteredSetting setting="account.signOut"><div className="py-3" data-testid="account-sign-out">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">Sign out</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Signs out of TerminalX on {thisComputer}. Local sessions keep working; cloud workspaces and pairing need an account.{profile.secretStore ? ` Your session is kept in ${profile.secretStore} until then.` : null}
                </p>
              </div>
              <Button variant="outline" size="sm" className="shrink-0" disabled={account.busy} onClick={() => setConfirmingSignOut(true)}>
                <LogOut /> Sign out
              </Button>
            </div>
            {status.lastError && <p className="mt-2 text-xs text-warning">{status.lastError}</p>}
            {/* Design 17.01: what signing out does, then Cancel and a red Sign out. A failure closes it and is said in the row. */}
            <ConfirmDialog
              open={confirmingSignOut}
              title="Sign out of TerminalX?"
              action={<>{account.busy ? <Loader2 className="animate-spin" /> : null} Sign out</>}
              destructive
              busy={account.busy}
              onAction={() => void signOut().finally(() => setConfirmingSignOut(false))}
              onCancel={() => setConfirmingSignOut(false)}
            >
              Phones paired through your account disconnect. QR and code pairings keep working, and running agents are untouched.
            </ConfirmDialog>
          </div></RegisteredSetting>
        </div>
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
      {/* The dev app asks for the link in a dialog as sign-in starts; a built app shows the field as a fallback. */}
      {signingIn && !import.meta.env.DEV && <PasteSignInLink />}
      {status.lastError && <p className="text-xs text-destructive">{status.lastError}</p>}
      <div>
        <Button size="sm" disabled={account.busy} onClick={() => void signIn()}>
          {account.busy ? <Loader2 className="animate-spin" /> : null} {signingIn ? "Open sign-in again" : "Sign in"}
        </Button>
      </div>
      {/* Data privacy mode works without an account. */}
      <div className="border-t border-hairline pt-2"><DataPrivacySettings /></div>
    </div></RegisteredSetting>
  );
}
