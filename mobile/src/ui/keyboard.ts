import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * The keyboard events to follow: iOS says the keyboard will move, Android
 * only that it did (it never sends the `Will` events).
 */
export function keyboardEvents(os: string = Platform.OS) {
  return os === "ios" ? { show: "keyboardWillShow", hide: "keyboardWillHide" } as const : { show: "keyboardDidShow", hide: "keyboardDidHide" } as const;
}

/**
 * Whether the keyboard is up (or on its way). A composer docked at the bottom
 * keeps room for the home indicator only while it is down: over the keyboard
 * it needs none.
 */
export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const events = keyboardEvents();
    const show = Keyboard.addListener(events.show, () => setShown(true));
    const hide = Keyboard.addListener(events.hide, () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

/**
 * How a view makes room for the keyboard: it pads itself, on Android as on iOS, so a sheet's field and
 * buttons sit above the keyboard. Android draws edge to edge, where the window no longer shrinks for the
 * keyboard; a page with no such view is panned by the system instead (app.json's
 * `softwareKeyboardLayoutMode: "pan"`), which keeps the field being typed into in sight.
 */
export function keyboardAvoidingBehavior(_os: string = Platform.OS): "padding" {
  return "padding";
}
