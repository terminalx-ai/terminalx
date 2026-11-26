import { ActionSheetIOS, Alert, Platform, type AccessibilityActionEvent } from "react-native";

/** Something a list row offers beyond opening it: Pin or Unpin (#1403). */
export interface RowAction { name: string; label: string; run(): void; /** Drawn in red: it deletes something (25.06). */ destructive?: boolean }

/** What the in-app sheet is asked to list: a row's title, the line under it, and its actions. */
export interface RowActionRequest { title: string; message?: string; actions: readonly RowAction[] }

let sheet: ((request: RowActionRequest) => void) | null = null;

/** The in-app sheet that lists a row's actions on Android (`RowActionSheetHost`); returns its removal. */
export function setRowActionSheet(show: (request: RowActionRequest) => void): () => void {
  sheet = show;
  return () => { if (sheet === show) sheet = null; };
}

/** Offer a row's actions from the system's own sheet, under the row's title and, when given, a line on what it can do now (25.10). */
export function showRowActions(title: string, actions: readonly RowAction[], message?: string): void {
  if (!actions.length) return;
  if (Platform.OS === "ios") {
    const options = [...actions.map((action) => action.label), "Cancel"];
    const destructive = actions.flatMap((action, index) => (action.destructive ? [index] : []));
    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: actions.length, ...(destructive.length ? { destructiveButtonIndex: destructive } : {}), title, ...(message ? { message } : {}) }, (index) => { actions[index]?.run(); });
  } else if (sheet) {
    // Android's alert holds three buttons at most and would drop the rest: the app's own sheet lists them all.
    sheet({ title, message, actions });
  } else {
    Alert.alert(title, message, [...actions.map((action) => ({ text: action.label, onPress: action.run, ...(action.destructive ? { style: "destructive" as const } : {}) })), { text: "Cancel", style: "cancel" as const }]);
  }
}

/**
 * What a row's pressable takes so its actions are where a list row's are: a
 * long press opens them, and VoiceOver names each among the row's actions.
 * Nothing when the row has none.
 */
export function rowActionProps(title: string, actions: readonly RowAction[]) {
  if (!actions.length) return {};
  return {
    onLongPress: () => showRowActions(title, actions),
    accessibilityActions: actions.map(({ name, label }) => ({ name, label })),
    onAccessibilityAction: (event: AccessibilityActionEvent) => { actions.find((action) => action.name === event.nativeEvent.actionName)?.run(); },
  };
}
