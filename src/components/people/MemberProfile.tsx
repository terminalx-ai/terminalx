import { useState, type ComponentProps } from "react";
import { Popover } from "radix-ui";
import { initials } from "@/lib/cloudPeople";
import { cn } from "@/lib/cn";
import type { OrganizationMember } from "@/lib/organizationMembers";
import { PrivacyImage, externalImage } from "@/components/ui/privacy-image";
import { useDataPrivacy } from "@/lib/dataPrivacy";

export function memberName(member: OrganizationMember) {
  return member.displayName?.trim() || member.email || `User ${member.userId.slice(0, 8)}`;
}
function Photo({ member, className }: { member: OrganizationMember; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const privacy = useDataPrivacy();
  const name = memberName(member);
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-well text-[10px] font-medium", className)}>
      {member.photoUrl && failedUrl !== member.photoUrl && !(privacy.enabled && externalImage(member.photoUrl))
        ? <PrivacyImage className="size-full object-cover" src={member.photoUrl} alt={name} referrerPolicy="no-referrer" onError={() => setFailedUrl(member.photoUrl!)} />
        : <span aria-hidden>{initials(name)}</span>}
    </span>
  );
}

/** The same accessible profile, whether opened from a face or a member menu. */
export function MemberProfile({ member, online, open, onOpenChange, className, ...buttonProps }: {
  member: OrganizationMember;
  online?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} & Omit<ComponentProps<"button">, "children">) {
  const name = memberName(member);
  const joined = member.createdAt == null ? null : new Date(member.createdAt);
  const role = ({ owner: "Owner", admin: "Admin", member: "Member" } as Record<string, string>)[member.role] || member.role || "Role unavailable";
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={`View profile: ${name}`} className={cn("relative inline-flex size-7 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent", className)} {...buttonProps}>
          <Photo member={member} className="size-full" />
          {online && <span aria-label="Online" className="absolute bottom-0 right-0 size-1.5 rounded-full bg-success ring-1 ring-background" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content aria-label={`Profile of ${name}`} sideOffset={6} collisionPadding={8} className="z-(--z-menu) w-72 rounded-lg bg-popover glass p-4 text-popover-foreground shadow-surface hairline">
          <div className="flex items-center gap-3">
            <span className="relative shrink-0">
              <Photo member={member} className="size-12 text-base" />
              <span data-testid="profile-presence" aria-label={online === undefined ? "Presence unavailable" : online ? "Online" : "Offline"} className={cn("absolute bottom-0 right-0 size-2.5 rounded-full ring-2 ring-popover", online ? "bg-success" : "bg-muted-foreground/30")} />
            </span>
            <div className="min-w-0">
              <p className="break-words text-sm font-medium">{name}</p>
              <p className="text-xs text-muted-foreground">{role}</p>
            </div>
          </div>
          <p className="mt-3 break-all select-text text-xs">{member.email || "Email unavailable"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {joined && Number.isFinite(joined.getTime())
              ? `Joined ${joined.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`
              : "Join date unavailable"}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
