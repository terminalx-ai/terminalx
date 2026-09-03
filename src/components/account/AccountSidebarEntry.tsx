import { Loader2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signIn, useAccount } from "@/lib/account";
import { AccountAvatar } from "./AccountAvatar";

export function AccountSidebarEntry({ onOpenAccount }: { onOpenAccount: () => void }) {
  const account = useAccount();
  const identity = account.status.identity;
  if (account.status.state === "signed-in" && identity) {
    return (
      <Button
        variant="ghost"
        className="w-full justify-start gap-2 px-2"
        onClick={onOpenAccount}
        title={[identity.email, identity.organization].filter(Boolean).join(" · ")}
      >
        <AccountAvatar identity={identity} />
        <span className="truncate">{identity.name ?? identity.email}</span>
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
