import { describe, expect, it } from "vitest";
import { editingCommand, keyEvents, keyForPage, modifiersOf, mouseEvent, toPagePoint, viewportEvent, wheelPixels } from "./browserInput";

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const key = (k: string, code: string, keyCode: number, mods: Partial<typeof none> = {}) => ({ ...none, ...mods, key: k, code, keyCode });

describe("the reader's input on a page preview", () => {
  it("maps a point on the scaled preview to the page's own pixels, inside the page", () => {
    const rect = { left: 100, top: 50, width: 640, height: 400 };
    expect(toPagePoint(420, 250, rect, { width: 1280, height: 800 })).toEqual({ x: 640, y: 400 });
    expect(toPagePoint(0, 0, rect, { width: 1280, height: 800 })).toEqual({ x: 0, y: 0 });
  });

  it("sends a click as its button and count, a drag's moves with the button held", () => {
    const at = { x: 10, y: 20 };
    expect(mouseEvent("mousePressed", at, { ...none, button: 0, buttons: 1, detail: 2 }).params).toMatchObject({ type: "mousePressed", button: "left", clickCount: 2 });
    expect(mouseEvent("mousePressed", at, { ...none, button: 2, buttons: 2 }).params).toMatchObject({ button: "right", clickCount: 1 });
    expect(mouseEvent("mouseMoved", at, { ...none, button: 0, buttons: 1 }).params).toMatchObject({ button: "left", clickCount: 0 });
    expect(mouseEvent("mouseMoved", at, { ...none, button: 0, buttons: 0 }).params).toMatchObject({ button: "none" });
  });

  it("encodes modifiers as DevTools does and wheel lines as pixels", () => {
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modifiersOf({ ...none, shiftKey: true })).toBe(8);
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(1, 2, 800)).toBe(800);
  });

  it("types text with a printable key, and a named key without", () => {
    expect(keyEvents("down", key("a", "KeyA", 65), true).params).toMatchObject({ type: "keyDown", text: "a" });
    expect(keyEvents("down", key("Enter", "Enter", 13), true).params).toMatchObject({ type: "keyDown", text: "\r" });
    expect(keyEvents("down", key("Backspace", "Backspace", 8), true).params).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 8 });
    expect(keyEvents("down", key("Backspace", "Backspace", 8), true).params).not.toHaveProperty("text");
    expect(keyEvents("up", key("a", "KeyA", 65), true).params).toMatchObject({ type: "keyUp" });
  });

  it("gives editing shortcuts to the page as commands, and leaves the app its own", () => {
    expect(editingCommand(key("a", "KeyA", 65, { metaKey: true }), true)).toBe("selectAll");
    expect(editingCommand(key("z", "KeyZ", 90, { metaKey: true, shiftKey: true }), true)).toBe("redo");
    expect(editingCommand(key("c", "KeyC", 67, { ctrlKey: true }), false)).toBe("copy");
    expect(keyEvents("down", key("c", "KeyC", 67, { metaKey: true }), true).params).toMatchObject({ commands: ["copy"] });
    // ⌘T, ⌘K and the like stay the app's; ⌘V is the paste event's.
    expect(keyForPage(key("t", "KeyT", 84, { metaKey: true }), true)).toBe(false);
    expect(keyForPage(key("v", "KeyV", 86, { metaKey: true }), true)).toBe(false);
    expect(keyForPage(key("a", "KeyA", 65), true)).toBe(true);
  });
});

describe("the page's viewport", () => {
  it("is the view's size at the screen's ratio, lowered to keep the frame within bounds", () => {
    expect(viewportEvent(520, 900, 2).params).toEqual({ width: 520, height: 900, deviceScaleFactor: 2, mobile: false });
    expect(viewportEvent(1400, 900, 2).params).toMatchObject({ width: 1400, deviceScaleFactor: 1.46 });
    expect(viewportEvent(50, 50, 1).params).toMatchObject({ width: 200, height: 200, deviceScaleFactor: 1 });
  });
});
