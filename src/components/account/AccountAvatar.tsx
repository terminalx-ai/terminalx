import { UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AccountIdentity } from "@/lib/api";

export function AccountAvatar({ identity, className }: { identity: AccountIdentity | null; className?: string }) {
  const label = identity?.name ?? identity?.email ?? "";
  const initial = Array.from(label.trim())[0]?.toLocaleUpperCase();
  return (
    <span
      aria-hidden
      className={cn("flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent", className)}
    >
      {initial ?? <UserRound className="size-3.5" />}
    </span>
  );
}
