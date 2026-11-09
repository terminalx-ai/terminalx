import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@mobile/state/AppProvider";
import { TabBarInset, tabBarHeight } from "@mobile/ui/tab-bar-inset";
import { useTheme } from "@mobile/ui/theme";

// The system tab bar, Liquid Glass on iOS 26 and later: the tabs on the left and, set apart on the
// right where iOS sets its one special tab, a new session.
export default function TabLayout() {
  const { palette } = useTheme();
  const app = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const waiting = app.sessions.filter((session) => session.tabs.some((tab) => tab.status === "waiting")).length;
  // The bar floats over the content: a tab's last row scrolls clear of it.
  return <TabBarInset.Provider value={tabBarHeight(insets.bottom)}><NativeTabs tintColor={palette.ink} minimizeBehavior="onScrollDown">
    <NativeTabs.Trigger name="index" testID="machines-tab">
      <NativeTabs.Trigger.Icon sf={{ default: "laptopcomputer", selected: "laptopcomputer" }} />
      <NativeTabs.Trigger.Label>Machines</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="sessions" testID="sessions-tab">
      <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} />
      <NativeTabs.Trigger.Label>Sessions</NativeTabs.Trigger.Label>
      {/* No text, no badge: a hidden one still showed "0". */}
      <NativeTabs.Trigger.Badge>{waiting ? String(waiting) : undefined}</NativeTabs.Trigger.Badge>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="cloud">
      <NativeTabs.Trigger.Icon sf={{ default: "cloud", selected: "cloud.fill" }} />
      <NativeTabs.Trigger.Label>Cloud</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="settings">
      <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
      <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    {/* An action, not a tab: the bar never selects it, and pressing it opens a new session over the tabs. */}
    <NativeTabs.Trigger name="new" role="search" testID="new-session" unstable_nativeProps={{ preventNativeSelection: true }} listeners={{ tabPress: () => router.push("/session/new") }}>
      <NativeTabs.Trigger.Icon sf="plus" />
      <NativeTabs.Trigger.Label>New session</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
  </NativeTabs></TabBarInset.Provider>;
}
