import type { ComponentType, ReactNode } from "react";
import { CircleX, Loader2, Lock, WifiOff } from "@/icons";
import { cn } from "@/lib/cn";
import { Button } from "./button";

/**
 * Shared empty, loading, error, no-access and offline states (Superdesign 17.15–17.19).
 * - Empty: an icon, a title, one line, at most one next step.
 * - Loading: keep the frame, put skeletons where rows will be.
 * - Error: say what failed and what is safe, with one retry.
 * - No access: a lock and one line naming who can.
 * - Offline: one warning band; the last known content stays below it.
 * The feature owns state precedence, authority and retry; these only draw.
 */
export type SurfaceStatus = "empty" | "loading" | "error" | "no-access" | "offline";
export interface SurfaceMessage {
  status: SurfaceStatus;
  title: string;
  description: string;
}
type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
interface Action { label: string; onAction: () => void; disabled?: boolean }

const ICONS: Partial<Record<SurfaceStatus, Icon>> = { error: CircleX, "no-access": Lock, offline: WifiOff };

/** A centred state for a whole surface or section: icon, title, one line and up to two actions. */
export function SurfaceState({ status, title, description, icon, action, secondary, className }: SurfaceMessage & {
  icon?: Icon;
  action?: Action;
  secondary?: Action;
  className?: string;
}) {
  const Glyph = status === "loading" ? null : icon ?? ICONS[status];
  return (
    <div className={cn("flex flex-col items-center gap-3 px-4 py-8 text-center", className)}>
      <div role={status === "error" ? "alert" : "status"} aria-atomic="true" className="flex max-w-sm flex-col items-center gap-1">
        {status === "loading"
          ? <Loader2 aria-hidden className="mb-1 size-4 text-accent motion-safe:animate-spin" />
          : Glyph && <Glyph aria-hidden className={cn("mb-1 size-4", status === "error" ? "text-destructive" : "text-muted-foreground")} />}
        {title && <p className="text-sm font-medium text-foreground">{title}</p>}
        {description && <p className="break-words text-xs text-muted-foreground">{description}</p>}
      </div>
      {(action || secondary) && <div className="flex flex-wrap justify-center gap-2">
        {action && <Button size="sm" variant={status === "error" ? "default" : "outline"} disabled={status === "loading" || action.disabled} onClick={action.onAction}>{action.label}</Button>}
        {secondary && <Button size="sm" variant="outline" disabled={secondary.disabled} onClick={secondary.onAction}>{secondary.label}</Button>}
      </div>}
    </div>
  );
}

/** Grey bars where rows will be. Hidden from screen readers; pair it with a status label. */
export function SkeletonRows({ rows = 3, avatar = false, className }: { rows?: number; avatar?: boolean; className?: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col", className)} data-testid="skeleton-rows">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-hairline px-2 py-3 last:border-b-0">
          {avatar && <span className="size-6 shrink-0 rounded-full bg-veil-strong" />}
          <span className="h-2 w-1/3 rounded-full bg-veil-strong motion-safe:animate-pulse" />
          <span className="h-2 w-1/4 rounded-full bg-veil-raised motion-safe:animate-pulse" />
          <span className="ms-auto h-2 w-10 rounded-full bg-veil-raised motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/** An inline failure inside a surface: what failed, what is safe, and one retry. */
export function InlineError({ children, retry, className }: { children: ReactNode; retry?: Action; className?: string }) {
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground", className)}>
      <CircleX aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {retry && <Button size="xs" variant="outline" className="shrink-0" disabled={retry.disabled} onClick={retry.onAction}>{retry.label}</Button>}
    </div>
  );
}

/** One line that says what this person can't change and who can. */
export function NoAccessNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 text-xs text-muted-foreground", className)}>
      <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** The offline band: one line, the last known content stays below it. */
export function OfflineBand({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="status" className={cn("flex items-center gap-2 border-y border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning", className)}>
      <WifiOff aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** Shared page/section anatomy; slots keep feature data and actions in their owning module. */
export function SurfaceSection({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 space-y-3 rounded-xl border border-hairline bg-card p-4 text-card-foreground">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1"><h2 className="break-words text-sm font-medium">{title}</h2>{description && <p className="break-words text-xs text-muted-foreground">{description}</p>}</div>
        {actions}
      </header>
      {children}
    </section>
  );
}
