import "react-native-gesture-handler";
import { useEffect, useRef } from "react";
import { Stack, useRootNavigationState, useRouter, type Href } from "expo-router";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { Alert, Platform, Settings, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CloudProvider } from "@mobile/cloud/CloudProvider";
import { answer, intentOf } from "@mobile/notification-actions";
import { AppProvider, useApp } from "@mobile/state/AppProvider";
import { ThemeProvider, useTheme } from "@mobile/ui/theme";

/** How long a button on a notification waits for its Mac before saying it could not answer. */
const ANSWER_CONNECT_MS = 20_000;

function untilConnected(connection: { onConnected(listener: () => void): () => void }, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const off = connection.onConnected(() => { clearTimeout(timer); off(); resolve(true); });
    const timer = setTimeout(() => { off(); resolve(false); }, ms);
  });
}

export default function RootLayout() {
  return <SafeAreaProvider><ThemeProvider><AppProvider><CloudProvider><Navigation /></CloudProvider></AppProvider></ThemeProvider></SafeAreaProvider>;
}

function Navigation() {
  const { palette, name } = useTheme();
  // Light text on a dark page: Ember is dark in both appearances.
  const lightText = useColorScheme() !== "light" || name === "Ember";
  const router = useRouter();
  const app = useApp();
  const response = Notifications.useLastNotificationResponse();
  // Each response once: the hook hands the same one back after a re-render or relaunch.
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (!response || !app.ready) return;
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
    if (handled.current.has(key)) return;
    handled.current.add(key);
    const content = response.notification.request.content;
    const intent = intentOf(response.actionIdentifier, content.data ?? undefined, content.body);
    if (!intent) return;
    const open = () => router.push({ pathname: "/session/[sessionId]", params: { sessionId: intent.sessionId, tabId: intent.tabId, ...(intent.hostId ? { hostId: intent.hostId } : {}) } });
    if (intent.type === "open") {
      const host = intent.hostId ? app.hosts.find((item) => item.id === intent.hostId) : undefined;
      // The session's own Mac first, when it is another than the one connected.
      if (host && app.activeHost?.id !== host.id) void app.connectHost(host).then(open);
      else open();
      return;
    }
    // A button: answered on its Mac, then the session shows, with the Mac's refusal said if it refused.
    void answer(intent, {
      reach: async (hostId) => {
        const host = app.hosts.find((item) => item.id === hostId);
        if (!host || (app.activeHost?.id !== hostId && !(await app.connectHost(host)))) return false;
        return app.connection.transport() !== null || untilConnected(app.connection, ANSWER_CONNECT_MS);
      },
      respondPermission: (...args) => app.api.respondPermission(...args),
      answerQuestions: (...args) => app.api.answerQuestions(...args),
    }).then((refusal) => {
      open();
      if (refusal) Alert.alert("Could not answer", refusal);
    });
  }, [app, response, router]);
  // A tab to open at launch, without iOS asking first as it does for a link:
  // `xcrun simctl launch booted <bundle id> -openRoute /cloud`, for screenshots
  // and checks on a simulator. iOS keeps a launch argument for that launch only.
  // A screen inside a tab opens from that tab, as a tap would (see the Cloud tab's
  // `-openWorkspace`): one pushed from here at launch can be dropped.
  const navigationReady = Boolean(useRootNavigationState()?.key) && app.ready;
  const opened = useRef(false);
  useEffect(() => {
    if (!navigationReady || opened.current) return;
    opened.current = true;
    const route = Platform.OS === "ios" ? Settings.get("openRoute") : undefined;
    if (typeof route === "string" && route.startsWith("/")) router.navigate(route as Href);
  }, [navigationReady, router]);
  return <><StatusBar style={lightText ? "light" : "dark"} /><Stack screenOptions={{ headerLargeTitle: true, headerTransparent: false, headerStyle: { backgroundColor: palette.page }, headerTintColor: palette.ink, headerShadowVisible: false, contentStyle: { backgroundColor: palette.page } }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /><Stack.Screen name="session/[sessionId]" options={{ title: "Session", headerLargeTitle: false, headerBackTitle: "Sessions" }} /><Stack.Screen name="session/new" options={{ title: "New session", headerLargeTitle: false, headerBackTitle: "Sessions" }} /><Stack.Screen name="cloud/[workspaceId]" options={{ title: "Workspace", headerLargeTitle: false, headerBackTitle: "Cloud" }} /><Stack.Screen name="cloud/shares" options={{ title: "Sharing", headerLargeTitle: false }} /><Stack.Screen name="account" options={{ title: "Account", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="organization/[orgId]" options={{ title: "Organization", headerLargeTitle: false, headerBackTitle: "Account" }} /><Stack.Screen name="notifications" options={{ title: "Notifications", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="privacy" options={{ title: "Your data", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="connection-log" options={{ title: "Connection log", headerLargeTitle: false, headerBackTitle: "Settings" }} /></Stack></>;
}
