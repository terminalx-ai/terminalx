import { useMemo, type ReactNode, type RefObject } from "react";
import { Popover } from "radix-ui";
import { caretPosition } from "@/lib/caretPosition";
import { cn } from "@/lib/cn";

export const CARET_POPOVER_SURFACE = "z-(--z-menu) rounded-lg bg-popover text-popover-foreground shadow-surface hairline animate-fade-in";

/**
 * A list hung under one character of a textarea (the `#` or `@` that asked
 * for it), floating over whatever is below so the text never moves. It takes
 * no focus: the textarea keeps the caret and answers the keys. `anchorKey`
 * names the token, so the list stays put while the words after it are typed.
 */
export function CaretPopover({ field, index, anchorKey, label, onDismiss, testId, className, children }: {
  field: RefObject<HTMLTextAreaElement | null>;
  /** The character it hangs from. */
  index: number;
  anchorKey: string;
  label: string;
  onDismiss: () => void;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  const anchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => {
          const el = field.current;
          if (!el) return new DOMRect();
          const box = el.getBoundingClientRect();
          const at = caretPosition(el, index);
          return new DOMRect(box.left + at.left, box.top + at.top, 0, at.height);
        },
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new anchor per token, measured when asked
    [anchorKey],
  );
  return (
    <Popover.Root open>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          data-testid={testId}
          aria-label={label}
          // The prompt keeps the focus and the keys; a click in it is not a reason to close.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={onDismiss}
          className={cn(CARET_POPOVER_SURFACE, "w-[400px] max-w-[calc(100vw-2rem)]", className)}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
