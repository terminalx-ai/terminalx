/** Keep the platform's editing menu in text fields, including rich-text editors. */
export function isContextMenuTextField(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!element) return false;
  const field = element.closest("input, textarea");
  if (field instanceof HTMLTextAreaElement) return true;
  if (field instanceof HTMLInputElement && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(field.type)) return true;
  const editable = element.closest("[contenteditable]");
  return !!editable && editable.getAttribute("contenteditable") !== "false";
}

export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

/** Open a pointer-based menu at its row when invoked from the keyboard. */
export function openContextMenu(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }));
}

export function suppressNativeContextMenu(event: { target: EventTarget | null; preventDefault: () => void }): void {
  if (!isContextMenuTextField(event.target)) event.preventDefault();
}

export function installAppContextMenu(): () => void {
  // Bubble after React's menu handlers: cancelling during capture would also
  // cancel Radix's own context-menu trigger. Portals reach this listener too.
  document.addEventListener("contextmenu", suppressNativeContextMenu);
  return () => document.removeEventListener("contextmenu", suppressNativeContextMenu);
}
