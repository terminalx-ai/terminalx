import "react-native-gesture-handler";
import { useEffect, useRef } from "react";
import { Stack, usePathname, useRootNavigationState, useRouter, type Href } from "expo-router";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { Alert, Platform, Settings, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ACCESS_CODE_ROUTE, accessCodeRouting } from "@mobile/auth/access-code";
import { useSettleConfirmedDeletion } from "@mobile/account/confirmed-deletion";
import { CloudProvider, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { answer, intentOf } from "@mobile/notification-actions";
import { readNativeNotificationData } from "@mobile/notifications/native-data";
import { AppProvider, useApp } from "@mobile/state/AppProvider";
import { RowActionSheetHost } from "@mobile/ui/RowActionSheetHost";
import { textSizeScreenLayout, TextSizeProvider } from "@mobile/ui/text-size";
import { ThemeProvider, useTheme } from "@mobile/ui/theme";

/** How long a button on a notification waits for its Mac before saying it could not answer. */
const ANSWER_CONNECT_MS = 20_000;

function untilConnected(connection: { onConnected(listener: () => void): () => void }, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const off = connection.onConnected(() => { clearTimeout(timer); off(); resolve(true); });
    const timer = setTimeout(() => { off(); resolve(false); }, ms);
  });
}

/**
 * A cloud setup page's bar as boards 25.02 to 25.04 draw it (PRO-567): a round
 * back button with no words beside it, which leaves the title in the middle.
 */
const SETUP_PAGE = { headerLargeTitle: false, headerBackButtonDisplayMode: "minimal" } as const;
const SETUP_PAGES = ["cloud/setup/index", "cloud/setup/organization", "cloud/setup/new-organization", "cloud/compute", "cloud/provider", "agent-logins/index", "agent-logins/[provider]"] as const;

export default function RootLayout() {
  return <SafeAreaProvider><ThemeProvider><TextSizeProvider><AppProvider><CloudProvider><Navigation /></CloudProvider></AppProvider></TextSizeProvider></ThemeProvider></SafeAreaProvider>;
}

