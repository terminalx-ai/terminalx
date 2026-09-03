import { Loader2 } from "lucide-react";
import { AccountAvatar } from "@/components/account/AccountAvatar";
import { Button } from "@/components/ui/button";
import { signIn, signOut, useAccount } from "@/lib/account";

export function AccountTab() {
  const account = useAccount();
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
        {status.lastError && <p className="text-xs text-warning">{status.lastError}</p>}
        <div>
          <Button variant="destructive" size="sm" disabled={account.busy} onClick={() => void signOut()}>
            {account.busy ? <Loader2 className="animate-spin" /> : null} Sign out
          </Button>
        </div>
      </div>
    );
  }

  const signingIn = status.state === "signing-in";
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-medium">TerminalX account</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Sign in through the TerminalX website to connect this app. You can keep using every local workspace and agent without an account.
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
