import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Pencil } from "lucide-react";
import { AccountAvatar } from "@/components/account/AccountAvatar";
import { Button } from "@/components/ui/button";
import { refreshAccount, signIn, signOut, useAccount } from "@/lib/account";
import { setPairingHostName, usePairing } from "@/lib/pairing";
import { api, errorMessage, type CloudProviderSummary } from "@/lib/api";

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
        <OrganizationOnboarding organizationName={identity.organization} accountEmail={identity.email} />
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

function OrganizationOnboarding({ organizationName, accountEmail }: { organizationName: string | null; accountEmail: string }) {
  const [name, setName] = useState("");
  const [providers, setProviders] = useState<CloudProviderSummary[]>([]);
  const [provider, setProvider] = useState<CloudProviderSummary | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createKey = useRef("");
  useEffect(() => {
    const storageKey = `terminalx.organization-create.${accountEmail}.${organizationName ?? "unselected"}`;
    const existing = globalThis.localStorage?.getItem(storageKey);
    const key = existing ?? (globalThis.crypto?.randomUUID?.() ?? `org-${Date.now()}-${Math.random()}`);
    if (!existing) globalThis.localStorage?.setItem(storageKey, key);
    createKey.current = key;
  }, [accountEmail, organizationName]);

  useEffect(() => {
    if (!organizationName) return;
    api.cloudProviders().then((result) => {
      setProviders(result.providers);
    }).catch((failure) => setError(errorMessage(failure)));
  }, [organizationName]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      await api.organizationCreate(name.trim(), createKey.current);
      await refreshAccount();
      setName("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  };

  if (!organizationName) {
    return <div className="rounded-lg border border-hairline p-3">
      <div className="text-sm font-medium">Create an organization</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Organization setup is incomplete. Create one to configure compute access; no machine is created by this step.</p>
      <div className="mt-3 flex gap-2"><input aria-label="Organization name" className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-background px-2 text-xs" value={name} onChange={(event) => setName(event.target.value)} /><Button size="sm" disabled={busy || name.trim().length < 2} onClick={() => void create()}>{busy ? <Loader2 className="animate-spin" /> : "Create"}</Button></div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>;
  }

  const connected = provider?.connection?.state === "connected";
  return <div className="rounded-lg border border-hairline p-3">
    <div className="text-sm font-medium">Compute setup</div>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{connected ? "Compute connection validated. Choose a build or workspace action when you are ready; validation does not provision a machine." : "Setup incomplete — an organization administrator must validate a provider key before cloud workspaces are ready."}</p>
    {providers.length > 0 && !connected && <>
      <label className="mt-3 block text-xs text-muted-foreground">Provider<select aria-label="Provider" className="mt-1 h-8 w-full rounded-md border border-hairline bg-background px-2 text-xs" value={provider?.id ?? ""} onChange={(event) => setProvider(providers.find((item) => item.id === event.target.value) ?? null)}>{providers.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      {provider?.canManage ? <><p className="mt-3 text-[11px] text-muted-foreground">Secure native provider-key entry is not available in this build; no key is accepted or sent from this page.</p><label className="mt-2 flex items-start gap-2 text-[11px] text-muted-foreground"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />I understand provider billing and organization use.</label><Button className="mt-3" size="sm" disabled>{busy ? <Loader2 className="animate-spin" /> : "Secure setup unavailable"}</Button></> : provider ? <p className="mt-3 text-xs text-muted-foreground">Only organization owners and administrators can manage provider connections.</p> : <p className="mt-3 text-xs text-muted-foreground">Select a provider to continue.</p>}
    </>}
    {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
  </div>;
}
