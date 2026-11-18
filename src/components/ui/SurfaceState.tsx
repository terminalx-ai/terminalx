import type { ReactNode } from "react";
import { Loader2 } from "@/icons";
import { Button } from "./button";

export type SurfaceStatus = "empty" | "loading" | "error" | "no-access" | "offline";
export interface SurfaceMessage {
  status: SurfaceStatus;
  title: string;
  description: string;
}

/** The feature owns state precedence, authority and retry. No cached children are rendered here. */
export function SurfaceState({ status, title, description, action }: SurfaceMessage & { action?: { label: string; onAction: () => void; disabled?: boolean } }) {
  return (
    <div className="space-y-3 rounded-lg border border-hairline bg-card p-4 text-card-foreground">
      <div role={status === "error" ? "alert" : "status"} aria-atomic="true" className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {status === "loading" && <Loader2 aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />}
          {title}
        </p>
        <p className="break-words text-xs text-muted-foreground">{description}</p>
      </div>
      {action && <Button variant="outline" size="sm" disabled={status === "loading" || action.disabled} onClick={action.onAction}>{action.label}</Button>}
    </div>
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
