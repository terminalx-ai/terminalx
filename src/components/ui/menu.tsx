import * as React from "react";
import { ContextMenu as Ctx, DropdownMenu as Prim } from "radix-ui";
import { Check, ChevronRight } from "@/icons";
import { cn } from "@/lib/cn";

export const DropdownMenu = Prim.Root;
export const DropdownMenuTrigger = Prim.Trigger;
export const DropdownMenuGroup = Prim.Group;
export const DropdownMenuSub = Prim.Sub;
export const DropdownMenuRadioGroup = Prim.RadioGroup;

/**
 * How far a menu keeps from the window's edges when it has to move to fit
 * (Radix flips or shifts it): it never sits flush, so its opening slide
 * (`animate-fade-in`) never pokes past the window either.
 */
const COLLISION_PADDING = 8;

const contentClass =
  "z-(--z-menu) min-w-[10rem] overflow-hidden rounded-lg bg-popover glass p-1 text-popover-foreground shadow-surface hairline animate-fade-in";

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof Prim.Content>,
  React.ComponentPropsWithoutRef<typeof Prim.Content>
>(({ className, sideOffset = 4, collisionPadding = COLLISION_PADDING, ...props }, ref) => (
  <Prim.Portal>
    <Prim.Content ref={ref} sideOffset={sideOffset} collisionPadding={collisionPadding} className={cn(contentClass, className)} {...props} />
  </Prim.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof Prim.SubContent>,
  React.ComponentPropsWithoutRef<typeof Prim.SubContent>
>(({ className, collisionPadding = COLLISION_PADDING, ...props }, ref) => (
  <Prim.Portal>
    {/* Beside its row, flipped to the other side or shifted up when the window has no room there. */}
    <Prim.SubContent ref={ref} collisionPadding={collisionPadding} avoidCollisions className={cn(contentClass, className)} {...props} />
  </Prim.Portal>
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

const itemClass =
  "relative flex cursor-default select-none items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-veil-strong data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** A row that opens a submenu, styled as an item; the arrow at its end says so. */
export const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof Prim.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof Prim.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <Prim.SubTrigger ref={ref} className={cn(itemClass, "data-[state=open]:bg-veil-strong", className)} {...props}>
    {children}
    <ChevronRight className="ml-auto size-3.5! text-faint!" />
  </Prim.SubTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof Prim.Item>,
  React.ComponentPropsWithoutRef<typeof Prim.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <Prim.Item
    ref={ref}
    className={cn(itemClass, destructive && "text-destructive [&_svg]:text-destructive", className)}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof Prim.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof Prim.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <Prim.CheckboxItem ref={ref} className={cn(itemClass, "pr-7", className)} {...props}>
    {children}
    <Prim.ItemIndicator className="absolute right-2">
      <Check className="size-3.5" />
    </Prim.ItemIndicator>
  </Prim.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof Prim.RadioItem>,
  React.ComponentPropsWithoutRef<typeof Prim.RadioItem>
>(({ className, children, ...props }, ref) => (
  <Prim.RadioItem ref={ref} className={cn(itemClass, "pr-7", className)} {...props}>
    {children}
    <Prim.ItemIndicator className="absolute right-2">
      <Check className="size-3.5" />
    </Prim.ItemIndicator>
  </Prim.RadioItem>
));
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";

export function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-faint", className)} {...props} />;
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <Prim.Separator className={cn("my-1 h-px bg-hairline", className)} />;
}

export function MenuShortcut({ keys }: { keys: string[] }) {
  return (
    <span className="ml-auto flex gap-0.5 pl-4 text-[11px] text-faint">
      {keys.map((k, i) => (
        <span key={i}>{k}</span>
      ))}
    </span>
  );
}

// ---- Context menus share the dropdown's look; only the trigger differs.

export const ContextMenu = Ctx.Root;
export const ContextMenuTrigger = Ctx.Trigger;

export const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof Ctx.Content>,
  React.ComponentPropsWithoutRef<typeof Ctx.Content>
>(({ className, ...props }, ref) => (
  <Ctx.Portal>
    <Ctx.Content ref={ref} className={cn(contentClass, className)} {...props} />
  </Ctx.Portal>
));
ContextMenuContent.displayName = "ContextMenuContent";

export const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof Ctx.Item>,
  React.ComponentPropsWithoutRef<typeof Ctx.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <Ctx.Item ref={ref} className={cn(itemClass, destructive && "text-destructive [&_svg]:text-destructive", className)} {...props} />
));
ContextMenuItem.displayName = "ContextMenuItem";

export const ContextMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof Ctx.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof Ctx.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <Ctx.CheckboxItem ref={ref} className={cn(itemClass, "pr-7", className)} {...props}>
    {children}
    <Ctx.ItemIndicator className="absolute right-2">
      <Check className="size-3.5" />
    </Ctx.ItemIndicator>
  </Ctx.CheckboxItem>
));
ContextMenuCheckboxItem.displayName = "ContextMenuCheckboxItem";

export function ContextMenuSeparator({ className }: { className?: string }) {
  return <Ctx.Separator className={cn("my-1 h-px bg-hairline", className)} />;
}

export const ContextMenuSub = Ctx.Sub;

/** A row that opens a submenu; the arrow at its end says so. */
export const ContextMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof Ctx.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof Ctx.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <Ctx.SubTrigger ref={ref} className={cn(itemClass, "data-[state=open]:bg-veil-strong", className)} {...props}>
    {children}
    <ChevronRight className="ml-auto size-3.5! text-faint!" />
  </Ctx.SubTrigger>
));
ContextMenuSubTrigger.displayName = "ContextMenuSubTrigger";

export const ContextMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof Ctx.SubContent>,
  React.ComponentPropsWithoutRef<typeof Ctx.SubContent>
>(({ className, ...props }, ref) => (
  <Ctx.Portal>
    <Ctx.SubContent ref={ref} className={cn(contentClass, className)} {...props} />
  </Ctx.Portal>
));
ContextMenuSubContent.displayName = "ContextMenuSubContent";

/** A heading over a group of items, as in a dropdown. */
export const ContextMenuLabel = DropdownMenuLabel;
