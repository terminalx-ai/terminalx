import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabBarInset, tabBarHeight } from "@mobile/ui/tab-bar-inset";
import { useTheme } from "@mobile/ui/theme";

// The system tab bar, Liquid Glass on iOS 26 and later: the tabs on the left and, set apart on the
// right where iOS sets its one special tab, a new session. Outline marks throughout, the filled ones
// standing too heavy in the bar; no badge, which drew a dot even with nothing waiting.
export default function TabLayout() {
  const { palette } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // The bar floats over the content: a tab's last row scrolls clear of it.
  return <TabBarInset.Provider value={tabBarHeight(insets.bottom)}><NativeTabs tintColor={palette.ink} minimizeBehavior="onScrollDown">
    <NativeTabs.Trigger name="index" testID="machines-tab">
      <NativeTabs.Trigger.Icon sf="laptopcomputer" />
      <NativeTabs.Trigger.Label>Machines</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="sessions" testID="sessions-tab">
      <NativeTabs.Trigger.Icon sf="rectangle.stack" />
      <NativeTabs.Trigger.Label>Sessions</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="cloud">
      <NativeTabs.Trigger.Icon sf="cloud" />
      <NativeTabs.Trigger.Label>Cloud</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="settings">
      <NativeTabs.Trigger.Icon sf="gearshape" />
      <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    {/* An action, not a tab: the bar never selects it, and pressing it opens a new session over the tabs. */}
    <NativeTabs.Trigger name="new" role="search" testID="new-session" unstable_nativeProps={{ preventNativeSelection: true }} listeners={{ tabPress: () => router.push("/session/new") }}>
      <NativeTabs.Trigger.Icon sf="plus" />
      <NativeTabs.Trigger.Label>New session</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
  </NativeTabs></TabBarInset.Provider>;
}
