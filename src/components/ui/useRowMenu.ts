import { useCallback, useRef, useState, type PointerEvent } from "react";

/**
 * A menu that opens on a mouse click, an accessibility press and the keyboard.
 * Radix opens a menu on pointerdown and never on a click, so a press through
 * the accessibility tree (a click with no pointerdown) did nothing, and in a
 * row whose actions are hidden until hover the opening pointerdown was
 * followed by the menu closing again. Here the menu is controlled: the
 * pointerdown is left to the click, the click toggles it, and the keyboard
 * keeps Radix's own Enter, Space and ArrowDown handling. While it is open the
 * row keeps its actions shown, whatever the hover state.
 *
 * Spread `trigger` on the `DropdownMenuTrigger`. It carries the menu's
 * `data-state`, so a `WithTooltip` wrapped around the trigger (whose own
 * `data-state` would otherwise win the prop merge) cannot mark an open menu's
 * trigger as closed.
 *
 * `onOpenChange` hears every change (to refresh a list when it opens, say);
 * `setOpen` opens or closes it from elsewhere (a hotkey).
 */
export function useRowMenu({ onOpenChange }: { onOpenChange?: (open: boolean) => void } = {}) {
  const [open, setOpenState] = useState(false);
  // Whether the menu was open when the press began; null when no pointerdown preceded the click (an accessibility press).
  const wasOpen = useRef<boolean | null>(null);
  const heard = useRef(onOpenChange);
  heard.current = onOpenChange;
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    heard.current?.(next);
  }, []);
  return {
    open,
    setOpen,
    root: { open, onOpenChange: setOpen },
    trigger: {
      "data-state": open ? "open" : "closed",
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        // Remembered before the outside-press of an open menu closes it, so this click closes rather than reopens.
        wasOpen.current = open;
        event.preventDefault();
      },
      onClick: () => {
        const before = wasOpen.current ?? open;
        wasOpen.current = null;
        setOpen(!before);
      },
      onKeyDown: () => {
        wasOpen.current = open;
      },
    },
  };
}
