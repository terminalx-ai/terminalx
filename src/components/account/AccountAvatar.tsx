import { useState } from "react";
import { UserRound } from "@/icons";
import { cn } from "@/lib/cn";
import type { AccountIdentity } from "@/lib/api";

/** The person's picture from the sign-in service, else their initial; a picture that will not load falls back too. */
export function AccountAvatar({ identity, className }: { identity: AccountIdentity | null; className?: string }) {
  const label = identity?.name ?? identity?.email ?? "";
  const initial = Array.from(label.trim())[0]?.toLocaleUpperCase();
  const [failed, setFailed] = useState<string | null>(null);
  const picture = identity?.picture && failed !== identity.picture ? identity.picture : null;
  return (
    <span
      aria-hidden
      className={cn("flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/15 text-[10px] font-semibold text-accent", className)}
    >
      {picture ? (
        <img src={picture} alt="" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed(picture)} data-testid="account-picture" />
      ) : (
        initial ?? <UserRound className="size-3.5" />
      )}
    </span>
  );
}
