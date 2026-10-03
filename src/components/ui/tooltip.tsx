import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";
import { keycaps, useKeymap, type ShortcutId } from "@/lib/shortcuts";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-(--z-tooltip) flex items-center gap-2 rounded-md bg-popover glass px-2.5 py-1.5 text-xs text-popover-foreground shadow-surface hairline animate-fade-in has-[>[data-slot=kbd]:first-child]:pl-1.5 has-[>[data-slot=kbd]]:pr-1.5",
        className,
      )}
      {...props}
    >
      {children}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = "TooltipContent";

export function Kbd({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-veil-strong px-1 font-sans text-[11px] font-medium text-foreground/80",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function KbdGroup({ keys }: { keys: string[] }) {
  return (
    <span data-slot="kbd" className="inline-flex items-center gap-0.5">
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

/** Wrap any element with a tooltip carrying a label and optional shortcut. */
export function WithTooltip({
  label,
  keys: fixedKeys,
  shortcut,
  side = "bottom",
  children,
}: {
  label?: string;
  keys?: string[];
  /** The action whose current keys to show, kept up to date when the reader changes them. */
  shortcut?: ShortcutId;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactElement;
}) {
  if (shortcut) return <ShortcutTooltip label={label} shortcut={shortcut} side={side} children={children} />;
  const keys = fixedKeys;
  if (!label && !keys?.length) return children;
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {keys?.length ? <KbdGroup keys={keys} /> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** A tooltip whose keys are the action's current ones; only these follow the keymap. */
function ShortcutTooltip({ label, shortcut, side, children }: { label?: string; shortcut: ShortcutId; side: "top" | "bottom" | "left" | "right"; children: React.ReactElement }) {
  const first = useKeymap()[shortcut][0];
  return (
    <WithTooltip label={label} keys={first ? keycaps(first) : []} side={side}>
      {children}
    </WithTooltip>
  );
}
