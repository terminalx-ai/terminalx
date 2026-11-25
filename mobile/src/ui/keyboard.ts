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
