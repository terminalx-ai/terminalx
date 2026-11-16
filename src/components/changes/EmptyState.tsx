import { cn } from "@/lib/cn";

/**
 * A calm, centred state for an expected absence (design 05.21, 05.22): an
 * icon tile, a short title, a reason in muted text and up to a few actions.
 * Not an error: nothing here is drawn in the destructive tone.
 */
export function EmptyState({ icon, title, children, actions, className, role = "status" }: {
  icon: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  role?: "status" | "note" | "alert";
}) {
  return <div role={role} className={cn("animate-panel-content flex flex-col items-center px-6 pb-6 pt-14 text-center", className)} data-testid="changes-empty-state">
    <div aria-hidden className="mb-3 grid size-10 place-items-center rounded-lg bg-veil-raised text-muted-foreground [&_svg]:size-[18px]">{icon}</div>
    <p className="text-[13px] font-medium text-foreground">{title}</p>
    {children && <div className="mt-1 max-w-[400px] text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{children}</div>}
    {actions && <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>}
  </div>;
}
