import { useState, type ReactNode } from "react";
import { ChevronRight } from "@/icons";
import { cn } from "@/lib/cn";

/**
 * A titled fold that eases open and shut: its contents grow from nothing to
 * their height and fade in as the chevron turns, and the reverse to close
 * (a native <details> can only snap). Closed, the contents stay in the page
 * but out of reach (`inert`), so nothing in them takes focus.
 */
export function Fold({ label, children, defaultOpen = false, className, testId }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className} data-state={open ? "open" : "closed"} data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-sm py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <ChevronRight className={cn("size-3 transition-transform duration-200", open && "rotate-90")} aria-hidden /> {label}
      </button>
      <div
        className={cn("grid transition-[grid-template-rows,opacity] duration-250 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
        inert={!open}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
