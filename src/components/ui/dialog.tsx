import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "@/icons";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { useNoticeDeferral } from "@/lib/noticeDeferral";

function DeferDialogNotices() {
  useNoticeDeferral(true, "modal");
  return null;
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

/**
 * Most dialogs are rendered only while open, so closing one removes it at
 * once and Radix never gets to play its exit. When a dialog leaves while
 * still drawn open, a copy of it and its backdrop stays for the length of the
 * exit animation, inert and hidden from assistive technology, then goes. A
 * dialog Radix closed itself has already animated out and is left alone.
 * Not in a document without animations (tests), nor under reduced motion.
 */
export function leaveGracefully(node: HTMLElement | null) {
  if (!node || node.getAttribute("data-state") !== "open") return;
  if (typeof document.documentElement.getAnimations !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const overlay = node.previousElementSibling instanceof HTMLElement && node.previousElementSibling.hasAttribute("data-dialog-overlay") ? node.previousElementSibling : null;
  const ghosts = [overlay, node].flatMap((el) => {
    if (!el) return [];
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("id");
    ghost.removeAttribute("role");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.style.pointerEvents = "none";
    ghost.dataset.dialogGhost = "";
    if (el === node) ghost.scrollTop = node.scrollTop;
    ghost.setAttribute("data-state", "closed");
    document.body.appendChild(ghost);
    return [ghost];
  });
  const done = () => ghosts.forEach((ghost) => ghost.remove());
  // Its own exit only: animations inside it (a looping illustration) end too, and bubble.
  const dialog = ghosts.at(-1);
  dialog?.addEventListener("animationend", (event) => { if (event.target === dialog) done(); });
  window.setTimeout(done, 400);
}

/** A ref for a dialog's content that plays its exit even when the dialog is removed at once (`leaveGracefully`). */
export function useGracefulLeave<T extends HTMLElement>() {
  const node = React.useRef<T | null>(null);
  React.useLayoutEffect(() => () => leaveGracefully(node.current), []);
  return node;
}

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
>(({ className, children, showClose = true, width = "max-w-[34rem]", layout = "page", ...props }, ref) => {
  const own = React.useRef<HTMLDivElement | null>(null);
  const setRef = React.useCallback((node: HTMLDivElement | null) => {
    own.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  // Read as the dialog unmounts, while its node still says how it was drawn.
  React.useLayoutEffect(() => () => leaveGracefully(own.current), []);
  return (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay data-dialog-overlay className="fixed inset-0 z-(--z-dialog-overlay) bg-black/35 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
    <DialogPrimitive.Content
      ref={setRef}
      className={cn(
        "fixed left-1/2 top-1/2 z-(--z-dialog) w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover glass p-5 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out",
        // Should the header and footer alone be taller than the window, the dialog still scrolls as a whole.
        "max-h-[calc(100dvh-2rem)] overflow-y-auto scrollbar-thin",
        layout === "pinned" && "flex flex-col",
        width,
        className,
      )}
      {...props}
    >
      <DeferDialogNotices />
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
  );
});
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
