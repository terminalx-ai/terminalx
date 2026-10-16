import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "@/icons";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showClose?: boolean;
    width?: string;
    /**
     * Every dialog is kept inside the window. "page" scrolls the dialog as a
     * whole when it is too tall. "pinned" is for a dialog holding a list that
     * can grow without limit: the list goes in a `DialogScrollArea`, which
     * scrolls on its own while the header and footer stay where they are.
     */
    layout?: "page" | "pinned";
  }
>(({ className, children, showClose = true, width = "max-w-[34rem]", layout = "page", ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay data-dialog-overlay className="fixed inset-0 z-(--z-dialog-overlay) bg-black/35 data-[state=open]:animate-fade-in" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-(--z-dialog) w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover glass p-5 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in",
        // Should the header and footer alone be taller than the window, the dialog still scrolls as a whole.
        "max-h-[calc(100dvh-2rem)] overflow-y-auto scrollbar-thin",
        layout === "pinned" && "flex flex-col",
        width,
        className,
      )}
      {...props}
    >
      {children}
      {showClose && (
        <DialogPrimitive.Close asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close"
            className="absolute right-3 top-3 text-muted-foreground"
          >
            <X />
          </Button>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4 flex shrink-0 flex-col gap-1", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-5 flex shrink-0 flex-wrap justify-end gap-2", className)} {...props} />;
}

/**
 * The scrolling part of a `layout="pinned"` dialog. It takes the height the
 * header and footer leave, and is a tab stop so the keyboard can scroll it
 * (arrows, Page Up/Down, Home/End); name it with `aria-label`.
 */
export const DialogScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    role="group"
    tabIndex={0}
    data-dialog-scroll-area
    className={cn("-mr-2 min-h-16 shrink overflow-y-auto overscroll-contain rounded-lg pr-2 outline-none scrollbar-thin focus-visible:ring-1 focus-visible:ring-ring/50", className)}
    {...props}
  />
));
DialogScrollArea.displayName = "DialogScrollArea";
