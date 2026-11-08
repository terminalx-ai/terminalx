import { PrivacyImage } from "@/components/ui/privacy-image";
import { useState } from "react";
import { UserRound } from "@/icons";
import { cn } from "@/lib/cn";
import type { AccountIdentity } from "@/lib/api";

/**
 * The person's picture: the sign-in service's when it sends one, else the
 * GitHub account their email belongs to (as the Branch graph finds commit
 * authors' faces), else their initial. A picture that will not load gives
 * way to the next.
 */
export function AccountAvatar({ identity, className }: { identity: AccountIdentity | null; className?: string }) {
  const label = identity?.name ?? identity?.email ?? "";
  const initial = Array.from(label.trim())[0]?.toLocaleUpperCase();
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const candidates = [identity?.picture, identity?.email?.includes("@") ? `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(identity.email)}&s=64` : null];
  const picture = candidates.find((url): url is string => !!url && !failed.has(url)) ?? null;
  return (
    <span
      aria-hidden
      className={cn("flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/15 text-[10px] font-semibold text-accent", className)}
    >
      {picture ? (
        <PrivacyImage src={picture} alt="" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed((previous) => new Set([...previous, picture]))} data-testid="account-picture" />
      ) : (
        initial ?? <UserRound className="size-3.5" />
      )}
    </span>
  );
}
