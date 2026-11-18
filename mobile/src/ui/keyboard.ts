import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

/**
 * Whether the keyboard is up (or on its way). A composer docked at the bottom
 * keeps room for the home indicator only while it is down: over the keyboard
 * it needs none.
 */
export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", () => setShown(true));
    const hide = Keyboard.addListener("keyboardWillHide", () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}
