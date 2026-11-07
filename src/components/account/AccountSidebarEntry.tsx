import { Loader2, UserRound } from "@/icons";
import { Button } from "@/components/ui/button";
import { openPasteLink, signIn, useAccount } from "@/lib/account";
import { AccountAvatar } from "./AccountAvatar";
import { RelayStatus } from "./RelayStatus";

export function AccountSidebarEntry({ onOpenAccount }: { onOpenAccount: () => void }) {
  const account = useAccount();
  const identity = account.status.identity;
  if (account.status.state === "signed-in" && identity) {
    return (
      <div className="relative w-full min-w-0">
        <Button
          variant="ghost"
          className="h-auto w-full min-w-0 justify-start gap-2 overflow-hidden px-2 py-1.5"
          onClick={onOpenAccount}
          title={[identity.email, identity.organization].filter(Boolean).join(" · ")}
        >
          <AccountAvatar identity={identity} />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate">{identity.name ?? identity.email}</span>
            <span aria-hidden className="mt-0.5 block h-[15px]" />
          </span>
        </Button>
        <RelayStatus />
      </div>
    );
  }

  const signingIn = account.status.state === "signing-in";
  return (
    <Button
      variant="ghost"
      className="w-full min-w-0 justify-start gap-2 overflow-hidden px-2"
      disabled={!account.ready || account.busy}
      // In the dev app, a sign-in under way is finished by pasting its link: bring that dialog back rather than start
      // another sign-in, which would make the link already copied useless.
      onClick={() => (signingIn && import.meta.env.DEV ? openPasteLink() : void signIn())}
      title={account.status.lastError ?? undefined}
    >
      {signingIn || !account.ready ? <Loader2 className="animate-spin" /> : <UserRound />}
      {signingIn ? "Finish signing in" : "Sign in"}
    </Button>
  );
}
