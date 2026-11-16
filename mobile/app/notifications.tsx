import { Stack } from "expo-router";
import { NotificationsPage } from "@mobile/ui/notifications/NotificationsPage";

export default function NotificationsScreen() {
  return <><Stack.Screen options={{ title: "Notifications", headerLargeTitle: false, headerBackTitle: "Settings" }} /><NotificationsPage /></>;
}
