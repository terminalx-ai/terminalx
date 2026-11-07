import { useState, type HTMLAttributes } from "react";
import { UserRound } from "@/icons";
import { cn } from "@/lib/cn";

export type Presence = "online" | "away" | "offline" | "unknown";

const presenceCopy: Record<Presence, string> = {
  online: "Online", away: "Away", offline: "Offline", unknown: "Presence unavailable",
};

/** Presence is supplied by the caller's scoped, current authority. Never infer it from a photo. */
export function PresenceDot({ presence, decorative = false }: { presence: Presence; decorative?: boolean }) {
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : presenceCopy[presence]}
      aria-hidden={decorative || undefined}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full border-2 border-popover",
        presence === "online" ? "bg-add" : presence === "away" ? "bg-warning" : "bg-muted-foreground",
        presence === "unknown" && "border-dashed border-muted-foreground bg-transparent",
      )}
    />
  );
}

export type AvatarProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  name: string;
  /** Supply only a photo the current account may load; omit for privacy mode. */
  photoUrl?: string | null;
  /** An existing surface can preserve its initials convention. */
  initials?: string;
  presence?: Presence;
  decorative?: boolean;
  size?: "sm" | "md";
};

/** A visual identity, not a profile button. Wrap in Button/PopoverTrigger when interactive. */
export function Avatar({ name, photoUrl, initials, presence, decorative = false, size = "sm", className, ...props }: AvatarProps) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const label = name.trim() || "Unknown person";
  const initial = Array.from(label)[0]?.toLocaleUpperCase();
  const description = presence ? `${label} · ${presenceCopy[presence]}` : label;
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : description}
      aria-hidden={decorative || undefined}
      title={description}
      {...props}
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full bg-well font-medium text-foreground", size === "sm" ? "size-5 text-[9px]" : "size-8 text-xs", className)}
    >
      {photoUrl && photoUrl !== failedPhoto ? (
        <img src={photoUrl} alt="" aria-hidden draggable={false} referrerPolicy="no-referrer" width={size === "sm" ? 20 : 32} height={size === "sm" ? 20 : 32} onError={() => setFailedPhoto(photoUrl)} className="size-full rounded-full object-cover" />
      ) : name.trim() ? <span aria-hidden>{initials ?? initial}</span> : <UserRound aria-hidden className="size-3" />}
      {presence && <span className="absolute -bottom-0.5 -right-0.5"><PresenceDot presence={presence} decorative /></span>}
    </span>
  );
}

export interface AvatarPerson {
  id: string;
  name: string;
  photoUrl?: string | null;
  presence?: Presence;
}

/** Passive summary; names beyond the visible limit remain in the accessible name. */
export function AvatarStack({ people, max = 3, label = "People", className }: { people: readonly AvatarPerson[]; max?: number; label?: string; className?: string }) {
  if (!people.length) return null;
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 3;
  const shown = people.slice(0, limit);
  const names = people.map((p) => `${p.name.trim() || "Unknown person"}${p.presence ? ` · ${presenceCopy[p.presence]}` : ""}`).join(", ");
  return (
    <span role="img" aria-label={`${label}: ${names}`} title={names} className={cn("inline-flex shrink-0 items-center -space-x-1", className)}>
      {shown.map((person) => <Avatar key={person.id} name={person.name} photoUrl={person.photoUrl} presence={person.presence} decorative className="ring-2 ring-background" />)}
      {people.length > shown.length && <span aria-hidden className="rounded-full bg-muted px-1 text-[11px] text-foreground ring-2 ring-background">+{people.length - shown.length}</span>}
    </span>
  );
}
