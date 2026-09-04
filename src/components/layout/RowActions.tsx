import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Class for a sidebar row that reveals a trailing {@link RowActions} toolbar.
 * The row is a named Tailwind group so the toolbar and any hover-swapped
 * trailing content (diff counters, relative time) can key off it.
 */
export const actionRow = "group/row";

/**
 * Trailing content that gives way to the toolbar. Applied to diff counters and
 * relative time so the label reflows into the freed space instead of being
 * painted over.
 */
export const yieldsToRowActions =
  "group-hover/row:hidden group-focus-within/row:hidden group-has-[[data-state=open]]/row:hidden";

/**
 * Right-aligned hover toolbar for sidebar rows.
 *
 * The toolbar is a real flex participant at the end of the row rather than an
 * absolutely positioned overlay, so a `min-w-0 truncate` label naturally leaves
 * room for it. It is `display: none` until the row is hovered, holds focus, or
 * has an open menu, so hidden buttons are neither painted nor tabbable.
 */
export function RowActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex group-has-[[data-state=open]]/row:flex",
        className,
      )}
    >
      {children}
    </span>
  );
}
