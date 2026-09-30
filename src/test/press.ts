import { fireEvent } from "@testing-library/react";

/**
 * A real mouse click: the whole sequence a browser sends, in order
 * (pointerdown, mousedown, pointerup, mouseup, click). A menu that opens on
 * pointerdown and closes again later in the sequence fails here, where a bare
 * `fireEvent.click` would not notice.
 */
export function mouseClick(element: Element) {
  const button = { button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
  fireEvent.pointerDown(element, button);
  fireEvent.mouseDown(element, button);
  fireEvent.pointerUp(element, { ...button, buttons: 0 });
  fireEvent.mouseUp(element, { ...button, buttons: 0 });
  fireEvent.click(element, { ...button, buttons: 0 });
}

/** A press through the accessibility tree (VoiceOver, computer use): a click with no pointer events before it. */
export function accessibilityPress(element: Element) {
  fireEvent.click(element, { button: 0, detail: 0 });
}
