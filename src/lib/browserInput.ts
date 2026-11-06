/**
 * The reader's input on a page preview, as the DevTools `Input.*` commands
 * that replay it in the page. Pure: the view measures, this translates.
 */

export interface PageInputEvent {
  method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText" | "Emulation.setDeviceMetricsOverride";
  params: Record<string, unknown>;
}

type Modifiers = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** DevTools' modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(e: Modifiers): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/**
 * Where a frame is drawn in an image box that fits it whole (`object-contain`,
 * centred across, at the top): a frame of another shape than the box, as
 * while a resize settles, leaves bands beside or under it.
 */
export function drawnArea(box: { left: number; top: number; width: number; height: number }, page: { width: number; height: number }) {
  const scale = Math.min(box.width / Math.max(page.width, 1), box.height / Math.max(page.height, 1));
  const width = page.width * scale;
  const height = page.height * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top, width, height };
}

/** A point on the preview image in the page's own CSS pixels, through where the frame is drawn in it. */
export function toPagePoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, page: { width: number; height: number }) {
  const area = drawnArea(box, page);
  const x = ((clientX - area.left) / Math.max(area.width, 1)) * page.width;
  const y = ((clientY - area.top) / Math.max(area.height, 1)) * page.height;
  return { x: Math.max(0, Math.min(page.width, x)), y: Math.max(0, Math.min(page.height, y)) };
}

/** Presses this close in time and place are one double (or triple) click. */
export const MULTI_CLICK_MS = 500;
export const MULTI_CLICK_PX = 4;

/**
 * Counts a press into a run of clicks. Pointer events carry no click count
 * (their \`detail\` is 0), so a double click is counted here from the last press.
 */
export function nextClickCount(last: { at: number; x: number; y: number; button: number; count: number } | null, press: { at: number; x: number; y: number; button: number }): number {
  if (!last || last.button !== press.button || press.at - last.at > MULTI_CLICK_MS) return 1;
  if (Math.abs(press.x - last.x) > MULTI_CLICK_PX || Math.abs(press.y - last.y) > MULTI_CLICK_PX) return 1;
  return last.count + 1;
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

/** The largest frame side the stream sends; the view's scale keeps under it. */
export const MAX_FRAME_SIDE = 2048;

/**
 * Lay the page out at the view's size, at the screen's pixel ratio, so it
 * fills the view crisp the way a page in the app would. The ratio is lowered
 * when the view in device pixels would pass the largest frame.
 */
export function viewportEvent(width: number, height: number, pixelRatio: number): PageInputEvent {
  const w = Math.max(200, Math.floor(width));
  const h = Math.max(200, Math.floor(height));
  const scale = Math.max(1, Math.min(pixelRatio, MAX_FRAME_SIDE / w, MAX_FRAME_SIDE / h));
  return { method: "Emulation.setDeviceMetricsOverride", params: { width: w, height: h, deviceScaleFactor: Math.round(scale * 100) / 100, mobile: false } };
}
