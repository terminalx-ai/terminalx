import { useEffect, useState } from "react";
import { Check, Loader2, Pencil } from "lucide-react";
import { AccountAvatar } from "@/components/account/AccountAvatar";
import { Button } from "@/components/ui/button";
import { signIn, signOut, useAccount } from "@/lib/account";
import { setPairingHostName, usePairing } from "@/lib/pairing";

export function AccountTab() {
  const account = useAccount();
  const pairing = usePairing();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [editingHostName, setEditingHostName] = useState(false);
  const [hostName, setHostName] = useState("");
  const { status } = account;

  useEffect(() => {
    if (!editingHostName && pairing.status.host) setHostName(pairing.status.host.displayName);
  }, [editingHostName, pairing.status.host]);

  if (!account.ready) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading account…
      </div>
    );
  }

  if (status.state === "signed-in" && status.identity) {
    const identity = status.identity;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg bg-well px-3 py-3">
          <AccountAvatar identity={identity} className="size-10 text-sm" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{identity.name ?? identity.email}</div>
            <div className="truncate text-xs text-muted-foreground">{identity.email}</div>
            {identity.organization && <div className="mt-0.5 truncate text-xs text-faint">{identity.organization}</div>}
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your TerminalX account is optional. The session refreshes automatically and its credentials are stored in macOS Keychain.
        </p>
        {pairing.status.host && (
          <div className="rounded-lg border border-hairline px-3 py-3">
            <div className="text-xs font-medium">What this Mac shares</div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              The account directory receives exactly the seven binding fields below so your signed-in phone can find this Mac. Sessions, projects, worktrees, transcripts, paths, scrollback, and device credentials never leave through account binding.
            </p>
            <dl className="mt-3 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[11px]">
              <dt className="text-faint">Host ID</dt><dd className="truncate font-mono">{pairing.status.host.hostId}</dd>
              <dt className="text-faint">Public key</dt><dd className="truncate font-mono">{pairing.status.host.publicKey}</dd>
              <dt className="text-faint">Generation</dt><dd>{pairing.status.host.bindingGeneration}</dd>
              <dt className="text-faint">Display name</dt>
              <dd className="min-w-0">
                {editingHostName ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      aria-label="Mac display name"
                      className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-background px-2 text-xs outline-none focus:border-border"
                      maxLength={80}
                      value={hostName}
                      onChange={(event) => setHostName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditingHostName(false);
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Save Mac display name"
                      disabled={pairing.busy || !hostName.trim()}
                      onClick={() => void setPairingHostName(hostName).then(() => setEditingHostName(false)).catch(() => {})}
                    >
                      {pairing.busy ? <Loader2 className="animate-spin" /> : <Check />}
                    </Button>
                  </div>
                ) : (
                  <button className="group flex max-w-full items-center gap-1.5 text-left" onClick={() => setEditingHostName(true)}>
                    <span className="truncate">{pairing.status.host.displayName}</span>
                    <Pencil className="size-3 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                )}
              </dd>
              <dt className="text-faint">Platform</dt><dd>{pairing.status.host.platform}</dd>
              <dt className="text-faint">Environment</dt><dd>{pairing.status.host.environmentKind}</dd>
              <dt className="text-faint">Capability</dt><dd className="truncate font-mono">{pairing.status.host.capabilities.join(", ")}</dd>
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-faint">
              Relay proof also sends app version {pairing.status.host.appVersion}; the directory derives liveness from the last heartbeat{pairing.status.host.lastSeenAt ? ` at ${new Date(pairing.status.host.lastSeenAt).toLocaleString()}` : ""}.
            </p>
          </div>
        )}
        {status.lastError && <p className="text-xs text-warning">{status.lastError}</p>}
        {confirmingSignOut ? (
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Automatic account pairings will be removed and disconnected. QR and code pairings keep working, and running agents are untouched.
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="destructive" size="sm" disabled={account.busy} onClick={() => void signOut()}>
                {account.busy ? <Loader2 className="animate-spin" /> : null} Confirm sign out
              </Button>
              <Button variant="ghost" size="sm" disabled={account.busy} onClick={() => setConfirmingSignOut(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="destructive" size="sm" disabled={account.busy} onClick={() => setConfirmingSignOut(true)}>Sign out</Button>
          </div>
        )}
      </div>
    );
  }

  const signingIn = status.state === "signing-in";
  return (
    <div className="flex flex-col gap-4">
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
      {status.lastError && <p className="text-xs text-destructive">{status.lastError}</p>}
      <div>
        <Button size="sm" disabled={account.busy} onClick={() => void signIn()}>
          {account.busy ? <Loader2 className="animate-spin" /> : null} {signingIn ? "Open sign-in again" : "Sign in"}
        </Button>
      </div>
    </div>
  );
}
