import "react-native-gesture-handler";
import { useEffect, useRef } from "react";
import { Stack, useRootNavigationState, useRouter, type Href } from "expo-router";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { Platform, Settings, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CloudProvider } from "@mobile/cloud/CloudProvider";
import { AppProvider } from "@mobile/state/AppProvider";
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
  // A screen to open at launch, as a link would but without iOS asking first:
  // `xcrun simctl launch booted <bundle id> -openRoute /cloud`, for screenshots
  // and checks on a simulator. iOS keeps a launch argument for that launch only.
  // It waits for the navigator, or a pushed workspace is lost and only its tab is shown.
  const navigationReady = Boolean(useRootNavigationState()?.key);
  const opened = useRef(false);
  useEffect(() => {
    if (!navigationReady || opened.current) return;
    opened.current = true;
    const route = Platform.OS === "ios" ? Settings.get("openRoute") : undefined;
    if (typeof route === "string" && route.startsWith("/")) router.push(route as Href);
  }, [navigationReady, router]);
  return <><StatusBar style={lightText ? "light" : "dark"} /><Stack screenOptions={{ headerLargeTitle: true, headerTransparent: false, headerStyle: { backgroundColor: palette.page }, headerTintColor: palette.ink, headerShadowVisible: false, contentStyle: { backgroundColor: palette.page } }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /><Stack.Screen name="session/[sessionId]" options={{ title: "Session", headerLargeTitle: false, headerBackTitle: "Sessions" }} /><Stack.Screen name="session/new" options={{ title: "New session", headerLargeTitle: false, headerBackTitle: "Sessions" }} /><Stack.Screen name="cloud/[workspaceId]" options={{ title: "Workspace", headerLargeTitle: false, headerBackTitle: "Cloud" }} /><Stack.Screen name="cloud/shares" options={{ title: "Sharing", headerLargeTitle: false }} /></Stack></>;
}
