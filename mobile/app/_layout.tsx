import "react-native-gesture-handler";
import { useEffect } from "react";
import { Stack, useRouter } from "expo-router";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "@mobile/state/AppProvider";
import { ThemeProvider, useTheme } from "@mobile/ui/theme";

export default function RootLayout() {
  return <SafeAreaProvider><ThemeProvider><AppProvider><Navigation /></AppProvider></ThemeProvider></SafeAreaProvider>;
}

function Navigation() {
  const { palette } = useTheme();
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const sessionId = response?.notification.request.content.data?.sessionId;
    const tabId = response?.notification.request.content.data?.tabId;
    if (typeof sessionId === "string" && sessionId && typeof tabId === "string" && tabId) router.push({ pathname: "/session/[sessionId]", params: { sessionId, tabId } });
  }, [response, router]);
  return <><StatusBar style="auto" /><Stack screenOptions={{ headerLargeTitle: true, headerTransparent: false, headerStyle: { backgroundColor: palette.page }, headerTintColor: palette.ink, headerShadowVisible: false, contentStyle: { backgroundColor: palette.page } }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /><Stack.Screen name="session/[sessionId]" options={{ title: "Session", headerLargeTitle: false }} /></Stack></>;
}
