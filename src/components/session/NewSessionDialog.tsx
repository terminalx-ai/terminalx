import { Dialog as DialogPrimitive } from "radix-ui";
import type { ImageInput } from "@/lib/api";
import { NewSessionView } from "./NewSessionView";
import { useGracefulLeave } from "@/components/ui/dialog";

/**
 * The new-session form over the session it was opened from, which stays
 * drawn, dimmed, behind it. Escape or a click outside goes back to it.
 */
export function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (sessionId: string, tabId: string, text: string, images?: ImageInput[]) => void }) {
  const content = useGracefulLeave<HTMLDivElement>();
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-dialog-overlay className="fixed inset-0 z-(--z-dialog-overlay) bg-black/45 backdrop-blur-[2px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="new-session-dialog"
          ref={content}
          // Its top edge is pinned where the full form sits when centred, not centred itself: what it reads after
          // opening (projects, models, branches) makes it taller, and a centred form would jump up as it grew.
          // Growing downward from a fixed top, it opens once, in place, with the same rise as every dialog.
          className="fixed left-1/2 top-[max(1rem,calc(50dvh-17rem))] z-(--z-dialog) max-h-[calc(100dvh-max(1rem,calc(50dvh-17rem))-1rem)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 overflow-y-auto outline-none data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out"
        >
          <DialogPrimitive.Title className="sr-only">New session</DialogPrimitive.Title>
          <NewSessionView modal onCreated={onCreated} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
