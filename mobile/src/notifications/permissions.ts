import * as Notifications from "expo-notifications";
import { Linking } from "react-native";

/** `IosAuthorizationStatus.PROVISIONAL`; the enum is not re-exported where lint can see it. */
const IOS_PROVISIONAL = 3;

export type PermissionState = "granted" | "denied" | "undetermined";

function stateOf(permission: Notifications.NotificationPermissionsStatus): PermissionState {
  // Provisional (quiet) delivery counts as on: iOS shows them in the list.
  if (permission.granted || permission.ios?.status === IOS_PROVISIONAL) return "granted";
  return permission.status === "denied" ? "denied" : "undetermined";
}

/** Whether iOS lets TerminalX notify, without asking. */
export async function notificationPermission(): Promise<PermissionState> {
  return stateOf(await Notifications.getPermissionsAsync());
}

/** Ask iOS when it has not been asked; once denied, only iOS Settings can change it. */
export async function requestNotificationPermission(): Promise<PermissionState> {
  const before = await notificationPermission();
  if (before !== "undetermined") return before;
  return stateOf(await Notifications.requestPermissionsAsync());
}

/** TerminalX's page in iOS Settings, where its notifications are turned back on. */
export function openNotificationSettings(): Promise<void> {
  return Linking.openSettings();
}
