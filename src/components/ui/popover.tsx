import { forwardRef, useId, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { Popover as Primitive } from "radix-ui";
import { X } from "@/icons";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverClose = Primitive.Close;

/** A named, non-modal detail surface. Radix owns dismissal, collision and return focus. */
export const PopoverContent = forwardRef<
  ComponentRef<typeof Primitive.Content>,
  Omit<ComponentPropsWithoutRef<typeof Primitive.Content>, "aria-label" | "aria-labelledby"> & { label: string }
>(({ label, className, children, sideOffset = 4, collisionPadding = 8, ...props }, ref) => {
  const titleId = useId();
  return (
    <Primitive.Portal>
      <Primitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...props}
        aria-labelledby={titleId}
        className={cn("z-(--z-menu) w-80 max-w-[calc(100vw-1rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain rounded-lg bg-popover p-3 text-popover-foreground shadow-surface hairline outline-none focus-visible:outline-2 focus-visible:outline-foreground motion-safe:data-[state=open]:animate-fade-in", className)}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 id={titleId} className="min-w-0 break-words text-sm font-medium">{label}</h2>
          <Primitive.Close asChild><Button variant="ghost" size="icon-xs" aria-label={`Close ${label}`}><X aria-hidden /></Button></Primitive.Close>
        </div>
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
});
PopoverContent.displayName = "PopoverContent";
