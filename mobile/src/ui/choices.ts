import { ActionSheetIOS, Alert, Platform } from "react-native";

/**
 * Offer `choices` from the system's own chooser and call `choose` with the one
 * picked. iOS shows its action sheet with a Cancel row. Android has no action
 * sheet (`ActionSheetIOS` throws there), so it shows an alert of the choices,
 * dismissed by tapping outside it: an alert holds three buttons at most, so
 * Cancel is not one of them.
 */
export function showChoices(title: string, choices: readonly string[], choose: (choice: string) => void): void {
  if (!choices.length) return;
  if (Platform.OS === "ios") {
    const options = [...choices, "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: choices.length }, (index) => {
      const choice = choices[index];
      if (choice !== undefined) choose(choice);
    });
    return;
  }
  Alert.alert(title, undefined, choices.slice(0, 3).map((choice) => ({ text: choice, onPress: () => choose(choice) })), { cancelable: true });
}
