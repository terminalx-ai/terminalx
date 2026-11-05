/**
 * The reader's input on a page preview, as the DevTools `Input.*` commands
 * that replay it in the page. Pure: the view measures, this translates.
 */

export interface PageInputEvent {
  method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText";
  params: Record<string, unknown>;
}

type Modifiers = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** DevTools' modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(e: Modifiers): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** A point on the preview image in the page's own CSS pixels. */
export function toPagePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, page: { width: number; height: number }) {
  const x = ((clientX - rect.left) / Math.max(rect.width, 1)) * page.width;
  const y = ((clientY - rect.top) / Math.max(rect.height, 1)) * page.height;
  return { x: Math.max(0, Math.min(page.width, x)), y: Math.max(0, Math.min(page.height, y)) };
}

const BUTTONS = ["left", "middle", "right", "back", "forward"] as const;

export function mouseEvent(
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  point: { x: number; y: number },
  e: Modifiers & { button: number; buttons: number; detail?: number },
): PageInputEvent {
  const pressed = type !== "mouseMoved";
  const button = pressed ? (BUTTONS[e.button] ?? "left") : e.buttons & 1 ? "left" : e.buttons & 4 ? "middle" : e.buttons & 2 ? "right" : "none";
  return {
    method: "Input.dispatchMouseEvent",
    params: { type, x: point.x, y: point.y, button, buttons: e.buttons, clickCount: pressed ? Math.max(1, e.detail ?? 1) : 0, modifiers: modifiersOf(e) },
  };
}

export function wheelEvent(point: { x: number; y: number }, deltaX: number, deltaY: number, modifiers: number): PageInputEvent {
  return { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY, modifiers } };
}

/** A wheel delta in pixels, whatever unit the device reported it in. */
export function wheelPixels(delta: number, mode: number, pageHeight: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * pageHeight;
  return delta;
}

type Key = Modifiers & { key: string; code: string; keyCode: number; location?: number; repeat?: boolean };

/**
 * The editing command a shortcut stands for. On a Mac the page does not
 * turn ⌘C or ⌘A into an action from key events alone; DevTools takes the
 * command with the key. ⌘V is left to the paste event, which carries the text.
 */
export function editingCommand(e: Key, mac: boolean): string | null {
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.altKey) return null;
  switch (e.key.toLowerCase()) {
    case "a":
      return e.shiftKey ? null : "selectAll";
    case "c":
      return e.shiftKey ? null : "copy";
    case "x":
      return e.shiftKey ? null : "cut";
    case "z":
      return e.shiftKey ? "redo" : "undo";
    default:
      return null;
  }
}

/** Whether a key press belongs to the page rather than to the app's own shortcuts. */
export function keyForPage(e: Key, mac: boolean): boolean {
  if (editingCommand(e, mac)) return true;
  // Other ⌘ / Ctrl chords are the app's (new tab, palette, close…), and ⌘V is the paste event's.
  return mac ? !e.metaKey : !e.ctrlKey;
}

/** The text a key types, if it types one. */
function typed(e: Key): string | undefined {
  if (e.key === "Enter") return "\r";
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) return e.key;
  return undefined;
}

export function keyEvents(type: "down" | "up", e: Key, mac: boolean): PageInputEvent {
  const text = type === "down" ? typed(e) : undefined;
  const command = type === "down" ? editingCommand(e, mac) : null;
  return {
    method: "Input.dispatchKeyEvent",
    params: {
      type: type === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      modifiers: modifiersOf(e),
      location: e.location ?? 0,
      autoRepeat: !!e.repeat,
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(command ? { commands: [command] } : {}),
    },
  };
}

export function insertText(text: string): PageInputEvent {
  return { method: "Input.insertText", params: { text } };
}
