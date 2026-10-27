import { Dialog as DialogPrimitive } from "radix-ui";
import type { ImageInput } from "@/lib/api";
import { NewSessionView } from "./NewSessionView";

/**
 * The new-session form over the session it was opened from, which stays
 * drawn, dimmed, behind it. Escape or a click outside goes back to it.
 */
export function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (sessionId: string, tabId: string, text: string, images?: ImageInput[]) => void }) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-dialog-overlay className="fixed inset-0 z-(--z-dialog-overlay) bg-black/45 backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="new-session-dialog"
          className="fixed left-1/2 top-1/2 z-(--z-dialog) max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto outline-none data-[state=open]:animate-fade-in"
        >
          <DialogPrimitive.Title className="sr-only">New session</DialogPrimitive.Title>
          <NewSessionView modal onCreated={onCreated} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
