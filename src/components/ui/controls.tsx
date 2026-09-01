import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { size?: "sm" | "md" }
>(({ className, size = "md", ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=unchecked]:bg-well",
      size === "md" ? "h-4 w-7" : "h-3 w-5",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block rounded-full bg-white shadow-button transition-transform",
        size === "md"
          ? "size-3 data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0.5"
          : "size-2 data-[state=checked]:translate-x-2.5 data-[state=unchecked]:translate-x-0.5",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

/** A track with a sliding thumb; one Tab stop, arrows move inside it. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      onChange(options[(idx + 1) % options.length].value);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(options[(idx - 1 + options.length) % options.length].value);
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
        "relative inline-grid h-7 rounded-md bg-well p-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        disabled && "opacity-50",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <div
        aria-hidden
        className="absolute top-0.5 bottom-0.5 rounded-[5px] bg-(--surface-thumb) shadow-button transition-transform duration-150"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          left: 2,
          transform: `translateX(${idx * 100}%)`,
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={-1}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative z-10 whitespace-nowrap rounded-[5px] px-2.5 font-medium transition-colors",
            o.value === value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingRow({
  label,
  description,
  control,
  stacked,
  disabled,
  id,
}: {
  label: string;
  description?: React.ReactNode;
  control: React.ReactNode;
  stacked?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5 py-2", disabled && "opacity-60")}>
      <div className={cn("flex gap-4", stacked ? "flex-col" : "items-center justify-between")}>
        <div className="min-w-0">
          <div id={id} className="text-[13px] font-medium">
            {label}
          </div>
          {description && <div className="text-xs leading-relaxed text-muted-foreground">{description}</div>}
        </div>
        <div className={cn(stacked ? "" : "shrink-0")}>{control}</div>
      </div>
    </div>
  );
}
