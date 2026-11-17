import { useRef, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { answerConfirm, usePendingConfirm } from "@/lib/confirm";
import { cn } from "@/lib/cn";

/**
 * The app's confirmation card (design 17.01): the question, what happens,
 * then the choices, safe on the left and the action on the right. A
 * destructive action is red. Escape cancels; Return picks the action, which
 * holds the focus when the card opens.
 */
export function ConfirmDialog({ open, title, children, action, cancel = "Cancel", alternative, destructive, busy, error, onAction, onAlternative, onCancel }: {
  open: boolean;
  title: ReactNode;
  /** What happens. */
  children?: ReactNode;
  action: ReactNode;
  cancel?: ReactNode;
  alternative?: ReactNode;
  destructive?: boolean;
  /** The action is under way: nothing can be pressed and the card stays. */
  busy?: boolean;
  /** Why the action failed; the card stays open to say so. */
  error?: string | null;
  onAction: () => void;
  onAlternative?: () => void;
  onCancel: () => void;
}) {
  const actionButton = useRef<HTMLButtonElement | null>(null);
  // A long explanation (a path, a list of what is lost) reads better in a wider card than in a tall narrow one.
  const long = typeof children === "string" && children.length > 220;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <DialogContent
        data-confirm-dialog
        showClose={false}
        width={long ? "max-w-[30rem]" : "max-w-[22rem]"}
        className="p-4"
        onOpenAutoFocus={(event) => { event.preventDefault(); actionButton.current?.focus(); }}
      >
        <DialogTitle className="text-sm font-semibold [overflow-wrap:anywhere]">{title}</DialogTitle>
        {children
          ? <DialogDescription className="mt-1 whitespace-pre-line text-xs leading-[18px] text-muted-foreground [overflow-wrap:anywhere]">{children}</DialogDescription>
          // Radix wants a description or an explicit none; the title is the whole question here.
          : <DialogDescription className="sr-only">{title}</DialogDescription>}
        {error && <p role="alert" className="mt-2 text-xs leading-[18px] text-destructive [overflow-wrap:anywhere]">{error}</p>}
        <div className="mt-3.5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" className="text-muted-foreground" disabled={busy} onClick={onCancel}>{cancel}</Button>
          {alternative && <Button variant="outline" size="sm" className="text-muted-foreground" disabled={busy} onClick={onAlternative}>{alternative}</Button>}
          <Button ref={actionButton} variant={destructive ? "danger" : "default"} size="sm" className={cn(!destructive && "shadow-none")} disabled={busy} onClick={onAction}>{action}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Draws the question `confirmInApp` is waiting on. Mounted once per window.
 *
 * Quit is asked natively even with a window; tray quit may have no window (PRO-455). See docs/CONFIRMATIONS.md.
 * Cloud control's agreement is a system alert on purpose: an agent driving this web view must not be able to give it.
 */
export function ConfirmDialogHost() {
  const pending = usePendingConfirm();
  if (!pending) return null;
  const { id, request } = pending;
  return (
    <ConfirmDialog
      key={id}
      open
      title={request.title}
      action={request.action}
      cancel={request.cancel}
      alternative={request.alternative}
      destructive={request.destructive}
      onAction={() => answerConfirm(id, "action")}
      onAlternative={() => answerConfirm(id, "alternative")}
      onCancel={() => answerConfirm(id, "cancel")}
    >
      {request.body}
    </ConfirmDialog>
  );
}
