import * as React from "react";
import { ContextMenu as Ctx, DropdownMenu as Prim } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

export const DropdownMenu = Prim.Root;
export const DropdownMenuTrigger = Prim.Trigger;
export const DropdownMenuGroup = Prim.Group;
export const DropdownMenuSub = Prim.Sub;
export const DropdownMenuSubTrigger = Prim.SubTrigger;
export const DropdownMenuRadioGroup = Prim.RadioGroup;

const contentClass =
  "z-(--z-menu) min-w-[10rem] overflow-hidden rounded-lg bg-popover glass p-1 text-popover-foreground shadow-surface hairline animate-fade-in";

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof Prim.Content>,
  React.ComponentPropsWithoutRef<typeof Prim.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <Prim.Portal>
    <Prim.Content ref={ref} sideOffset={sideOffset} className={cn(contentClass, className)} {...props} />
  </Prim.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof Prim.SubContent>,
  React.ComponentPropsWithoutRef<typeof Prim.SubContent>
>(({ className, ...props }, ref) => (
  <Prim.Portal>
    <Prim.SubContent ref={ref} className={cn(contentClass, className)} {...props} />
  </Prim.Portal>
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

const itemClass =
  "relative flex cursor-default select-none items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-veil-strong data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

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

export function ContextMenuSeparator({ className }: { className?: string }) {
  return <Ctx.Separator className={cn("my-1 h-px bg-hairline", className)} />;
}
