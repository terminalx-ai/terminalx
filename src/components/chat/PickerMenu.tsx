import { Fragment, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  hint?: string;
  icon?: React.ReactNode;
  /** A heading of its own above the first row of each section (People, then Files). */
  section?: string;
  /** Detail on its own line under the label (a person: email, role, where they are). */
  stacked?: boolean;
}

/**
 * The composer's inline list for `/` commands and `@` files. It never takes
 * focus: the textarea keeps it so typing keeps filtering, and every key the
 * list answers to is handled by the composer's own onKeyDown.
 */
export function PickerMenu({
  items,
  highlighted,
  onPick,
  onHover,
  title,
  empty,
  note = null,
  footer = null,
}: {
  items: PickerItem[];
  highlighted: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
  title: string;
  empty: string;
  /** Why the list is shorter than the reader may expect; said under it. */
  note?: string | null;
  /** A quiet line pinned under the list (the @ menu's hint, design 13.02). */
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return (
    <div
      ref={ref}
      role="listbox"
      className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto scrollbar-thin rounded-lg bg-popover p-1 shadow-surface hairline animate-fade-in"
    >
      {!items[0]?.section && <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-faint">{title}</div>}
      {items.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">{empty}</div>}
      {items.map((it, i) => (
        <Fragment key={it.id}>
        {it.section && it.section !== items[i - 1]?.section && (
          <div className={cn("px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint", i > 0 ? "mt-1 border-t border-hairline pt-2" : "pt-1")} data-testid="picker-section">{it.section}</div>
        )}
        <div
          role="option"
          aria-selected={i === highlighted}
          data-index={i}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(it);
          }}
          className={cn(
            "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
            i === highlighted ? "bg-veil-strong text-foreground" : "text-foreground/90",
          )}
        >
          {it.icon && <span className="shrink-0 text-muted-foreground">{it.icon}</span>}
          {it.stacked ? (
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{it.label}</span>
              {it.detail && <span className="truncate text-[11px] text-muted-foreground">{it.detail}</span>}
            </span>
          ) : (
            <>
              <span className="min-w-0 truncate">{it.label}</span>
              {it.detail && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{it.detail}</span>}
            </>
          )}
          {it.hint && <span className="ml-auto max-w-[35%] shrink-0 truncate pl-3 font-mono text-[11px] text-faint">{it.hint}</span>}
        </div>
        </Fragment>
      ))}
      {footer && (
        <div className="mt-1 flex flex-wrap gap-x-4 border-t border-hairline px-2 pt-1.5 pb-0.5 text-[11px] text-faint" data-testid="picker-footer">
          {footer}
        </div>
      )}
      {note && (
        <div className="px-2 py-1.5 text-[11px] text-muted-foreground" data-testid="picker-note">
          {note}
        </div>
      )}
    </div>
  );
}
