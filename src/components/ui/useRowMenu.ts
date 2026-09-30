import { useRef, useState, type PointerEvent } from "react";

/**
 * A row menu that opens on a mouse click as well as from the keyboard.
 * Radix opens a menu on pointerdown; in a row whose actions are hidden until
 * hover, the opening pointerdown was followed by the menu closing again, so
 * mouse users never saw it. Here the menu is controlled: the pointerdown is
 * left to the click, the click toggles it, and the keyboard keeps Radix's
 * own Enter, Space and ArrowDown handling. While it is open the row keeps its
 * actions shown, whatever the hover state.
 */
export function useRowMenu() {
  const [open, setOpen] = useState(false);
  const wasOpen = useRef(false);
  return {
    open,
    root: { open, onOpenChange: setOpen },
    trigger: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        // Remembered before the outside-press of an open menu closes it, so this click closes rather than reopens.
        wasOpen.current = open;
        event.preventDefault();
      },
      onClick: () => setOpen(!wasOpen.current),
      onKeyDown: () => {
        wasOpen.current = open;
      },
    },
  };
}