function Navigation() {
  const { palette, name } = useTheme();
  // Light text on a dark page: Ember is dark in both appearances.
  const lightText = useColorScheme() !== "light" || name === "Ember";
  const router = useRouter();
  const app = useApp();
  const catalog = useCloudCatalog();
  // A deletion confirmed on the Delete account page and left before it was settled (PRO-584): settled from here.
  useSettleConfirmedDeletion({ api: catalog?.api ?? null, userId: app.session?.user.userId ?? null, forgetDeletedAccount: app.forgetDeletedAccount });
  const response = Notifications.useLastNotificationResponse();
  // Each response once: the hook hands the same one back after a re-render or relaunch.
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (!response || !app.ready) return;
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
    if (handled.current.has(key)) return;
    handled.current.add(key);
    const content = response.notification.request.content;
    const intent = intentOf(response.actionIdentifier, readNativeNotificationData(response.notification.request), content.body);
    if (!intent) return;
    const findHost = (id: string | null) =>
      id ? app.hosts.find((item) => item.id === id || item.relay?.relayHostId === id) : undefined;
    const matchedHost = findHost(intent.hostId);
    const resolvedHostId = matchedHost?.id ?? intent.hostId;
    const hostParam = resolvedHostId ? { hostId: resolvedHostId } : {};
    if (intent.type === "openHost") {
      if (matchedHost && app.activeHost?.id !== matchedHost.id) void app.connectHost(matchedHost);
      return;
    }
    // A bot's question (PRO-479): over the chat it came from, its home chat; on the bot's page when that is not known.
    const openBot = (sheet: boolean) => {
      if (intent.type !== "botQuestion" && intent.type !== "botAnswer") return;
      const question = sheet ? { botId: intent.botId, item: String(intent.number) } : {};
      if (intent.sessionId && intent.tabId) router.push({ pathname: "/session/[sessionId]", params: { sessionId: intent.sessionId, tabId: intent.tabId, ...hostParam, ...question } });
      else router.push({ pathname: "/bot/[botId]", params: { botId: intent.botId, ...(sheet ? { item: String(intent.number) } : {}) } });
    };
    const open = () => {
      if (intent.type === "botQuestion" || intent.type === "botAnswer") return openBot(intent.type === "botQuestion");
      router.push({ pathname: "/session/[sessionId]", params: { sessionId: intent.sessionId, tabId: intent.tabId, ...hostParam } });
    };
    if (intent.type === "open" || intent.type === "botQuestion") {
      // The session's own Mac first, when it is another than the one connected.
      if (matchedHost && app.activeHost?.id !== matchedHost.id) void app.connectHost(matchedHost).then(open);
      else open();
      return;
    }
    // A button: answered on its Mac, then the session shows, with the Mac's refusal said if it refused.
    void answer(intent, {
      reach: async (hostId) => {
        const host = findHost(hostId);
        if (!host || (app.activeHost?.id !== host.id && !(await app.connectHost(host)))) return false;
        return app.connection.transport() !== null || untilConnected(app.connection, ANSWER_CONNECT_MS);
      },
      respondPermission: (...args) => app.api.respondPermission(...args),
      answerQuestions: (...args) => app.api.answerQuestions(...args),
      answerBot: (...args) => app.api.answerBot(...args),
    }).then((refusal) => {
      // A bot's question that was not answered opens again as its sheet, to answer there.
      if (intent.type === "botAnswer") openBot(refusal !== null);
      else open();
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
  // A sign-in held at the private beta (PRO-551): its page comes up over whichever tab the person signed in
  // from, once for each hold. When the hold ends it closes: onto the Cloud tab's first run once signed in,
  // back where it came from otherwise. The page reached with no hold sends the person on too.
  const pathname = usePathname();
  const holdId = app.accessCode?.id ?? null;
  const shownFor = useRef<number | null>(null);
  useEffect(() => {
    if (!navigationReady) return;
    const routing = accessCodeRouting({ holdId, shownFor: shownFor.current, onPage: pathname === ACCESS_CODE_ROUTE, signedIn: app.session !== null, canGoBack: router.canGoBack() });
    if (holdId === null) shownFor.current = null;
    if (routing === "open") { shownFor.current = holdId; router.push(ACCESS_CODE_ROUTE); }
    else if (routing === "to-cloud") router.dismissTo("/cloud");
    else if (routing === "back") router.back();
    else if (routing === "to-tabs") router.replace("/");
  }, [app.session, holdId, navigationReady, pathname, router]);
  return <><StatusBar style={lightText ? "light" : "dark"} /><Stack screenLayout={textSizeScreenLayout} screenOptions={{ headerLargeTitle: true, headerTransparent: false, headerStyle: { backgroundColor: palette.page }, headerTintColor: palette.ink, headerShadowVisible: false, contentStyle: { backgroundColor: palette.page } }}>{/* A page opened from a tab calls its back button by this title when it names none of its own: without one it read "(tabs)", the route group (PRO-558). */}<Stack.Screen name="(tabs)" options={{ headerShown: false, title: "Back" }} />{SETUP_PAGES.map((name) => <Stack.Screen key={name} name={name} options={SETUP_PAGE} />)}<Stack.Screen name="session/[sessionId]" options={{ title: "Session", headerLargeTitle: false, headerBackTitle: "Sessions" }} /><Stack.Screen name="bot/[botId]" options={{ title: "Bot", headerShown: false }} /><Stack.Screen name="session/new" options={{ title: "New session", headerLargeTitle: false, headerBackTitle: "Sessions" }} /><Stack.Screen name="cloud/[workspaceId]" options={{ title: "Workspace", headerLargeTitle: false, headerBackTitle: "Cloud" }} /><Stack.Screen name="cloud/shares" options={{ title: "Sharing", headerLargeTitle: false }} /><Stack.Screen name="account" options={{ title: "Account", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="delete-account" options={{ title: "Delete account", headerLargeTitle: false, headerBackTitle: "Account" }} /><Stack.Screen name="organization/[orgId]" options={{ title: "Organization", headerLargeTitle: false, headerBackTitle: "Account" }} /><Stack.Screen name="notifications" options={{ title: "Notifications", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="privacy" options={{ title: "Your data", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="connection-log" options={{ title: "Connection log", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="support-report" options={{ title: "Support report", headerLargeTitle: false, headerBackTitle: "Settings" }} /><Stack.Screen name="access-code" options={{ title: "Access code", headerLargeTitle: false, presentation: "fullScreenModal", gestureEnabled: false }} /></Stack><RowActionSheetHost /></>;
}
