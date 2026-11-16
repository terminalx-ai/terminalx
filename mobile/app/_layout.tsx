import "react-native-gesture-handler";
import { useEffect, useRef } from "react";
import { Stack, useRootNavigationState, useRouter, type Href } from "expo-router";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { Platform, Settings, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CloudProvider } from "@mobile/cloud/CloudProvider";
import { AppProvider, useApp } from "@mobile/state/AppProvider";
import { ThemeProvider, useTheme } from "@mobile/ui/theme";

export default function RootLayout() {
  return <SafeAreaProvider><ThemeProvider><AppProvider><CloudProvider><Navigation /></CloudProvider></AppProvider></ThemeProvider></SafeAreaProvider>;
}

function Navigation() {
  const { palette, name } = useTheme();
  // Light text on a dark page: Ember is dark in both appearances.
  const lightText = useColorScheme() !== "light" || name === "Ember";
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const sessionId = response?.notification.request.content.data?.sessionId;
    const tabId = response?.notification.request.content.data?.tabId;
    if (typeof sessionId === "string" && sessionId && typeof tabId === "string" && tabId) router.push({ pathname: "/session/[sessionId]", params: { sessionId, tabId } });
  }, [response, router]);
  // A tab to open at launch, without iOS asking first as it does for a link:
  // `xcrun simctl launch booted <bundle id> -openRoute /cloud`, for screenshots
  // and checks on a simulator. iOS keeps a launch argument for that launch only.
  // A screen inside a tab opens from that tab, as a tap would (see the Cloud tab's
  // `-openWorkspace`): one pushed from here at launch can be dropped.
  const appReady = useApp().ready;
  const navigationReady = Boolean(useRootNavigationState()?.key) && appReady;
  const opened = useRef(false);
  useEffect(() => {
    if (!navigationReady || opened.current) return;
    opened.current = true;
    const route = Platform.OS === "ios" ? Settings.get("openRoute") : undefined;
    if (typeof route === "string" && route.startsWith("/")) router.navigate(route as Href);
  }, [navigationReady, router]);
  return <><StatusBar style={lightText ? "light" : "dark"} /><Stack screenOptions={{ headerLargeTitle: true, headerTransparent: false, headerStyle: { backgroundColor: palette.page }, headerTintColor: palette.ink, headerShadowVisible: false, contentStyle: { backgroundColor: palette.page } }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /><Stack.Screen name="session/[sessionId]" options={{ title: "Session", headerLargeTitle: false, headerBackTitle: "Sessions" }} /><Stack.Screen name="session/new" options={{ title: "New session", headerLargeTitle: false, headerBackTitle: "Sessions" }} /><Stack.Screen name="cloud/[workspaceId]" options={{ title: "Workspace", headerLargeTitle: false, headerBackTitle: "Cloud" }} /><Stack.Screen name="cloud/shares" options={{ title: "Sharing", headerLargeTitle: false }} /><Stack.Screen name="account" options={{ title: "Account", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="privacy" options={{ title: "Your data", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="connection-log" options={{ title: "Connection log", headerLargeTitle: false, headerBackTitle: "Settings" }} /></Stack></>;
}

