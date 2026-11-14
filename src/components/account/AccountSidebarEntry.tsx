import { PRIVACY_MESSAGE, useDataPrivacy } from "@/lib/dataPrivacy";
import { Loader2, LogOut, Settings, UserRound } from "@/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { openPasteLink, signIn, signOut, useAccount } from "@/lib/account";
import { AccountAvatar } from "./AccountAvatar";
import { RelayStatus } from "./RelayStatus";
import { usePairing } from "@/lib/pairing";
import { cn } from "@/lib/cn";

export function AccountSidebarEntry({ onOpenAccount }: { onOpenAccount: () => void }) {
  const privacy = useDataPrivacy();
  const account = useAccount();
  // Dropped, or reconnecting after a drop (a retry is counted): the moments the line has something to say.
  const { relay } = usePairing().status;
  const relayDropped = relay.phase === "offline" || (relay.phase === "connecting" && relay.attempt > 0);
  const identity = account.status.identity;
  if (account.status.state === "signed-in" && identity) {
    return (
      // One line, the picture and the name, opening a menu: the email it is signed in as, Settings, and Log out. Relay's state
      // shows under it only when the relay has dropped, with its retry; connected, connecting or not configured is the
      // normal case and lives in Settings → Devices.
      <div className="relative w-full min-w-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className={cn("w-full min-w-0 justify-start gap-2 overflow-hidden px-2", (privacy.enabled || relayDropped) && "h-auto py-1.5")}
              title={[identity.email, identity.organization].filter(Boolean).join(" · ")}
            >
              <AccountAvatar identity={identity} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate">{identity.name ?? identity.email}</span>
                {(privacy.enabled || relayDropped) && <span aria-hidden className="mt-0.5 block h-[15px]" />}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <div className="truncate px-2 py-1.5 text-xs text-muted-foreground" title={identity.email}>{identity.email}</div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenAccount}><Settings /> Settings</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()} disabled={account.busy}><LogOut /> Log out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {privacy.enabled ? <span className="absolute right-2 bottom-1.5 left-10 truncate text-[10px] text-faint">{PRIVACY_MESSAGE}</span> : relayDropped && <RelayStatus />}
      </div>
    );
  }

  const signingIn = account.status.state === "signing-in";
  return (
    <Button
      variant="ghost"
      className="w-full min-w-0 justify-start gap-2 overflow-hidden px-2"
      disabled={privacy.enabled || !account.ready || account.busy}
      // In the dev app, a sign-in under way is finished by pasting its link: bring that dialog back rather than start
      // another sign-in, which would make the link already copied useless.
      onClick={() => (signingIn && import.meta.env.DEV ? openPasteLink() : void signIn())}
      title={privacy.enabled ? PRIVACY_MESSAGE : account.status.lastError ?? undefined}
    >
      {signingIn || !account.ready ? <Loader2 className="animate-spin" /> : <UserRound />}
      {signingIn ? "Finish signing in" : "Sign in"}
    </Button>
  );
}
