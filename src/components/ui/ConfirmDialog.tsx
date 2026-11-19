import { useEffect, useRef, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { answerConfirm, chooseInApp, usePendingConfirm, type ConfirmAnswer, type ConfirmRequest } from "@/lib/confirm";
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
 * Cloud control's agreement is a system alert on purpose: an agent driving this web view must not be able to give it.
 */
export function ConfirmDialogHost() {
  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWebviewWindow();
    if (window.label !== "main") return;
    let stopped = false;
    // Only a card Rust accepted is active. Any web view with event access can
    // emit "quit-prompt", so an event alone never dismisses or replaces it.
    let active: { id: string; controller: AbortController } | undefined;
    const send = (id: string, reply: "opened" | "heartbeat" | ConfirmAnswer) =>
      invoke<boolean>("reply_to_quit_prompt", { id, reply });
    const unlisten = window.listen<[string, ConfirmRequest | null]>("quit-prompt", async ({ payload: [id, request] }) => {
      if (stopped) return;
      if (!request) {
        // A withdrawal counts only if Rust no longer waits on this card.
        const withdrawn = active;
        if (withdrawn?.id !== id) return;
        try {
          if (await send(id, "heartbeat")) return;
        } catch {
          // Unknown: the regular heartbeat decides.
          return;
        }
        if (active === withdrawn) withdrawn.controller.abort();
        return;
      }
      if (active?.id === id) return;
      // Rust holds one prompt at a time: a claim it accepts for this ID means
      // the active card's prompt is gone. A rejected claim leaves it alone.
      if (!await send(id, "opened").catch((error) => {
        console.error("Quit confirmation failed", error);
        return false;
      }) || stopped) return;
      active?.controller.abort();
      const controller = new AbortController();
      active = { id, controller };
      const { signal } = controller;

      try {
        // Keep one heartbeat in flight. Stop renewing as soon as a choice is made.
        let renewing = false;
        const heartbeat = setInterval(async () => {
          if (renewing || signal.aborted) return;
          renewing = true;
          try {
            if (!await send(id, "heartbeat")) controller.abort();
          } catch {
            // The next heartbeat can renew the wait if IPC recovers.
          } finally {
            renewing = false;
          }
        }, 2_000);
        const answer = await chooseInApp(request, signal).finally(() => clearInterval(heartbeat));
        if (signal.aborted) return;
        try {
          await send(id, answer);
        } catch {
          // The ID makes a retry safe if Rust already received the answer.
          if (!signal.aborted) await send(id, answer);
        }
      } catch (error) {
        console.error("Quit confirmation failed", error);
      } finally {
        if (active?.controller === controller) active = undefined;
      }
    }).catch((error) => console.error("Quit confirmation listener failed", error));
    return () => {
      stopped = true;
      active?.controller.abort();
      void unlisten.then((stop) => stop?.());
    };
  }, []);

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
