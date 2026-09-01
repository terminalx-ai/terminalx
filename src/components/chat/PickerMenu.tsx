import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  hint?: string;
  icon?: React.ReactNode;
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
}: {
  items: PickerItem[];
  highlighted: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
  title: string;
  empty: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return (
    <div
      ref={ref}
      role="listbox"
      className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto scrollbar-thin rounded-lg p-1 shadow-surface hairline animate-fade-in backdrop-blur-2xl"
      style={{ background: "color-mix(in oklab, var(--surface-card) 94%, transparent)" }}
    >
      <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-faint">{title}</div>
      {items.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">{empty}</div>}
      {items.map((it, i) => (
        <div
          key={it.id}
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
          <span className="min-w-0 truncate">{it.label}</span>
          {it.detail && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{it.detail}</span>}
          {it.hint && <span className="ml-auto max-w-[35%] shrink-0 truncate pl-3 font-mono text-[11px] text-faint">{it.hint}</span>}
        </div>
      ))}
    </div>
  );
}
