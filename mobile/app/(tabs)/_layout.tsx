import { Tabs, useRouter } from "expo-router";
import { useApp } from "@mobile/state/AppProvider";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloatingTabBar } from "@mobile/ui/FloatingTabBar";
import { TabBarInset, tabBarHeight } from "@mobile/ui/tab-bar-inset";
import { useTheme } from "@mobile/ui/theme";

// Tabs on the left in a Liquid Glass pill, and a new session on the right.
export default function TabLayout() {
  const { palette } = useTheme();
  const app = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const waiting = app.sessions.some((session) => session.tabs.some((tab) => tab.status === "waiting"));
  return <TabBarInset.Provider value={tabBarHeight(insets.bottom)}><Tabs
    screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: palette.page } }}
    tabBar={(props) => <FloatingTabBar state={props.state} navigation={props.navigation} dotted={waiting ? ["sessions"] : []} onNew={() => router.push("/session/new")} />}
  >
    <Tabs.Screen name="index" />
    <Tabs.Screen name="sessions" />
    <Tabs.Screen name="cloud" />
    <Tabs.Screen name="settings" />
  </Tabs></TabBarInset.Provider>;
}
