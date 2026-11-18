import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { Check } from "@/icons";
import { cn } from "@/lib/cn";

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { size?: "sm" | "md" }
>(({ className, size = "md", ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=unchecked]:bg-(--switch-off)",
      // 36×20 as designed (PRO-374); sm stays the compact size for dense lists.
      size === "md" ? "h-5 w-9" : "h-3 w-5",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block rounded-full bg-white shadow-button transition-transform",
        size === "md"
          ? "size-4 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5"
          : "size-2 data-[state=checked]:translate-x-2.5 data-[state=unchecked]:translate-x-0.5",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  "aria-label"?: string;
  title?: string;
  /** This one choice is not available now; arrows pass over it. */
  disabled?: boolean;
}

/** A track with a sliding thumb; one Tab stop, arrows move inside it. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
  packed,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  disabled?: boolean;
  className?: string;
  /** Each choice as wide as its label, packed from the start of a track that may be wider: the thumb sits on the chosen one. */
  packed?: boolean;
  "aria-label"?: string;
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    for (let n = 1; n < options.length; n++) {
      const next = options[(idx + step * n + options.length * n) % options.length];
      if (!next.disabled) return onChange(next.value);
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKey}
      className={cn(
        "relative inline-grid min-w-max shrink-0 h-7 rounded-md bg-well p-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        disabled && "opacity-50",
        className,
      )}
      // Equal tracks keep the percentage-based thumb aligned; max-content prevents
      // nowrap labels from painting over each other even in a constrained grid.
      style={{ gridTemplateColumns: packed ? `repeat(${options.length}, max-content) minmax(0, 1fr)` : `repeat(${options.length}, minmax(max-content, 1fr))` }}
    >
      {!packed && <div
        aria-hidden
        className="absolute top-0.5 bottom-0.5 rounded-[5px] bg-(--surface-thumb) shadow-button transition-transform duration-150"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          left: 2,
          transform: `translateX(${idx * 100}%)`,
        }}
      />}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o["aria-label"]}
          title={o.title}
          tabIndex={-1}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative z-10 whitespace-nowrap rounded-[5px] px-2.5 font-medium transition-colors",
            o.value === value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            packed && o.value === value && "bg-(--surface-thumb) shadow-button",
            o.disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A setting row: ~14px above and below and a hairline under it, so a long page reads as rows (PRO-374, design 09.02). */
export const SETTING_ROW_CLASS = "flex flex-col gap-1.5 border-b border-hairline-strong py-3.5";

export function SettingRow({
  label,
  description,
  control,
  stacked,
  disabled,
  id,
  titleAccessory,
}: {
  label: string;
  /** Beside the title: where the value comes from and the row's actions (PRO-140). */
  titleAccessory?: React.ReactNode;
  description?: React.ReactNode;
  control: React.ReactNode;
  stacked?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className={cn(SETTING_ROW_CLASS, disabled && "opacity-60")}>
      <div className={cn("flex gap-4", stacked ? "flex-col" : "items-center justify-between")}>
        <div className="min-w-0">
          {titleAccessory ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <div id={id} className="text-[13px] font-medium">
                {label}
              </div>
              {titleAccessory}
            </div>
          ) : (
            <div id={id} className="text-[13px] font-medium">
              {label}
            </div>
          )}
          {description && <div className="text-xs leading-relaxed text-muted-foreground">{description}</div>}
        </div>
        <div className={cn(stacked ? "" : "shrink-0")}>{control}</div>
      </div>
    </div>
  );
}

/** The app's own checkbox: amber when on, as in the menus (never the system's blue). `label` names it for screen readers. */
export function Checkbox({ checked, disabled, onChange, label, title, className, children }: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  title?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return <label className={cn("flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground", disabled ? "cursor-not-allowed" : "cursor-pointer", className)} title={title}>
    <span className="relative grid size-3.5 shrink-0 place-items-center">
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)}
        className="peer size-3.5 appearance-none rounded-[4px] border border-muted-foreground/60 outline-none checked:border-transparent checked:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50" />
      <Check aria-hidden className="pointer-events-none absolute size-2.5 text-accent-foreground opacity-0 peer-checked:opacity-100" />
    </span>
    {children}
  </label>;
}
