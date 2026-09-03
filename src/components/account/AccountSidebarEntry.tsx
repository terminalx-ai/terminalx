import { Loader2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signIn, useAccount } from "@/lib/account";
import { usePairing } from "@/lib/pairing";
import { AccountAvatar } from "./AccountAvatar";

export function AccountSidebarEntry({ onOpenAccount }: { onOpenAccount: () => void }) {
  const account = useAccount();
  const pairing = usePairing();
  const identity = account.status.identity;
  if (account.status.state === "signed-in" && identity) {
    return (
      <Button
        variant="ghost"
        className="h-auto w-full justify-start gap-2 px-2 py-1.5"
        onClick={onOpenAccount}
        title={[identity.email, identity.organization].filter(Boolean).join(" · ")}
      >
        <AccountAvatar identity={identity} />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate">{identity.name ?? identity.email}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[10px] font-normal text-faint">
            <span className={pairing.status.relay.phase === "connected" ? "size-1.5 rounded-full bg-add" : "size-1.5 rounded-full bg-faint"} />
            {pairing.status.relay.phase === "connected" ? "Relay connected" : pairing.status.relay.phase === "connecting" ? "Relay connecting" : "Relay offline"}
          </span>
        </span>
      </Button>
    );
  }

  const signingIn = account.status.state === "signing-in";
  return (
    <Button
      variant="ghost"
      className="w-full justify-start gap-2 px-2"
      disabled={!account.ready || account.busy}
      onClick={() => void signIn()}
      title={account.status.lastError ?? undefined}
    >
      {signingIn || !account.ready ? <Loader2 className="animate-spin" /> : <UserRound />}
      {signingIn ? "Finish signing in" : "Sign in"}
    </Button>
  );
}
