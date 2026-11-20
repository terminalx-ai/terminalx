import type { ComponentType } from "react";
import { BookOpen, Bot as BotIcon, ClipboardList, Compass, Eye, FlaskConical, PenTool, Rocket, ShieldCheck } from "@/icons";
import { cn } from "@/lib/cn";

/** A role's mark: its icon and colour. A role this build does not know gets the plain bot mark. */
const ROLE_MARKS: Record<string, { icon: ComponentType<{ className?: string }>; tone: string }> = {
  cto: { icon: Compass, tone: "bg-accent/15 text-accent" },
  "chief-of-staff": { icon: ClipboardList, tone: "bg-muted-foreground/15 text-muted-foreground" },
  "ux-designer": { icon: PenTool, tone: "bg-merge/15 text-merge" },
  "qa-engineer": { icon: FlaskConical, tone: "bg-muted-foreground/15 text-muted-foreground" },
  "release-manager": { icon: Rocket, tone: "bg-muted-foreground/15 text-muted-foreground" },
  "docs-writer": { icon: BookOpen, tone: "bg-muted-foreground/15 text-muted-foreground" },
  "security-auditor": { icon: ShieldCheck, tone: "bg-add/15 text-add" },
  watcher: { icon: Eye, tone: "bg-info/15 text-info" },
};

const FALLBACK = { icon: BotIcon, tone: "bg-muted-foreground/15 text-muted-foreground" };

export function roleMark(roleTemplateId: string) {
  return ROLE_MARKS[roleTemplateId] ?? FALLBACK;
}

const SIZES = {
  xs: "size-4 rounded-[4px] [&_svg]:size-2.5",
  sm: "size-7 rounded-md [&_svg]:size-3.5",
  md: "size-9 rounded-lg [&_svg]:size-4",
  lg: "size-12 rounded-xl [&_svg]:size-6",
} as const;

/**
 * A bot's avatar (PRO-467): its role's icon on its role's colour. Shared by the sidebar, the Bots page and later
 * screens. A paused bot carries a small pause mark in its corner.
 */
export function BotAvatar({ roleTemplateId, size = "sm", paused = false, className }: { roleTemplateId: string; size?: keyof typeof SIZES; paused?: boolean; className?: string }) {
  const { icon: Icon, tone } = roleMark(roleTemplateId);
  return (
    <span aria-hidden className={cn("relative inline-flex shrink-0 items-center justify-center", SIZES[size], tone, className)} data-testid="bot-avatar" data-role={roleTemplateId}>
      <Icon />
      {paused && <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-warning ring-2 ring-background" data-testid="bot-avatar-paused" />}
    </span>
  );
}
